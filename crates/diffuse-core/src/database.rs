use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{Connection, ErrorCode, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::{Value, json};

use crate::attention::validate_entity_revision;
use crate::{
    AttentionItem, AttentionKind, AttentionMutationResult, AttentionStatus, CoreError, CoreResult,
    CreateAttentionRequest, CreateInputRequest, InputMutationResult, InputRequest,
    InputRequestKind, InputRequestStatus, InputResponse, MutationOutcome,
    WorkspaceAttentionSummary, WorkspaceGeneration, WorkspaceId, WorkspaceNavigationTarget,
    WorkspaceUiStateMutationResult, WorkspaceUiStateRecord,
};

pub const DEFAULT_DATABASE_FILE_NAME: &str = "workbench.sqlite3";
const CURRENT_SCHEMA_VERSION: i64 = 7;

pub(crate) struct AcpCommit {
    pub activity: crate::acp::SessionActivity,
    pub turns: Vec<crate::acp::QueuedTurn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestorableWorkspace {
    pub id: WorkspaceId,
    pub root: String,
    pub display_name: String,
    pub active: bool,
}

pub(crate) struct OpenedWorkspace {
    pub id: WorkspaceId,
    pub was_open: bool,
}

pub(crate) struct ClosedWorkspace {
    pub forced_inputs: Vec<InputMutationResult>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyReviewImportReport {
    pub workspace_id: WorkspaceId,
    pub imported: u64,
    pub already_imported: u64,
    pub diagnostics: u64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LegacyImportedArtifact {
    Run {
        workspace_id: WorkspaceId,
        session_id: String,
        entity_id: String,
        source_path: String,
        content_hash: String,
        document: Value,
    },
    Agent {
        workspace_id: WorkspaceId,
        session_id: String,
        entity_id: String,
        source_path: String,
        content_hash: String,
        document: Value,
    },
    Chat {
        workspace_id: WorkspaceId,
        session_id: String,
        entity_id: String,
        source_path: String,
        content_hash: String,
        document: Value,
    },
    Prompt {
        workspace_id: WorkspaceId,
        session_id: String,
        entity_id: String,
        source_path: String,
        content_hash: String,
        text: String,
    },
}

pub(crate) struct LegacyImportRecord<'a> {
    pub session_id: &'a str,
    pub artifact_kind: &'a str,
    pub relative_path: &'a str,
    pub entity_id: Option<&'a str>,
    pub content_hash: Option<&'a str>,
    pub payload: Option<&'a str>,
    pub diagnostic: Option<&'a str>,
}

#[derive(Clone)]
pub struct WorkbenchDatabase {
    connection: Arc<Mutex<Connection>>,
    _lock: Arc<File>,
}

impl WorkbenchDatabase {
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        loop {
            let lock = open_database_lock(path)?;
            FileExt::lock_shared(&lock)?;
            match Self::open_once(path, lock) {
                Ok(database) => return Ok(database),
                Err((error, lock)) if is_corrupt_database(&error) => {
                    FileExt::unlock(&lock)?;
                    drop(lock);
                    let recovery_lock = open_database_lock(path)?;
                    FileExt::try_lock_exclusive(&recovery_lock)?;

                    // Another process may have recovered the file before this lock was acquired.
                    match Self::open_once(path, recovery_lock) {
                        Ok(database) => {
                            let recovery_lock = database.into_lock();
                            FileExt::unlock(&recovery_lock)?;
                        }
                        Err((recheck_error, recovery_lock))
                            if is_corrupt_database(&recheck_error) =>
                        {
                            move_corrupt_database(path)?;
                            let database =
                                Self::open_once(path, recovery_lock).map_err(|(error, _)| error)?;
                            let recovery_lock = database.into_lock();
                            FileExt::unlock(&recovery_lock)?;
                        }
                        Err((recheck_error, _)) => return Err(recheck_error),
                    }
                }
                Err((error, _)) => return Err(error),
            }
        }
    }

    fn open_once(path: &Path, lock: File) -> Result<Self, (CoreError, File)> {
        let connection = match Connection::open(path) {
            Ok(connection) => connection,
            Err(error) => return Err((error.into(), lock)),
        };
        if let Err(error) = Self::configure(&connection, true) {
            return Err((error, lock));
        }
        let database = Self {
            connection: Arc::new(Mutex::new(connection)),
            _lock: Arc::new(lock),
        };
        if let Err(error) = database.migrate() {
            return Err((error, database.into_lock()));
        }
        match database.validate_integrity() {
            Ok(()) => Ok(database),
            Err(error) => Err((error, database.into_lock())),
        }
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        let connection = Connection::open_in_memory()?;
        Self::configure(&connection, false)?;
        let lock = OpenOptions::new().read(true).open(null_device())?;
        let database = Self {
            connection: Arc::new(Mutex::new(connection)),
            _lock: Arc::new(lock),
        };
        database.migrate()?;
        database.validate_integrity()?;
        Ok(database)
    }

    fn configure(connection: &Connection, persistent: bool) -> CoreResult<()> {
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        if persistent {
            connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        }
        Ok(())
    }

    fn into_lock(self) -> File {
        let Self { connection, _lock } = self;
        drop(connection);
        Arc::try_unwrap(_lock).expect("database lock handle unexpectedly shared")
    }

    fn migrate(&self) -> CoreResult<()> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )?;
        let version = transaction
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, Option<i64>>(0)
            })?
            .unwrap_or(0);
        if version > CURRENT_SCHEMA_VERSION {
            return Err(CoreError::UnsupportedDatabaseVersion(version));
        }

        if version < 1 {
            transaction.execute_batch(
                "CREATE TABLE workspaces (
                    id TEXT PRIMARY KEY,
                    canonical_root TEXT NOT NULL UNIQUE,
                    root TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    rail_order INTEGER NOT NULL,
                    last_opened_at INTEGER NOT NULL,
                    is_open INTEGER NOT NULL DEFAULT 0,
                    generation TEXT,
                    load_state TEXT NOT NULL DEFAULT 'closed'
                );
                CREATE TABLE app_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL
                );
                INSERT INTO app_state(singleton, active_workspace_id) VALUES (1, NULL);
                CREATE TABLE workspace_ui_state (
                    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
                    version INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_sessions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    review_session_id TEXT,
                    adapter TEXT NOT NULL,
                    authentication_profile TEXT,
                    remote_session_id TEXT,
                    capabilities_json TEXT NOT NULL DEFAULT '{}',
                    state TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX agent_sessions_workspace_idx ON agent_sessions(workspace_id, updated_at);
                CREATE TABLE input_requests (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX input_requests_workspace_idx ON input_requests(workspace_id, status, updated_at);
                CREATE TABLE attention_items (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    source_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    target_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(workspace_id, source_id, kind)
                );
                CREATE INDEX attention_items_workspace_idx ON attention_items(workspace_id, status, updated_at);",
            )?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![1, now_millis()],
            )?;
        }

        if version < 2 {
            transaction.execute_batch(
                "ALTER TABLE attention_items ADD COLUMN acknowledged_revision INTEGER;
                 ALTER TABLE attention_items ADD COLUMN notified_revision INTEGER;
                 ALTER TABLE attention_items ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';
                 UPDATE attention_items SET lifecycle = CASE status
                    WHEN 'resolved' THEN 'resolved'
                    WHEN 'expired' THEN 'expired'
                    WHEN 'superseded' THEN 'superseded'
                    ELSE 'active'
                 END;
                 UPDATE attention_items SET acknowledged_revision = revision
                    WHERE status = 'acknowledged';
                  ALTER TABLE workspace_ui_state ADD COLUMN revision INTEGER;
                  UPDATE workspace_ui_state SET revision = version WHERE revision IS NULL;
                  ALTER TABLE input_requests ADD COLUMN attention_id TEXT;
                  CREATE TABLE attention_item_quarantine (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    diagnostic TEXT NOT NULL,
                    quarantined_at INTEGER NOT NULL
                  );
                  INSERT INTO attention_item_quarantine(id, workspace_id, raw_json, diagnostic, quarantined_at)
                  SELECT id, workspace_id,
                    json_object('id', id, 'sourceId', source_id, 'kind', kind,
                      'revision', revision, 'status', status, 'targetJson', target_json),
                    'invalid pre-v2 attention row', unixepoch('subsec') * 1000
                  FROM attention_items
                  WHERE id = '' OR length(id) > 512 OR source_id = '' OR length(source_id) > 512
                    OR kind NOT IN ('input', 'error', 'completion')
                    OR status NOT IN ('unread', 'acknowledged', 'resolved', 'expired', 'superseded')
                    OR revision <= 0 OR revision > 9007199254740991 OR NOT json_valid(target_json)
                    OR COALESCE(json_extract(target_json, '$.kind'), json_extract(target_json, '$.type'), '')
                      NOT IN ('input', 'review', 'agent', 'settings', 'workspace')
                    OR (COALESCE(json_extract(target_json, '$.kind'), json_extract(target_json, '$.type')) = 'input'
                      AND (json_type(target_json, '$.inputRequestId') IS NOT 'text' OR json_extract(target_json, '$.inputRequestId') = ''))
                    OR (COALESCE(json_extract(target_json, '$.kind'), json_extract(target_json, '$.type')) = 'agent'
                      AND (json_type(target_json, '$.agentSessionId') IS NOT 'text' OR json_extract(target_json, '$.agentSessionId') = ''));
                  DELETE FROM attention_items WHERE id IN (SELECT id FROM attention_item_quarantine);
                  CREATE TABLE input_request_quarantine (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_json TEXT,
                    diagnostic TEXT NOT NULL,
                    quarantined_at INTEGER NOT NULL
                  );
                  UPDATE input_requests SET attention_id = json_extract(request_json, '$.attentionId')
                  WHERE json_valid(request_json)
                    AND json_type(request_json, '$.attentionId') = 'text';
                  INSERT INTO input_request_quarantine(
                    id, workspace_id, request_json, response_json, diagnostic, quarantined_at
                  )
                  SELECT i.id, i.workspace_id, i.request_json, i.response_json,
                    'invalid or unlinked pre-v2 input row', unixepoch('subsec') * 1000
                  FROM input_requests i
                  WHERE i.id = '' OR length(i.id) > 512
                    OR i.revision <= 0 OR i.revision > 9007199254740991
                    OR i.kind NOT IN ('permission', 'question', 'authentication', 'conflict')
                    OR i.status NOT IN ('pending', 'response-submitted', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')
                    OR NOT json_valid(i.request_json)
                    OR json_type(i.request_json, '$.prompt') IS NOT 'text'
                    OR json_extract(i.request_json, '$.prompt') = ''
                    OR json_type(i.request_json, '$.choices') IS NOT 'array'
                    OR COALESCE(json_type(i.request_json, '$.cancellationSupported'), '') NOT IN ('true', 'false')
                    OR (i.response_json IS NOT NULL AND NOT json_valid(i.response_json))
                    OR i.attention_id IS NULL OR i.attention_id = '' OR length(i.attention_id) > 512
                    OR NOT EXISTS (
                      SELECT 1 FROM attention_items a
                      WHERE a.id = i.attention_id AND a.workspace_id = i.workspace_id
                    );
                  DELETE FROM input_requests WHERE id IN (SELECT id FROM input_request_quarantine);
                  CREATE UNIQUE INDEX input_requests_attention_idx ON input_requests(attention_id);
                  CREATE TABLE workspace_ui_state_quarantine (
                    workspace_id TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    diagnostic TEXT NOT NULL,
                    quarantined_at INTEGER NOT NULL
                  );
                  INSERT INTO workspace_ui_state_quarantine(
                    workspace_id, version, state_json, diagnostic, quarantined_at
                  )
                  SELECT workspace_id, version, state_json, 'invalid pre-v2 UI state row',
                    unixepoch('subsec') * 1000
                  FROM workspace_ui_state
                  WHERE revision IS NULL OR revision <= 0 OR revision > 9007199254740991
                    OR NOT json_valid(state_json);
                  DELETE FROM workspace_ui_state
                    WHERE workspace_id IN (SELECT workspace_id FROM workspace_ui_state_quarantine);
                  CREATE TABLE legacy_review_import_ledger (
                    stable_key TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    artifact_kind TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    entity_id TEXT,
                    content_hash TEXT,
                    status TEXT NOT NULL CHECK(status IN ('imported', 'diagnostic')),
                    diagnostic TEXT,
                    imported_at INTEGER NOT NULL,
                    CHECK(length(stable_key) BETWEEN 1 AND 1024),
                    CHECK(length(session_id) BETWEEN 1 AND 512),
                    CHECK(artifact_kind IN ('run', 'agent', 'chat', 'prompt')),
                    CHECK(length(relative_path) BETWEEN 1 AND 4096),
                    CHECK(entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 512),
                    CHECK((status = 'imported' AND entity_id IS NOT NULL AND content_hash IS NOT NULL AND diagnostic IS NULL)
                       OR (status = 'diagnostic' AND diagnostic IS NOT NULL)),
                    UNIQUE(workspace_id, session_id, artifact_kind, relative_path)
                  );
                  CREATE INDEX legacy_review_import_workspace_idx
                    ON legacy_review_import_ledger(workspace_id, imported_at);
                  CREATE TABLE legacy_import_runs (
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
                    entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 512),
                    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
                    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
                    document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(document_json) <= 8388608),
                    imported_at INTEGER NOT NULL,
                    PRIMARY KEY(workspace_id, session_id, entity_id),
                    UNIQUE(workspace_id, session_id, source_path)
                  );
                  CREATE TABLE legacy_import_agents (
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
                    entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 512),
                    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
                    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
                    document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(document_json) <= 8388608),
                    imported_at INTEGER NOT NULL,
                    PRIMARY KEY(workspace_id, session_id, entity_id),
                    UNIQUE(workspace_id, session_id, source_path)
                  );
                  CREATE TABLE legacy_import_chats (
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
                    entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 512),
                    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
                    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
                    document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(document_json) <= 8388608),
                    imported_at INTEGER NOT NULL,
                    PRIMARY KEY(workspace_id, session_id, entity_id),
                    UNIQUE(workspace_id, session_id, source_path)
                  );
                  CREATE TABLE legacy_import_prompts (
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
                    entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 512),
                    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
                    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
                    prompt_text TEXT NOT NULL CHECK(length(prompt_text) <= 1048576),
                    imported_at INTEGER NOT NULL,
                    PRIMARY KEY(workspace_id, session_id, entity_id),
                    UNIQUE(workspace_id, session_id, source_path)
                  );
                  CREATE TRIGGER attention_items_v2_insert BEFORE INSERT ON attention_items BEGIN
                    SELECT CASE WHEN NEW.id = '' OR length(NEW.id) > 512
                      OR NEW.source_id = '' OR length(NEW.source_id) > 512
                      OR NEW.kind NOT IN ('input', 'error', 'completion')
                      OR NEW.status NOT IN ('unread', 'acknowledged', 'resolved', 'expired', 'superseded')
                      OR NEW.lifecycle NOT IN ('active', 'resolved', 'expired', 'superseded')
                      OR NEW.revision <= 0 OR NEW.revision > 9007199254740991
                      OR (NEW.acknowledged_revision IS NOT NULL AND
                        (NEW.acknowledged_revision <= 0 OR NEW.acknowledged_revision > 9007199254740991))
                      OR (NEW.notified_revision IS NOT NULL AND
                        (NEW.notified_revision <= 0 OR NEW.notified_revision > 9007199254740991))
                      OR NOT json_valid(NEW.target_json)
                      THEN RAISE(ABORT, 'invalid attention item') END;
                  END;
                  CREATE TRIGGER attention_items_v2_update BEFORE UPDATE ON attention_items BEGIN
                    SELECT CASE WHEN NEW.id = '' OR length(NEW.id) > 512
                      OR NEW.source_id = '' OR length(NEW.source_id) > 512
                      OR NEW.kind NOT IN ('input', 'error', 'completion')
                      OR NEW.status NOT IN ('unread', 'acknowledged', 'resolved', 'expired', 'superseded')
                      OR NEW.lifecycle NOT IN ('active', 'resolved', 'expired', 'superseded')
                      OR NEW.revision <= 0 OR NEW.revision > 9007199254740991
                      OR (NEW.acknowledged_revision IS NOT NULL AND
                        (NEW.acknowledged_revision <= 0 OR NEW.acknowledged_revision > 9007199254740991))
                      OR (NEW.notified_revision IS NOT NULL AND
                        (NEW.notified_revision <= 0 OR NEW.notified_revision > 9007199254740991))
                      OR NOT json_valid(NEW.target_json)
                      THEN RAISE(ABORT, 'invalid attention item') END;
                  END;
                  CREATE TRIGGER input_requests_v2_insert BEFORE INSERT ON input_requests BEGIN
                    SELECT CASE WHEN NEW.id = '' OR length(NEW.id) > 512
                      OR NEW.revision <= 0 OR NEW.revision > 9007199254740991
                      OR NEW.kind NOT IN ('permission', 'question', 'authentication', 'conflict')
                      OR NEW.status NOT IN ('pending', 'response-submitted', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')
                      OR NOT json_valid(NEW.request_json)
                      OR (NEW.response_json IS NOT NULL AND NOT json_valid(NEW.response_json))
                      OR NEW.attention_id IS NULL OR NEW.attention_id = '' OR length(NEW.attention_id) > 512
                      OR NOT EXISTS (SELECT 1 FROM attention_items a WHERE a.id = NEW.attention_id AND a.workspace_id = NEW.workspace_id)
                      THEN RAISE(ABORT, 'invalid input request') END;
                  END;
                  CREATE TRIGGER input_requests_v2_update BEFORE UPDATE ON input_requests BEGIN
                    SELECT CASE WHEN NEW.id = '' OR length(NEW.id) > 512
                      OR NEW.revision <= 0 OR NEW.revision > 9007199254740991
                      OR NEW.kind NOT IN ('permission', 'question', 'authentication', 'conflict')
                      OR NEW.status NOT IN ('pending', 'response-submitted', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')
                      OR NOT json_valid(NEW.request_json)
                      OR (NEW.response_json IS NOT NULL AND NOT json_valid(NEW.response_json))
                      OR NEW.attention_id IS NULL OR NEW.attention_id = '' OR length(NEW.attention_id) > 512
                      OR NOT EXISTS (SELECT 1 FROM attention_items a WHERE a.id = NEW.attention_id AND a.workspace_id = NEW.workspace_id)
                      THEN RAISE(ABORT, 'invalid input request') END;
                  END;
                  CREATE TRIGGER workspace_ui_state_v2_insert BEFORE INSERT ON workspace_ui_state BEGIN
                    SELECT CASE WHEN NEW.revision <= 0 OR NEW.revision > 9007199254740991 OR NOT json_valid(NEW.state_json)
                      THEN RAISE(ABORT, 'invalid workspace ui state') END;
                  END;
                  CREATE TRIGGER workspace_ui_state_v2_update BEFORE UPDATE ON workspace_ui_state BEGIN
                    SELECT CASE WHEN NEW.revision <= 0 OR NEW.revision > 9007199254740991 OR NOT json_valid(NEW.state_json)
                      THEN RAISE(ABORT, 'invalid workspace ui state') END;
                  END;
                  WITH ordered AS (
                    SELECT id, row_number() OVER (ORDER BY rail_order, id) - 1 AS new_order
                    FROM workspaces WHERE is_open = 1
                  )
                  UPDATE workspaces SET rail_order = (SELECT new_order FROM ordered WHERE ordered.id = workspaces.id)
                  WHERE is_open = 1;
                  CREATE UNIQUE INDEX workspaces_open_rail_order_idx
                    ON workspaces(rail_order) WHERE is_open = 1;
                  INSERT INTO schema_migrations(version, applied_at) VALUES (2, unixepoch('subsec') * 1000);",
            )?;
        }

        if version < 3 {
            transaction.execute_batch(
                "CREATE TABLE acp_sessions (
                    id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
                    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
                );
                CREATE TABLE acp_activity (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
                    turn_id TEXT,
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX acp_activity_session_idx ON acp_activity(session_id, sequence);
                INSERT INTO schema_migrations(version, applied_at) VALUES (3, unixepoch('subsec') * 1000);",
            )?;
        }
        if version < 4 {
            transaction.execute_batch("CREATE TABLE acp_adapters(id TEXT PRIMARY KEY, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)));
                CREATE TABLE acp_turns(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,request_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,stop_reason TEXT,UNIQUE(session_id,request_id));
                CREATE INDEX acp_turns_queue_idx ON acp_turns(session_id,state,ordinal);
                CREATE TABLE acp_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,turn_id TEXT,kind TEXT NOT NULL,content_json TEXT NOT NULL CHECK(json_valid(content_json)));
                CREATE TABLE acp_input_delivery(input_id TEXT PRIMARY KEY REFERENCES input_requests(id) ON DELETE CASCADE,state TEXT NOT NULL);
                CREATE TABLE acp_replay_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,kind TEXT NOT NULL,content_json TEXT NOT NULL CHECK(json_valid(content_json)));
                CREATE INDEX acp_history_session_idx ON acp_history(session_id,sequence);
                INSERT INTO acp_history(session_id,turn_id,kind,content_json)
                SELECT session_id,turn_id,
                  CASE WHEN kind='turn-started' THEN 'user-message'
                    WHEN json_extract(payload_json,'$.sessionUpdate')='agent_message_chunk' THEN 'agent-message'
                    WHEN json_extract(payload_json,'$.sessionUpdate')='user_message_chunk' THEN 'user-message'
                    WHEN json_extract(payload_json,'$.sessionUpdate') IN ('tool_call','tool_call_update') THEN 'tool-call'
                    WHEN json_extract(payload_json,'$.sessionUpdate')='plan' THEN 'plan'
                    WHEN json_extract(payload_json,'$.sessionUpdate')='current_mode_update' THEN 'mode'
                    ELSE 'activity' END,
                  CASE WHEN kind='session-update' AND json_extract(payload_json,'$.sessionUpdate')='plan' THEN COALESCE(json_extract(payload_json,'$.entries'),'[]')
                    WHEN kind='session-update' AND json_extract(payload_json,'$.sessionUpdate')='current_mode_update' THEN json_object('modeId',json_extract(payload_json,'$.currentModeId'))
                    ELSE payload_json END
                FROM acp_activity WHERE kind='turn-started' OR (kind='session-update' AND COALESCE(json_extract(payload_json,'$.sessionUpdate'),'')!='agent_thought_chunk') ORDER BY sequence;
                INSERT OR IGNORE INTO acp_turns(id,session_id,request_id,text,state,stop_reason)
                  SELECT turn_id,session_id,turn_id,COALESCE(json_extract(payload_json,'$.text'),''),'failed','historical-interruption'
                  FROM acp_activity WHERE kind='turn-started' AND turn_id IS NOT NULL ORDER BY sequence;
                UPDATE acp_turns SET stop_reason=(SELECT json_extract(a.payload_json,'$.stopReason') FROM acp_activity a WHERE a.turn_id=acp_turns.id AND a.kind='turn-ended' ORDER BY a.sequence DESC LIMIT 1)
                  WHERE EXISTS(SELECT 1 FROM acp_activity a WHERE a.turn_id=acp_turns.id AND a.kind='turn-ended');
                UPDATE acp_turns SET state=CASE WHEN stop_reason='cancelled' THEN 'cancelled' ELSE 'completed' END WHERE stop_reason!='historical-interruption';
                INSERT INTO schema_migrations(version,applied_at) VALUES(4,unixepoch('subsec')*1000);")?;
        }
        if version < 5 {
            transaction.execute_batch("CREATE TABLE acp_session_incarnations(session_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,generation TEXT NOT NULL,token TEXT NOT NULL);
                INSERT INTO schema_migrations(version,applied_at) VALUES(5,unixepoch('subsec')*1000);")?;
        }
        if version < 6 {
            // Older cores must not silently discard a persisted authorization
            // scope when deserializing and reconnecting an agent session.
            transaction.execute_batch("INSERT INTO schema_migrations(version,applied_at) VALUES(6,unixepoch('subsec')*1000);")?;
        }
        if version < 7 {
            // Pre-v7 changed-file IDs could contain Git's display quoting.
            // Do not reinterpret an existing delegated scope as permission to
            // access a different file whose literal name equals that display.
            transaction.execute_batch("CREATE TABLE acp_legacy_quoted_scopes(session_id TEXT PRIMARY KEY REFERENCES acp_sessions(id) ON DELETE CASCADE);
                INSERT INTO acp_legacy_quoted_scopes(session_id)
                  SELECT DISTINCT a.id FROM acp_sessions a, json_each(a.snapshot_json,'$.reviewFileIds') f
                  WHERE f.type='text' AND substr(f.value,1,1)='\"';
                INSERT INTO schema_migrations(version,applied_at) VALUES(7,unixepoch('subsec')*1000);")?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn claim_acp_session(
        &self,
        id: &str,
        workspace: WorkspaceId,
        generation: WorkspaceGeneration,
        token: &str,
    ) -> CoreResult<()> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?1 AND generation=?2 AND is_open=1)",
            params![workspace.to_string(), generation.to_string()],
            |r| r.get(0),
        )?;
        if !current {
            return Err(CoreError::StaleWorkspaceGeneration);
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT workspace_id FROM agent_sessions WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if owner.is_some_and(|owner| owner != workspace.to_string()) {
            return Err(CoreError::WorkspaceNotFound);
        }
        tx.execute("INSERT INTO acp_session_incarnations VALUES(?1,?2,?3,?4) ON CONFLICT(session_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=excluded.generation,token=excluded.token",params![id,workspace.to_string(),generation.to_string(),token])?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn save_acp_adapter(
        &self,
        definition: &crate::acp::AdapterDefinition,
    ) -> CoreResult<()> {
        definition.validate()?;
        self.connection.lock().expect("database lock poisoned").execute("INSERT INTO acp_adapters VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json", params![definition.id, serde_json::to_string(definition).map_err(|e| CoreError::Serialization(e.to_string()))?])?;
        Ok(())
    }

    pub(crate) fn acp_adapters(&self) -> CoreResult<Vec<crate::acp::AdapterDefinition>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut query =
            connection.prepare("SELECT definition_json FROM acp_adapters ORDER BY id")?;
        query
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str(&r?).map_err(|e| CoreError::Serialization(e.to_string())))
            .collect()
    }

    pub(crate) fn queue_acp_turn(
        &self,
        workspace: WorkspaceId,
        session: &str,
        request: &str,
        text: &str,
    ) -> CoreResult<crate::acp::QueuedTurn> {
        if request.is_empty()
            || request.len() > 256
            || text.len() > crate::acp::MAX_MESSAGE_BYTES / 8
        {
            return Err(CoreError::InvalidParams("invalid ACP prompt".into()));
        }
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id=?1 AND workspace_id=?2)",
            params![session, workspace.to_string()],
            |r| r.get(0),
        )?;
        if !owned {
            return Err(CoreError::InvalidParams("unknown ACP session".into()));
        }
        let existing: Option<(String,String,String,Option<String>)> = tx.query_row("SELECT id,text,state,stop_reason FROM acp_turns WHERE session_id=?1 AND request_id=?2",params![session,request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((id, old, state, stop_reason)) = existing {
            if old != text {
                return Err(CoreError::InvalidParams(
                    "requestId reused with different prompt".into(),
                ));
            }
            return Ok(crate::acp::QueuedTurn {
                id,
                session_id: session.into(),
                request_id: request.into(),
                text: old,
                state,
                stop_reason,
            });
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM acp_turns WHERE session_id=?1 AND state='queued'",
            [session],
            |r| r.get(0),
        )?;
        if count >= 64 {
            return Err(CoreError::InvalidParams("ACP prompt queue is full".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO acp_turns(id,session_id,request_id,text,state) VALUES(?1,?2,?3,?4,'queued')",params![id,session,request,text])?;
        tx.commit()?;
        Ok(crate::acp::QueuedTurn {
            id,
            session_id: session.into(),
            request_id: request.into(),
            text: text.into(),
            state: "queued".into(),
            stop_reason: None,
        })
    }

    pub(crate) fn next_acp_turn(
        &self,
        session: &str,
        incarnation: &str,
    ) -> CoreResult<Option<crate::acp::QueuedTurn>> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM acp_session_incarnations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.session_id=?1 AND i.token=?2 AND w.generation=i.generation AND w.is_open=1)",params![session,incarnation],|r|r.get(0))?;
        if !current {
            return Err(CoreError::TaskFailed(
                "Stale ACP session incarnation".into(),
            ));
        }
        let turn = tx.query_row("SELECT id,request_id,text FROM acp_turns WHERE session_id=?1 AND state='queued' ORDER BY ordinal LIMIT 1",[session],|r|Ok(crate::acp::QueuedTurn { id:r.get(0)?,session_id:session.into(),request_id:r.get(1)?,text:r.get(2)?,state:"admitted".into(),stop_reason:None })).optional()?;
        if let Some(turn) = &turn {
            tx.execute(
                "UPDATE acp_turns SET state='admitted' WHERE id=?1",
                [&turn.id],
            )?;
        }
        tx.commit()?;
        Ok(turn)
    }

    pub(crate) fn acp_turns(
        &self,
        workspace: WorkspaceId,
        session: &str,
    ) -> CoreResult<Vec<crate::acp::QueuedTurn>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut query = connection.prepare("SELECT t.id,t.request_id,t.text,t.state,t.stop_reason FROM acp_turns t JOIN agent_sessions s ON s.id=t.session_id WHERE s.workspace_id=?1 AND t.session_id=?2 ORDER BY ordinal DESC LIMIT 100")?;
        query
            .query_map(params![workspace.to_string(), session], |r| {
                Ok(crate::acp::QueuedTurn {
                    id: r.get(0)?,
                    session_id: session.into(),
                    request_id: r.get(1)?,
                    text: r.get(2)?,
                    state: r.get(3)?,
                    stop_reason: r.get(4)?,
                })
            })?
            .map(|r| r.map_err(Into::into))
            .collect()
    }

    pub(crate) fn cancel_queued_acp_turn(
        &self,
        workspace: WorkspaceId,
        session: &str,
        turn: &str,
    ) -> CoreResult<bool> {
        Ok(self.connection.lock().expect("database lock poisoned").execute("UPDATE acp_turns SET state='cancelled',stop_reason='cancelled' WHERE id=?1 AND session_id=?2 AND state='queued' AND EXISTS(SELECT 1 FROM agent_sessions WHERE id=?2 AND workspace_id=?3)",params![turn,session,workspace.to_string()])? == 1)
    }

    pub(crate) fn acp_history(
        &self,
        workspace: WorkspaceId,
        session: &str,
        after: u64,
    ) -> CoreResult<Vec<crate::acp::HistoryEntry>> {
        let after = i64::try_from(after)
            .map_err(|_| CoreError::InvalidParams("invalid history cursor".into()))?;
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut query = connection.prepare("SELECT h.sequence,h.turn_id,h.kind,h.content_json FROM acp_history h JOIN agent_sessions s ON s.id=h.session_id WHERE s.workspace_id=?1 AND h.session_id=?2 AND h.sequence>?3 ORDER BY h.sequence LIMIT 100")?;
        query
            .query_map(params![workspace.to_string(), session, after], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .map(|r| {
                let (sequence, turn_id, kind, content) = r?;
                Ok(crate::acp::HistoryEntry {
                    sequence,
                    session_id: session.into(),
                    turn_id,
                    kind,
                    content: serde_json::from_str(&content)
                        .map_err(|e| CoreError::Serialization(e.to_string()))?,
                })
            })
            .collect()
    }

    pub(crate) fn pending_acp_inputs(&self, workspace: WorkspaceId) -> CoreResult<Vec<Value>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut query=connection.prepare("SELECT i.id,h.content_json FROM input_requests i JOIN acp_history h ON json_extract(h.content_json,'$.input.id')=i.id WHERE i.workspace_id=?1 AND i.status IN ('pending','response-submitted') AND h.kind='input-request' ORDER BY h.sequence")?;
        query
            .query_map([workspace.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (id, content) = row?;
                let mut value: Value = serde_json::from_str(&content)
                    .map_err(|e| CoreError::Serialization(e.to_string()))?;
                value["input"] = json!(select_input(&connection, workspace, &id)?);
                Ok(value)
            })
            .collect()
    }

    pub(crate) fn record_acp_activity(
        &self,
        session: &crate::acp::SessionSnapshot,
        incarnation: &str,
        kind: &str,
        payload: Value,
    ) -> CoreResult<AcpCommit> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?1 AND generation=?2 AND is_open=1)",
            params![
                session.workspace_id.to_string(),
                session.workspace_generation.to_string()
            ],
            |row| row.get(0),
        )?;
        if !current {
            return Err(CoreError::StaleWorkspaceGeneration);
        }
        let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM acp_session_incarnations WHERE session_id=?1 AND token=?2 AND workspace_id=?3 AND generation=?4)",params![session.id,incarnation,session.workspace_id.to_string(),session.workspace_generation.to_string()],|r|r.get(0))?;
        if !current {
            return Err(CoreError::TaskFailed(
                "Stale ACP session incarnation".into(),
            ));
        }
        let mut changed_ids = Vec::<String>::new();
        if kind == "session-ended" {
            let mut query=tx.prepare("SELECT id FROM acp_turns WHERE session_id=?1 AND (state IN ('running','admitted') OR (?2 AND state='queued')) ORDER BY ordinal")?;
            changed_ids = query
                .query_map(
                    params![
                        session.id,
                        session.state == crate::acp::SessionState::Closed
                    ],
                    |r| r.get(0),
                )?
                .collect::<Result<_, _>>()?;
        } else if matches!(kind, "turn-started" | "turn-ended") {
            changed_ids.extend(session.turn_id.clone());
        }
        tx.execute("INSERT INTO agent_sessions(id,workspace_id,adapter,remote_session_id,capabilities_json,state,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,unixepoch('subsec')*1000,unixepoch('subsec')*1000)
            ON CONFLICT(id) DO UPDATE SET remote_session_id=excluded.remote_session_id,capabilities_json=excluded.capabilities_json,state=excluded.state,updated_at=excluded.updated_at",
            params![session.id,session.workspace_id.to_string(),session.adapter_id,session.remote_session_id,session.capabilities.to_string(),session.state.as_str()])?;
        tx.execute("INSERT INTO acp_sessions(id,snapshot_json) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json", params![session.id,serde_json::to_string(session).map_err(|e| CoreError::Serialization(e.to_string()))?])?;
        tx.execute(
            "UPDATE agent_sessions SET authentication_profile=?2,review_session_id=?3 WHERE id=?1",
            params![
                session.id,
                session.authentication_profile,
                session.review_session_id
            ],
        )?;
        tx.execute("INSERT INTO acp_activity(session_id,turn_id,kind,payload_json,created_at) VALUES (?1,?2,?3,?4,unixepoch('subsec')*1000)", params![session.id,session.turn_id,kind,payload.to_string()])?;
        let sequence = tx.last_insert_rowid() as u64;
        if kind == "session-starting" {
            tx.execute(
                "DELETE FROM acp_replay_history WHERE session_id=?1",
                [&session.id],
            )?;
        }
        if kind == "history-replaced" {
            tx.execute("DELETE FROM acp_history WHERE session_id=?1 AND kind IN ('user-message','agent-message','tool-call','plan','mode')",[&session.id])?;
            tx.execute("INSERT INTO acp_history(session_id,kind,content_json) SELECT session_id,kind,content_json FROM acp_replay_history WHERE session_id=?1 ORDER BY sequence",[&session.id])?;
            tx.execute(
                "DELETE FROM acp_replay_history WHERE session_id=?1",
                [&session.id],
            )?;
        }
        if kind == "turn-started" {
            tx.execute("INSERT INTO acp_turns(id,session_id,request_id,text,state) VALUES(?1,?2,?1,?3,'running') ON CONFLICT(id) DO UPDATE SET state='running'",params![session.turn_id,session.id,payload["text"].as_str().unwrap_or_default()])?;
        } else if kind == "turn-ended" {
            let reason = payload["stopReason"].as_str().unwrap_or("end_turn");
            tx.execute(
                "UPDATE acp_turns SET state=?2,stop_reason=?3 WHERE id=?1",
                params![
                    session.turn_id,
                    if reason == "cancelled" {
                        "cancelled"
                    } else {
                        "completed"
                    },
                    reason
                ],
            )?;
        } else if kind == "session-ended" {
            tx.execute("UPDATE acp_turns SET state=?2,stop_reason='host-stopped' WHERE session_id=?1 AND state IN ('running','admitted')",params![session.id,if session.state==crate::acp::SessionState::Closed {"cancelled"} else {"failed"}])?;
            if session.state == crate::acp::SessionState::Closed {
                tx.execute("UPDATE acp_turns SET state='cancelled',stop_reason='host-stopped' WHERE session_id=?1 AND state='queued'",[&session.id])?;
            }
        }
        let normalized = if matches!(kind, "agent-activity" | "permission-denied") {
            Some(("activity", payload.clone()))
        } else if kind == "turn-started" {
            Some(("user-message", payload.clone()))
        } else if matches!(kind, "session-update" | "session-replay-update") {
            match payload["sessionUpdate"].as_str() {
                Some("agent_message_chunk") => Some((
                    "agent-message",
                    json!({"messageId":payload["messageId"],"content":payload["content"]}),
                )),
                Some("user_message_chunk") => Some((
                    "user-message",
                    json!({"messageId":payload["messageId"],"content":payload["content"]}),
                )),
                Some("tool_call" | "tool_call_update") => Some(("tool-call", payload.clone())),
                Some("plan") => Some(("plan", payload["entries"].clone())),
                Some("current_mode_update") => {
                    Some(("mode", json!({"modeId":payload["currentModeId"]})))
                }
                _ => Some(("activity", payload.clone())),
            }
        } else {
            None
        };
        if let Some((entry_kind, content)) = normalized {
            if kind == "session-replay-update" {
                tx.execute(
                    "INSERT INTO acp_replay_history(session_id,kind,content_json) VALUES(?1,?2,?3)",
                    params![session.id, entry_kind, content.to_string()],
                )?;
            } else {
                tx.execute(
                "INSERT INTO acp_history(session_id,turn_id,kind,content_json) VALUES(?1,?2,?3,?4)",
                params![session.id, session.turn_id, entry_kind, content.to_string()],
            )?;
            }
        }
        let mut turns = Vec::new();
        for id in changed_ids {
            turns.push(tx.query_row(
                "SELECT id,session_id,request_id,text,state,stop_reason FROM acp_turns WHERE id=?1",
                [id],
                |r| {
                    Ok(crate::acp::QueuedTurn {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        request_id: r.get(2)?,
                        text: r.get(3)?,
                        state: r.get(4)?,
                        stop_reason: r.get(5)?,
                    })
                },
            )?);
        }
        tx.commit()?;
        Ok(AcpCommit {
            turns,
            activity: crate::acp::SessionActivity {
                sequence,
                session_id: session.id.clone(),
                turn_id: session.turn_id.clone(),
                kind: kind.into(),
                payload,
            },
        })
    }

    pub(crate) fn acp_sessions(
        &self,
        workspace: WorkspaceId,
    ) -> CoreResult<Vec<crate::acp::SessionSnapshot>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut query = connection.prepare("SELECT snapshot_json FROM acp_sessions JOIN agent_sessions USING(id) WHERE workspace_id=?1 ORDER BY created_at,id")?;
        query
            .query_map([workspace.to_string()], |row| row.get::<_, String>(0))?
            .map(|row| {
                serde_json::from_str(&row?).map_err(|e| CoreError::Serialization(e.to_string()))
            })
            .collect()
    }

    pub(crate) fn ensure_current_acp_file_ids(
        &self,
        workspace: WorkspaceId,
        session: &str,
    ) -> CoreResult<()> {
        let legacy:bool=self.connection.lock().expect("database lock poisoned").query_row("SELECT EXISTS(SELECT 1 FROM acp_legacy_quoted_scopes l JOIN agent_sessions a ON a.id=l.session_id WHERE l.session_id=?1 AND a.workspace_id=?2)",params![session,workspace.to_string()],|row|row.get(0))?;
        if legacy {
            return Err(CoreError::InvalidParams("saved reviewFileIds use legacy Git display quoting; start a new session with current changed-file IDs".into()));
        }
        Ok(())
    }

    pub(crate) fn acp_activity(
        &self,
        workspace: WorkspaceId,
        session: &str,
        after: u64,
    ) -> CoreResult<Vec<crate::acp::SessionActivity>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let after = i64::try_from(after)
            .map_err(|_| CoreError::InvalidParams("invalid activity cursor".into()))?;
        let mut query = connection.prepare("SELECT a.sequence,a.turn_id,a.kind,a.payload_json FROM acp_activity a JOIN agent_sessions s ON s.id=a.session_id WHERE s.workspace_id=?1 AND a.session_id=?2 AND a.sequence>?3 AND NOT (a.kind='session-update' AND COALESCE(json_extract(a.payload_json,'$.sessionUpdate'),'')='agent_thought_chunk') ORDER BY a.sequence LIMIT 100")?;
        query
            .query_map(params![workspace.to_string(), session, after], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .map(|row| {
                let (sequence, turn_id, kind, payload) = row?;
                Ok(crate::acp::SessionActivity {
                    sequence,
                    session_id: session.into(),
                    turn_id,
                    kind,
                    payload: serde_json::from_str(&payload)
                        .map_err(|e| CoreError::Serialization(e.to_string()))?,
                })
            })
            .collect()
    }

    /// No implicit resume: interrupted hosts are failed before startup snapshots.
    pub(crate) fn recover_acp_sessions(&self) -> CoreResult<()> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM acp_session_incarnations", [])?;
        tx.execute("DELETE FROM acp_replay_history", [])?;
        tx.execute("UPDATE acp_turns SET state='failed',stop_reason='application-restarted' WHERE state IN ('running','admitted')",[])?;
        tx.execute_batch("UPDATE attention_items SET status='expired',lifecycle='expired' WHERE id IN (SELECT attention_id FROM input_requests WHERE agent_session_id IN (SELECT id FROM acp_sessions) AND status IN ('pending','response-submitted'));
            UPDATE input_requests SET status='expired' WHERE agent_session_id IN (SELECT id FROM acp_sessions) AND status IN ('pending','response-submitted');")?;
        tx.execute_batch("INSERT INTO acp_activity(session_id,turn_id,kind,payload_json,created_at)
            SELECT a.id,json_extract(a.snapshot_json,'$.turnId'),'session-ended','{\"reason\":\"application-restarted\"}',unixepoch('subsec')*1000
            FROM acp_sessions a JOIN agent_sessions s USING(id) WHERE s.state IN ('starting','ready','running');
            UPDATE acp_sessions SET snapshot_json=json_set(snapshot_json,'$.state','failed') WHERE id IN (SELECT id FROM agent_sessions WHERE state IN ('starting','ready','running'));
            UPDATE agent_sessions SET state='failed',updated_at=unixepoch('subsec')*1000 WHERE id IN (SELECT id FROM acp_sessions) AND state IN ('starting','ready','running');")?;
        tx.commit()?;
        Ok(())
    }

    fn validate_integrity(&self) -> CoreResult<()> {
        let result = self
            .connection
            .lock()
            .expect("database lock poisoned")
            .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))?;
        if result == "ok" {
            Ok(())
        } else {
            Err(CoreError::DatabaseCorrupt(result))
        }
    }

    pub(crate) fn open_workspace(
        &self,
        canonical_root: &str,
        root: &str,
        display_name: &str,
        generation: WorkspaceGeneration,
    ) -> CoreResult<OpenedWorkspace> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT id, is_open FROM workspaces WHERE canonical_root = ?1",
                [canonical_root],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        let id = match &existing {
            Some((id, _)) => WorkspaceId::parse(id).map_err(|_| rusqlite::Error::InvalidQuery)?,
            None => WorkspaceId::new(),
        };

        if existing.is_some() {
            transaction.execute(
                "UPDATE workspaces
                 SET rail_order = CASE WHEN is_open = 0 THEN (
                       SELECT COALESCE(MAX(other.rail_order) + 1, 0)
                       FROM workspaces other WHERE other.is_open = 1 AND other.id != workspaces.id
                     ) ELSE rail_order END,
                     root = ?2, display_name = ?3, last_opened_at = ?4, is_open = 1,
                      generation = ?5, load_state = 'ready'
                 WHERE canonical_root = ?1",
                params![
                    canonical_root,
                    root,
                    display_name,
                    now_millis(),
                    generation.to_string()
                ],
            )?;
        } else {
            let rail_order = transaction.query_row(
                "SELECT COALESCE(MAX(rail_order) + 1, 0) FROM workspaces WHERE is_open = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            transaction.execute(
                "INSERT INTO workspaces(
                    id, canonical_root, root, display_name, rail_order, last_opened_at,
                    is_open, generation, load_state
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'ready')",
                params![
                    id.to_string(),
                    canonical_root,
                    root,
                    display_name,
                    rail_order,
                    now_millis(),
                    generation.to_string()
                ],
            )?;
        }
        transaction.commit()?;
        Ok(OpenedWorkspace {
            id,
            was_open: existing.is_some_and(|(_, was_open)| was_open),
        })
    }

    pub(crate) fn activate_workspace(&self, id: WorkspaceId) -> CoreResult<()> {
        self.connection
            .lock()
            .expect("database lock poisoned")
            .execute(
                "UPDATE app_state SET active_workspace_id = ?1 WHERE singleton = 1",
                [id.to_string()],
            )?;
        Ok(())
    }

    pub(crate) fn deactivate_workspace(&self) -> CoreResult<()> {
        self.connection
            .lock()
            .expect("database lock poisoned")
            .execute(
                "UPDATE app_state SET active_workspace_id = NULL WHERE singleton = 1",
                [],
            )?;
        Ok(())
    }

    pub(crate) fn close_workspace(&self, id: WorkspaceId) -> CoreResult<()> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE workspaces SET is_open = 0, generation = NULL, load_state = 'closed' WHERE id = ?1",
            [id.to_string()],
        )?;
        transaction.execute(
            "UPDATE app_state SET active_workspace_id = NULL WHERE singleton = 1 AND active_workspace_id = ?1",
            [id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn workspace_has_pending_input(&self, id: WorkspaceId) -> CoreResult<bool> {
        let connection = self.connection.lock().expect("database lock poisoned");
        ensure_workspace(&connection, id)?;
        let pending = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM input_requests
               WHERE workspace_id = ?1 AND status IN ('pending', 'response-submitted')
             )",
            params![id.to_string()],
            |row| row.get(0),
        )?;
        Ok(pending)
    }

    pub(crate) fn close_workspace_with_input_policy(
        &self,
        id: WorkspaceId,
        force: bool,
    ) -> CoreResult<ClosedWorkspace> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_workspace(&transaction, id)?;

        let mut statement = transaction.prepare(
            "SELECT id FROM input_requests
             WHERE workspace_id = ?1 AND status IN ('pending', 'response-submitted')
             ORDER BY created_at, id",
        )?;
        let input_ids = statement
            .query_map(params![id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        if !input_ids.is_empty() && !force {
            return Err(CoreError::WorkspaceHasPendingInput);
        }

        if !input_ids.is_empty() {
            let now = now_millis();
            transaction.execute(
                "UPDATE attention_items
                 SET status = 'resolved', lifecycle = 'resolved', updated_at = ?2
                 WHERE workspace_id = ?1 AND id IN (
                   SELECT attention_id FROM input_requests
                   WHERE workspace_id = ?1 AND status IN ('pending', 'response-submitted')
                 )",
                params![id.to_string(), now],
            )?;
            transaction.execute(
                "UPDATE input_requests
                 SET status = 'cancelled', updated_at = ?2
                 WHERE workspace_id = ?1 AND status IN ('pending', 'response-submitted')",
                params![id.to_string(), now],
            )?;
        }

        let summary = attention_summary_tx(&transaction, id)?;
        let mut forced_inputs = Vec::with_capacity(input_ids.len());
        for input_id in input_ids {
            let input = select_input(&transaction, id, &input_id)?.ok_or_else(|| {
                CoreError::DatabaseCorrupt(format!(
                    "forced-close input disappeared before commit: {input_id}"
                ))
            })?;
            let attention_id = &input.attention_id;
            let attention = Some(
                select_attention(&transaction, id, attention_id)?.ok_or_else(|| {
                    CoreError::DatabaseCorrupt(format!(
                        "forced-close attention disappeared before commit: {attention_id}"
                    ))
                })?,
            );
            forced_inputs.push(InputMutationResult {
                outcome: MutationOutcome::Applied,
                input,
                attention,
                summary: summary.clone(),
            });
        }

        transaction.execute(
            "UPDATE workspaces
             SET is_open = 0, generation = NULL, load_state = 'closed'
             WHERE id = ?1",
            params![id.to_string()],
        )?;
        transaction.execute(
            "UPDATE app_state SET active_workspace_id = NULL
             WHERE singleton = 1 AND active_workspace_id = ?1",
            params![id.to_string()],
        )?;
        transaction.commit()?;
        Ok(ClosedWorkspace { forced_inputs })
    }

    pub(crate) fn restorable_workspaces(&self) -> CoreResult<Vec<RestorableWorkspace>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection.prepare(
            "SELECT w.id, w.root, w.display_name,
                    CASE WHEN a.active_workspace_id IS NOT NULL AND a.active_workspace_id = w.id THEN 1 ELSE 0 END
             FROM workspaces w CROSS JOIN app_state a
             WHERE w.is_open = 1
             ORDER BY CASE WHEN a.active_workspace_id IS NOT NULL AND a.active_workspace_id = w.id THEN 1 ELSE 0 END DESC,
                      w.rail_order ASC",
        )?;
        statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                Ok(RestorableWorkspace {
                    id: parse_workspace_id(&id)?,
                    root: row.get(1)?,
                    display_name: row.get(2)?,
                    active: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn mark_restore_failed(&self, id: WorkspaceId) -> CoreResult<()> {
        self.connection
            .lock()
            .expect("database lock poisoned")
            .execute(
                "UPDATE workspaces SET is_open = 1, load_state = 'degraded', generation = NULL WHERE id = ?1",
                [id.to_string()],
            )?;
        Ok(())
    }

    pub(crate) fn dismiss_restore_failure(&self, id: WorkspaceId) -> CoreResult<bool> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = transaction
            .query_row(
                "SELECT is_open, load_state, generation FROM workspaces WHERE id = ?1",
                [id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((is_open, load_state, generation)) = state else {
            return Err(CoreError::WorkspaceNotFound);
        };
        if is_open && generation.is_some() {
            return Err(CoreError::CannotDismissLiveWorkspace);
        }
        let dismissed = is_open && load_state == "degraded";
        if dismissed {
            transaction.execute(
                "UPDATE workspaces
                 SET is_open = 0, load_state = 'closed', generation = NULL
                 WHERE id = ?1",
                params![id.to_string()],
            )?;
            transaction.execute(
                "UPDATE app_state SET active_workspace_id = NULL
                 WHERE singleton = 1 AND active_workspace_id = ?1",
                params![id.to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(dismissed)
    }

    pub(crate) fn unload_workspace(&self, id: WorkspaceId) -> CoreResult<()> {
        self.connection
            .lock()
            .expect("database lock poisoned")
            .execute(
                "UPDATE workspaces SET generation = NULL, load_state = 'closed'
                 WHERE id = ?1 AND is_open = 1",
                [id.to_string()],
            )?;
        Ok(())
    }

    pub(crate) fn reorder_workspaces(&self, ids: &[WorkspaceId]) -> CoreResult<Vec<WorkspaceId>> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = {
            let mut statement = transaction
                .prepare("SELECT id FROM workspaces WHERE is_open = 1 ORDER BY rail_order, id")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let supplied = ids.iter().map(ToString::to_string).collect::<Vec<_>>();
        let mut current_set = current.clone();
        let mut supplied_set = supplied.clone();
        current_set.sort();
        supplied_set.sort();
        supplied_set.dedup();
        if supplied_set != current_set {
            return Err(CoreError::InvalidParams(
                "workspaceIds must contain every open workspace exactly once".to_owned(),
            ));
        }
        for (position, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE workspaces SET rail_order = ?2 WHERE id = ?1",
                params![
                    id.to_string(),
                    -i64::try_from(position).unwrap_or(i64::MAX) - 1
                ],
            )?;
        }
        for (position, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE workspaces SET rail_order = ?2 WHERE id = ?1",
                params![id.to_string(), i64::try_from(position).unwrap_or(i64::MAX)],
            )?;
        }
        transaction.commit()?;
        Ok(ids.to_vec())
    }

    pub(crate) fn ordered_open_workspace_ids(&self) -> CoreResult<Vec<WorkspaceId>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection
            .prepare("SELECT id FROM workspaces WHERE is_open = 1 ORDER BY rail_order, id")?;
        statement
            .query_map([], |row| {
                let value: String = row.get(0)?;
                parse_workspace_id(&value)
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn save_workspace_ui_state(
        &self,
        workspace_id: WorkspaceId,
        expected_revision: u64,
        state: Value,
    ) -> CoreResult<WorkspaceUiStateMutationResult> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_workspace(&transaction, workspace_id)?;
        let current = select_ui_state(&transaction, workspace_id)?;
        let outcome = match &current {
            None if expected_revision == 0 => MutationOutcome::Applied,
            Some(current) if current.revision == expected_revision => MutationOutcome::Applied,
            _ => MutationOutcome::Stale,
        };
        if outcome != MutationOutcome::Applied {
            return Ok(WorkspaceUiStateMutationResult {
                outcome,
                record: current.unwrap_or(WorkspaceUiStateRecord {
                    revision: 0,
                    state: Value::Null,
                    updated_at: timestamp_millis(0),
                }),
            });
        }
        let revision = match current {
            Some(record) => record.revision.checked_add(1).ok_or_else(|| {
                CoreError::InvalidParams("workspace UI state revision is exhausted".to_owned())
            })?,
            None => 1,
        };
        let updated_at = now_millis();
        let state_json = serde_json::to_string(&state)
            .map_err(|error| CoreError::Serialization(error.to_string()))?;
        transaction.execute(
            "INSERT INTO workspace_ui_state(workspace_id, version, revision, state_json, updated_at)
             VALUES (?1, ?2, ?2, ?3, ?4)
             ON CONFLICT(workspace_id) DO UPDATE SET
                version = excluded.version, revision = excluded.revision,
                state_json = excluded.state_json, updated_at = excluded.updated_at",
            params![workspace_id.to_string(), revision, state_json, updated_at],
        )?;
        transaction.commit()?;
        Ok(WorkspaceUiStateMutationResult {
            outcome,
            record: WorkspaceUiStateRecord {
                revision,
                state,
                updated_at: timestamp_millis(updated_at),
            },
        })
    }

    pub(crate) fn workspace_ui_states(
        &self,
    ) -> CoreResult<std::collections::BTreeMap<String, WorkspaceUiStateRecord>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection.prepare(
            "SELECT u.workspace_id, u.revision, u.state_json, u.updated_at
             FROM workspace_ui_state u JOIN workspaces w ON w.id = u.workspace_id
             WHERE w.is_open = 1 ORDER BY w.rail_order",
        )?;
        let rows = statement.query_map([], |row| {
            let workspace_id: String = row.get(0)?;
            let state_json: String = row.get(2)?;
            Ok((
                workspace_id,
                WorkspaceUiStateRecord {
                    revision: to_u64(row.get(1)?)?,
                    state: parse_json(&state_json)?,
                    updated_at: timestamp_millis(row.get(3)?),
                },
            ))
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    pub(crate) fn create_or_revise_attention(
        &self,
        request: &CreateAttentionRequest,
    ) -> CoreResult<AttentionMutationResult> {
        request.validate()?;
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_workspace(&transaction, request.workspace_id)?;
        let existing = select_attention_by_source(
            &transaction,
            request.workspace_id,
            &request.source_id,
            request.kind,
        )?;
        let desired_status = request.status.unwrap_or(AttentionStatus::Unread);
        let (outcome, item) = if let Some(item) = existing {
            if request.id.as_ref().is_some_and(|id| id != &item.id) {
                (MutationOutcome::Invalid, item)
            } else if request.revision < item.revision {
                (MutationOutcome::Stale, item)
            } else if request.revision == item.revision {
                if item.target != request.target
                    || (item.status.is_terminal() && item.status != desired_status)
                {
                    (MutationOutcome::Invalid, item)
                } else if desired_status.is_terminal() && !item.status.is_terminal() {
                    let updated_at = now_millis();
                    transaction.execute(
                        "UPDATE attention_items SET status = ?2, lifecycle = ?2,
                            updated_at = ?3 WHERE id = ?1",
                        params![item.id, desired_status.as_str(), updated_at],
                    )?;
                    (
                        MutationOutcome::Applied,
                        AttentionItem {
                            status: desired_status,
                            updated_at: timestamp_millis(updated_at),
                            ..item
                        },
                    )
                } else {
                    (MutationOutcome::Unchanged, item)
                }
            } else if item.revision.checked_add(1) != Some(request.revision) {
                (MutationOutcome::Invalid, item)
            } else {
                let updated_at = now_millis();
                transaction.execute(
                    "UPDATE attention_items SET revision = ?2, status = ?3, lifecycle = ?4,
                        target_json = ?5, updated_at = ?6 WHERE id = ?1",
                    params![
                        item.id,
                        request.revision,
                        desired_status.as_str(),
                        attention_lifecycle(desired_status),
                        json_string(&request.target)?,
                        updated_at
                    ],
                )?;
                (
                    MutationOutcome::Applied,
                    AttentionItem {
                        revision: request.revision,
                        status: desired_status,
                        target: request.target.clone(),
                        updated_at: timestamp_millis(updated_at),
                        ..item
                    },
                )
            }
        } else {
            if desired_status != AttentionStatus::Unread {
                return Err(CoreError::InvalidParams(
                    "new attention must start unread".to_owned(),
                ));
            }
            let id = request
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let now = now_millis();
            transaction.execute(
                "INSERT INTO attention_items(
                    id, workspace_id, source_id, kind, revision, status, target_json,
                    created_at, updated_at, acknowledged_revision, notified_revision, lifecycle
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL, NULL, ?9)",
                params![
                    id,
                    request.workspace_id.to_string(),
                    request.source_id,
                    request.kind.as_str(),
                    request.revision,
                    desired_status.as_str(),
                    json_string(&request.target)?,
                    now,
                    attention_lifecycle(desired_status)
                ],
            )?;
            (
                MutationOutcome::Applied,
                AttentionItem {
                    id,
                    workspace_id: request.workspace_id,
                    source_id: request.source_id.clone(),
                    kind: request.kind,
                    revision: request.revision,
                    status: desired_status,
                    target: request.target.clone(),
                    created_at: timestamp_millis(now),
                    updated_at: timestamp_millis(now),
                },
            )
        };
        let summary = attention_summary_tx(&transaction, request.workspace_id)?;
        if outcome == MutationOutcome::Applied {
            transaction.commit()?;
        }
        Ok(AttentionMutationResult {
            outcome,
            item,
            summary,
        })
    }

    pub(crate) fn mutate_attention_revision(
        &self,
        workspace_id: WorkspaceId,
        attention_id: &str,
        expected_revision: u64,
        notification_claim: bool,
    ) -> CoreResult<AttentionMutationResult> {
        validate_entity_revision(expected_revision, "expectedRevision")?;
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut item = select_attention(&transaction, workspace_id, attention_id)?
            .ok_or(CoreError::WorkspaceNotFound)?;
        let acknowledged: Option<i64> = transaction.query_row(
            "SELECT acknowledged_revision FROM attention_items WHERE id = ?1",
            [attention_id],
            |row| row.get(0),
        )?;
        let notified: Option<i64> = transaction.query_row(
            "SELECT notified_revision FROM attention_items WHERE id = ?1",
            [attention_id],
            |row| row.get(0),
        )?;
        let outcome = if expected_revision != item.revision {
            MutationOutcome::Stale
        } else if item.status.is_terminal() {
            MutationOutcome::Invalid
        } else if notification_claim {
            if notified.and_then(|value| u64::try_from(value).ok()) == Some(expected_revision) {
                MutationOutcome::Unchanged
            } else {
                transaction.execute(
                    "UPDATE attention_items SET notified_revision = ?2 WHERE id = ?1 AND revision = ?2",
                    params![attention_id, expected_revision],
                )?;
                MutationOutcome::Applied
            }
        } else if acknowledged.and_then(|value| u64::try_from(value).ok())
            == Some(expected_revision)
        {
            MutationOutcome::Unchanged
        } else {
            let updated_at = now_millis();
            transaction.execute(
                "UPDATE attention_items SET acknowledged_revision = ?2,
                    status = 'acknowledged', updated_at = ?3 WHERE id = ?1 AND revision = ?2",
                params![attention_id, expected_revision, updated_at],
            )?;
            item.status = AttentionStatus::Acknowledged;
            item.updated_at = timestamp_millis(updated_at);
            MutationOutcome::Applied
        };
        let summary = attention_summary_tx(&transaction, workspace_id)?;
        if outcome == MutationOutcome::Applied {
            transaction.commit()?;
        }
        Ok(AttentionMutationResult {
            outcome,
            item,
            summary,
        })
    }

    pub(crate) fn create_input(
        &self,
        request: &CreateInputRequest,
    ) -> CoreResult<InputMutationResult> {
        self.create_input_internal(request, None)
    }

    pub(crate) fn create_acp_input(
        &self,
        request: &CreateInputRequest,
        session: &str,
        metadata: &Value,
    ) -> CoreResult<InputMutationResult> {
        self.create_input_internal(request, Some((session, metadata)))
    }

    pub(crate) fn acp_input(&self, workspace: WorkspaceId, id: &str) -> CoreResult<InputRequest> {
        select_input(
            &self.connection.lock().expect("database lock poisoned"),
            workspace,
            id,
        )?
        .ok_or(CoreError::WorkspaceNotFound)
    }

    pub(crate) fn is_acp_input(&self, workspace: WorkspaceId, id: &str) -> CoreResult<bool> {
        Ok(self.connection.lock().expect("database lock poisoned").query_row("SELECT EXISTS(SELECT 1 FROM input_requests i JOIN acp_sessions a ON a.id=i.agent_session_id WHERE i.id=?1 AND i.workspace_id=?2)",params![id,workspace.to_string()],|r|r.get(0))?)
    }

    fn create_input_internal(
        &self,
        request: &CreateInputRequest,
        agent_session: Option<(&str, &Value)>,
    ) -> CoreResult<InputMutationResult> {
        request.validate()?;
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_workspace(&transaction, request.workspace_id)?;
        if let Some((session, _)) = agent_session {
            let owned:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM agent_sessions a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=?1 AND w.id=?2 AND w.generation=?3 AND w.is_open=1)",params![session,request.workspace_id.to_string(),request.workspace_generation.to_string()],|r|r.get(0))?;
            if !owned {
                return Err(CoreError::StaleWorkspaceGeneration);
            }
        }
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if let Some(existing) = select_input(&transaction, request.workspace_id, &id)? {
            let target =
                request
                    .target
                    .clone()
                    .unwrap_or_else(|| WorkspaceNavigationTarget::Input {
                        input_request_id: id.clone(),
                    });
            let existing_attention =
                select_attention(&transaction, request.workspace_id, &existing.attention_id)?
                    .ok_or(CoreError::WorkspaceNotFound)?;
            let same_payload = request.kind == existing.kind
                && request.prompt == existing.prompt
                && request.choices == existing.choices
                && request.cancellation_supported == existing.cancellation_supported
                && request
                    .attention_id
                    .as_ref()
                    .is_none_or(|id| id == &existing.attention_id)
                && target == existing_attention.target;
            let (outcome, input) = if request.revision < existing.revision {
                (MutationOutcome::Stale, existing)
            } else if request.revision == existing.revision {
                if same_payload {
                    (MutationOutcome::Unchanged, existing)
                } else {
                    (MutationOutcome::Invalid, existing)
                }
            } else if existing.revision.checked_add(1) != Some(request.revision) {
                (MutationOutcome::Invalid, existing)
            } else {
                let updated_at = now_millis();
                let request_json = json_string(&json!({
                    "prompt": request.prompt,
                    "choices": request.choices,
                    "cancellationSupported": request.cancellation_supported,
                }))?;
                transaction.execute(
                    "UPDATE input_requests SET revision = ?2, kind = ?3, status = 'pending',
                        request_json = ?4, response_json = NULL, updated_at = ?5 WHERE id = ?1",
                    params![
                        id,
                        request.revision,
                        request.kind.as_str(),
                        request_json,
                        updated_at
                    ],
                )?;
                transaction.execute(
                    "UPDATE attention_items SET revision = ?2, status = 'unread',
                        lifecycle = 'active', target_json = ?3, updated_at = ?4 WHERE id = ?1",
                    params![
                        existing.attention_id,
                        request.revision,
                        json_string(&target)?,
                        updated_at
                    ],
                )?;
                (
                    MutationOutcome::Applied,
                    InputRequest {
                        revision: request.revision,
                        kind: request.kind,
                        status: InputRequestStatus::Pending,
                        prompt: request.prompt.clone(),
                        choices: request.choices.clone(),
                        cancellation_supported: request.cancellation_supported,
                        response: None,
                        updated_at: timestamp_millis(updated_at),
                        ..existing
                    },
                )
            };
            let attention =
                select_attention(&transaction, request.workspace_id, &input.attention_id)?;
            let summary = attention_summary_tx(&transaction, request.workspace_id)?;
            if outcome == MutationOutcome::Applied {
                transaction.commit()?;
            }
            return Ok(InputMutationResult {
                outcome,
                input,
                attention,
                summary,
            });
        }
        let attention_id = request
            .attention_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let target = request
            .target
            .clone()
            .unwrap_or_else(|| WorkspaceNavigationTarget::Input {
                input_request_id: id.clone(),
            });
        let now = now_millis();
        let request_json = json_string(&json!({
            "prompt": request.prompt,
            "choices": request.choices,
            "cancellationSupported": request.cancellation_supported,
        }))?;
        transaction.execute(
            "INSERT INTO attention_items(
                id, workspace_id, source_id, kind, revision, status, target_json,
                created_at, updated_at, acknowledged_revision, notified_revision, lifecycle
             ) VALUES (?1, ?2, ?3, 'input', ?4, 'unread', ?5, ?6, ?6, NULL, NULL, 'active')",
            params![
                attention_id,
                request.workspace_id.to_string(),
                id,
                request.revision,
                json_string(&target)?,
                now
            ],
        )?;
        transaction.execute(
            "INSERT INTO input_requests(
                id, workspace_id, agent_session_id, revision, kind, status,
                request_json, response_json, created_at, updated_at, attention_id
             ) VALUES (?1, ?2, ?8, ?3, ?4, 'pending', ?5, NULL, ?6, ?6, ?7)",
            params![
                id,
                request.workspace_id.to_string(),
                request.revision,
                request.kind.as_str(),
                request_json,
                now,
                attention_id,
                agent_session.map(|(session, _)| session),
            ],
        )?;
        let input = InputRequest {
            id,
            workspace_id: request.workspace_id,
            revision: request.revision,
            kind: request.kind,
            status: InputRequestStatus::Pending,
            prompt: request.prompt.clone(),
            choices: request.choices.clone(),
            cancellation_supported: request.cancellation_supported,
            response: None,
            attention_id: attention_id.clone(),
            created_at: timestamp_millis(now),
            updated_at: timestamp_millis(now),
        };
        let attention = select_attention(&transaction, request.workspace_id, &attention_id)?;
        if let Some((session, metadata)) = agent_session {
            transaction.execute(
                "INSERT INTO acp_input_delivery VALUES(?1,'waiting')",
                [&input.id],
            )?;
            transaction.execute("INSERT INTO acp_history(session_id,kind,content_json) VALUES(?1,'input-request',?2)",params![session,json!({"input":input,"method":metadata["method"],"params":metadata["params"],"sessionId":session}).to_string()])?;
        }
        let summary = attention_summary_tx(&transaction, request.workspace_id)?;
        transaction.commit()?;
        Ok(InputMutationResult {
            outcome: MutationOutcome::Applied,
            input,
            attention,
            summary,
        })
    }

    pub(crate) fn answer_input(
        &self,
        workspace_id: WorkspaceId,
        input_id: &str,
        expected_revision: u64,
        response: InputResponse,
        redact_response: bool,
    ) -> CoreResult<InputMutationResult> {
        validate_entity_revision(expected_revision, "expectedRevision")?;
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut input = select_input(&transaction, workspace_id, input_id)?
            .ok_or(CoreError::WorkspaceNotFound)?;
        let persisted = if redact_response
            || input.kind == InputRequestKind::Authentication
            || response.secret == Some(true)
        {
            InputResponse {
                value: String::new(),
                secret: Some(true),
            }
        } else {
            response
        };
        let outcome = if expected_revision != input.revision {
            MutationOutcome::Stale
        } else if input.status == InputRequestStatus::ResponseSubmitted {
            if input.response.as_ref() == Some(&persisted) {
                MutationOutcome::Unchanged
            } else {
                MutationOutcome::Invalid
            }
        } else if input.status != InputRequestStatus::Pending {
            MutationOutcome::Invalid
        } else {
            let updated_at = now_millis();
            transaction.execute(
                "UPDATE input_requests SET status = 'response-submitted',
                    response_json = ?2, updated_at = ?3 WHERE id = ?1 AND revision = ?4",
                params![
                    input_id,
                    json_string(&persisted)?,
                    updated_at,
                    expected_revision
                ],
            )?;
            input.status = InputRequestStatus::ResponseSubmitted;
            input.response = Some(persisted);
            input.updated_at = timestamp_millis(updated_at);
            MutationOutcome::Applied
        };
        let attention = select_attention(&transaction, workspace_id, &input.attention_id)?;
        let summary = attention_summary_tx(&transaction, workspace_id)?;
        if outcome == MutationOutcome::Applied {
            transaction.commit()?;
        }
        Ok(InputMutationResult {
            outcome,
            input,
            attention,
            summary,
        })
    }

    pub(crate) fn finish_input(
        &self,
        workspace_id: WorkspaceId,
        input_id: &str,
        expected_revision: u64,
        desired: InputRequestStatus,
    ) -> CoreResult<InputMutationResult> {
        self.finish_input_internal(workspace_id, input_id, expected_revision, desired, false)
    }

    pub(crate) fn finish_acp_input(
        &self,
        workspace_id: WorkspaceId,
        input_id: &str,
        expected_revision: u64,
        desired: InputRequestStatus,
    ) -> CoreResult<InputMutationResult> {
        self.finish_input_internal(workspace_id, input_id, expected_revision, desired, true)
    }

    pub(crate) fn claim_acp_input(
        &self,
        workspace: WorkspaceId,
        id: &str,
    ) -> CoreResult<Option<InputRequest>> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let input = select_input(&tx, workspace, id)?.ok_or(CoreError::WorkspaceNotFound)?;
        if input.status != InputRequestStatus::ResponseSubmitted {
            return Ok(None);
        }
        if tx.execute(
            "UPDATE acp_input_delivery SET state='sending' WHERE input_id=?1 AND state='waiting'",
            [id],
        )? != 1
        {
            return Ok(None);
        }
        tx.commit()?;
        Ok(Some(input))
    }

    fn finish_input_internal(
        &self,
        workspace_id: WorkspaceId,
        input_id: &str,
        expected_revision: u64,
        desired: InputRequestStatus,
        producer: bool,
    ) -> CoreResult<InputMutationResult> {
        validate_entity_revision(expected_revision, "expectedRevision")?;
        debug_assert!(desired.is_terminal());
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut input = select_input(&transaction, workspace_id, input_id)?
            .ok_or(CoreError::WorkspaceNotFound)?;
        let delivery: Option<String> = transaction
            .query_row(
                "SELECT state FROM acp_input_delivery WHERE input_id=?1",
                [input_id],
                |r| r.get(0),
            )
            .optional()?;
        let producer_owned = !producer
            && delivery.is_some()
            && (delivery.as_deref() == Some("sending")
                || matches!(
                    desired,
                    InputRequestStatus::Accepted | InputRequestStatus::Rejected
                ));
        let allowed = !producer_owned
            && match desired {
                InputRequestStatus::Accepted | InputRequestStatus::Rejected => {
                    input.status == InputRequestStatus::ResponseSubmitted
                }
                InputRequestStatus::Cancelled => {
                    input.cancellation_supported
                        && matches!(
                            input.status,
                            InputRequestStatus::Pending | InputRequestStatus::ResponseSubmitted
                        )
                }
                InputRequestStatus::Expired | InputRequestStatus::Superseded => matches!(
                    input.status,
                    InputRequestStatus::Pending | InputRequestStatus::ResponseSubmitted
                ),
                _ => false,
            };
        let outcome = if expected_revision != input.revision {
            MutationOutcome::Stale
        } else if input.status == desired {
            MutationOutcome::Unchanged
        } else if !allowed {
            MutationOutcome::Invalid
        } else {
            let updated_at = now_millis();
            let attention_status = match desired {
                InputRequestStatus::Expired => AttentionStatus::Expired,
                InputRequestStatus::Superseded => AttentionStatus::Superseded,
                _ => AttentionStatus::Resolved,
            };
            transaction.execute(
                "UPDATE input_requests SET status = ?2, updated_at = ?3
                 WHERE id = ?1 AND revision = ?4",
                params![input_id, desired.as_str(), updated_at, expected_revision],
            )?;
            transaction.execute(
                "UPDATE attention_items SET status = ?2, lifecycle = ?2, updated_at = ?3
                 WHERE id = ?1",
                params![input.attention_id, attention_status.as_str(), updated_at],
            )?;
            input.status = desired;
            input.updated_at = timestamp_millis(updated_at);
            MutationOutcome::Applied
        };
        let attention = select_attention(&transaction, workspace_id, &input.attention_id)?;
        let summary = attention_summary_tx(&transaction, workspace_id)?;
        if outcome == MutationOutcome::Applied {
            transaction.commit()?;
        }
        Ok(InputMutationResult {
            outcome,
            input,
            attention,
            summary,
        })
    }

    pub(crate) fn attention_items(&self) -> CoreResult<Vec<AttentionItem>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection.prepare(
            "SELECT a.id, a.workspace_id, a.source_id, a.kind, a.revision, a.status,
                    a.target_json, a.created_at, a.updated_at, a.acknowledged_revision, a.lifecycle
             FROM attention_items a JOIN workspaces w ON w.id = a.workspace_id
             WHERE w.is_open = 1 ORDER BY w.rail_order, a.updated_at DESC, a.id",
        )?;
        statement
            .query_map([], attention_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn input_requests(&self) -> CoreResult<Vec<InputRequest>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection.prepare(
            "SELECT i.id, i.workspace_id, i.revision, i.kind, i.status, i.request_json,
                    i.response_json, i.created_at, i.updated_at, i.attention_id
             FROM input_requests i JOIN workspaces w ON w.id = i.workspace_id
             WHERE w.is_open = 1 ORDER BY w.rail_order, i.updated_at DESC, i.id",
        )?;
        statement
            .query_map([], input_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn attention_summary(
        &self,
        workspace_id: WorkspaceId,
    ) -> CoreResult<WorkspaceAttentionSummary> {
        attention_summary_tx(
            &self.connection.lock().expect("database lock poisoned"),
            workspace_id,
        )
    }

    pub(crate) fn record_legacy_import(
        &self,
        workspace_id: WorkspaceId,
        record: LegacyImportRecord<'_>,
    ) -> CoreResult<bool> {
        let stable_key = format!(
            "{}/{}/{}/{}",
            workspace_id, record.session_id, record.artifact_kind, record.relative_path
        );
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = transaction
            .query_row(
                "SELECT status, entity_id, content_hash, diagnostic
                 FROM legacy_review_import_ledger WHERE stable_key = ?1",
                [&stable_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        let status = if record.diagnostic.is_some() {
            "diagnostic"
        } else {
            "imported"
        };
        let unchanged = previous.as_ref().is_some_and(|previous| {
            previous.0 == status
                && previous.1.as_deref() == record.entity_id
                && previous.2.as_deref() == record.content_hash
                && previous.3.as_deref() == record.diagnostic
        });
        if unchanged {
            return Ok(false);
        }

        transaction.execute(
            "INSERT INTO legacy_review_import_ledger(
                stable_key, workspace_id, session_id, artifact_kind, relative_path,
                entity_id, content_hash, status, diagnostic, imported_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(stable_key) DO UPDATE SET
                entity_id = excluded.entity_id, content_hash = excluded.content_hash,
                status = excluded.status, diagnostic = excluded.diagnostic,
                imported_at = excluded.imported_at",
            params![
                stable_key,
                workspace_id.to_string(),
                record.session_id,
                record.artifact_kind,
                record.relative_path,
                record.entity_id,
                record.content_hash,
                status,
                record.diagnostic,
                now_millis()
            ],
        )?;

        let table = match record.artifact_kind {
            "run" => "legacy_import_runs",
            "agent" => "legacy_import_agents",
            "chat" => "legacy_import_chats",
            "prompt" => "legacy_import_prompts",
            _ => {
                return Err(CoreError::InvalidParams(
                    "unknown legacy artifact kind".to_owned(),
                ));
            }
        };
        transaction.execute(
            &format!(
                "DELETE FROM {table} WHERE workspace_id = ?1 AND session_id = ?2
                 AND source_path = ?3"
            ),
            params![
                workspace_id.to_string(),
                record.session_id,
                record.relative_path
            ],
        )?;
        if let (Some(entity_id), Some(content_hash), Some(payload)) =
            (record.entity_id, record.content_hash, record.payload)
        {
            let payload_column = if record.artifact_kind == "prompt" {
                "prompt_text"
            } else {
                "document_json"
            };
            transaction.execute(
                &format!(
                    "DELETE FROM {table} WHERE workspace_id = ?1 AND session_id = ?2
                     AND entity_id = ?3"
                ),
                params![workspace_id.to_string(), record.session_id, entity_id],
            )?;
            transaction.execute(
                &format!(
                    "INSERT INTO {table}(
                       workspace_id, session_id, entity_id, source_path,
                       content_hash, {payload_column}, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
                ),
                params![
                    workspace_id.to_string(),
                    record.session_id,
                    entity_id,
                    record.relative_path,
                    content_hash,
                    payload,
                    now_millis()
                ],
            )?;
        }
        transaction.commit()?;
        Ok(true)
    }

    pub(crate) fn clear_legacy_import_diagnostic(
        &self,
        workspace_id: WorkspaceId,
        session_id: &str,
        artifact_kind: &str,
        relative_path: &str,
    ) -> CoreResult<()> {
        self.connection
            .lock()
            .expect("database lock poisoned")
            .execute(
                "DELETE FROM legacy_review_import_ledger
                 WHERE workspace_id = ?1 AND session_id = ?2 AND artifact_kind = ?3
                   AND relative_path = ?4 AND status = 'diagnostic'",
                params![
                    workspace_id.to_string(),
                    session_id,
                    artifact_kind,
                    relative_path
                ],
            )?;
        Ok(())
    }

    pub fn legacy_review_import_report(
        &self,
        workspace_id: WorkspaceId,
    ) -> CoreResult<LegacyReviewImportReport> {
        let (imported, diagnostics): (i64, i64) = self
            .connection
            .lock()
            .expect("database lock poisoned")
            .query_row(
                "SELECT
                    COALESCE(SUM(status = 'imported'), 0),
                    COALESCE(SUM(status = 'diagnostic'), 0)
                 FROM legacy_review_import_ledger WHERE workspace_id = ?1",
                [workspace_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        Ok(LegacyReviewImportReport {
            workspace_id,
            imported: u64::try_from(imported).unwrap_or_default(),
            already_imported: 0,
            diagnostics: u64::try_from(diagnostics).unwrap_or_default(),
        })
    }

    pub fn legacy_imported_artifacts(
        &self,
        workspace_id: WorkspaceId,
    ) -> CoreResult<Vec<LegacyImportedArtifact>> {
        let connection = self.connection.lock().expect("database lock poisoned");
        let mut statement = connection.prepare(
            "SELECT 'run', session_id, entity_id, source_path, content_hash, document_json
               FROM legacy_import_runs WHERE workspace_id = ?1
             UNION ALL
             SELECT 'agent', session_id, entity_id, source_path, content_hash, document_json
               FROM legacy_import_agents WHERE workspace_id = ?1
             UNION ALL
             SELECT 'chat', session_id, entity_id, source_path, content_hash, document_json
               FROM legacy_import_chats WHERE workspace_id = ?1
             UNION ALL
             SELECT 'prompt', session_id, entity_id, source_path, content_hash, prompt_text
               FROM legacy_import_prompts WHERE workspace_id = ?1
             ORDER BY 1, 2, 4",
        )?;
        let rows = statement.query_map([workspace_id.to_string()], |row| {
            let kind: String = row.get(0)?;
            let session_id = row.get(1)?;
            let entity_id = row.get(2)?;
            let source_path = row.get(3)?;
            let content_hash = row.get(4)?;
            let payload: String = row.get(5)?;
            let artifact = match kind.as_str() {
                "run" => LegacyImportedArtifact::Run {
                    workspace_id,
                    session_id,
                    entity_id,
                    source_path,
                    content_hash,
                    document: parse_json(&payload)?,
                },
                "agent" => LegacyImportedArtifact::Agent {
                    workspace_id,
                    session_id,
                    entity_id,
                    source_path,
                    content_hash,
                    document: parse_json(&payload)?,
                },
                "chat" => LegacyImportedArtifact::Chat {
                    workspace_id,
                    session_id,
                    entity_id,
                    source_path,
                    content_hash,
                    document: parse_json(&payload)?,
                },
                "prompt" => LegacyImportedArtifact::Prompt {
                    workspace_id,
                    session_id,
                    entity_id,
                    source_path,
                    content_hash,
                    text: payload,
                },
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            Ok(artifact)
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[cfg(test)]
    fn schema_version(&self) -> CoreResult<i64> {
        Ok(self
            .connection
            .lock()
            .expect("database lock poisoned")
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })?)
    }

    #[cfg(test)]
    pub(crate) fn active_workspace_id(&self) -> CoreResult<Option<String>> {
        Ok(self
            .connection
            .lock()
            .expect("database lock poisoned")
            .query_row(
                "SELECT active_workspace_id FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )?)
    }
}

fn ensure_workspace(connection: &Connection, workspace_id: WorkspaceId) -> CoreResult<()> {
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        [workspace_id.to_string()],
        |row| row.get::<_, bool>(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(CoreError::WorkspaceNotFound)
    }
}

fn select_attention(
    connection: &Connection,
    workspace_id: WorkspaceId,
    attention_id: &str,
) -> CoreResult<Option<AttentionItem>> {
    connection
        .query_row(
            "SELECT id, workspace_id, source_id, kind, revision, status, target_json,
                    created_at, updated_at, acknowledged_revision, lifecycle
             FROM attention_items WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id.to_string(), attention_id],
            attention_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn select_attention_by_source(
    connection: &Connection,
    workspace_id: WorkspaceId,
    source_id: &str,
    kind: AttentionKind,
) -> CoreResult<Option<AttentionItem>> {
    connection
        .query_row(
            "SELECT id, workspace_id, source_id, kind, revision, status, target_json,
                    created_at, updated_at, acknowledged_revision, lifecycle
             FROM attention_items WHERE workspace_id = ?1 AND source_id = ?2 AND kind = ?3",
            params![workspace_id.to_string(), source_id, kind.as_str()],
            attention_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn attention_from_row(row: &Row<'_>) -> rusqlite::Result<AttentionItem> {
    let workspace_id: String = row.get(1)?;
    let kind: String = row.get(3)?;
    let target: String = row.get(6)?;
    let revision = to_u64(row.get(4)?)?;
    let acknowledged_revision: Option<i64> = row.get(9)?;
    let lifecycle: String = row.get(10)?;
    let status = match lifecycle.as_str() {
        "resolved" => AttentionStatus::Resolved,
        "expired" => AttentionStatus::Expired,
        "superseded" => AttentionStatus::Superseded,
        "active"
            if acknowledged_revision.and_then(|value| u64::try_from(value).ok())
                == Some(revision) =>
        {
            AttentionStatus::Acknowledged
        }
        "active" => AttentionStatus::Unread,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(AttentionItem {
        id: row.get(0)?,
        workspace_id: parse_workspace_id(&workspace_id)?,
        source_id: row.get(2)?,
        kind: AttentionKind::parse(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
        revision,
        status,
        target: parse_navigation_target(&target)?,
        created_at: timestamp_millis(row.get(7)?),
        updated_at: timestamp_millis(row.get(8)?),
    })
}

fn select_input(
    connection: &Connection,
    workspace_id: WorkspaceId,
    input_id: &str,
) -> CoreResult<Option<InputRequest>> {
    connection
        .query_row(
            "SELECT id, workspace_id, revision, kind, status, request_json,
                    response_json, created_at, updated_at, attention_id
             FROM input_requests WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id.to_string(), input_id],
            input_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn input_from_row(row: &Row<'_>) -> rusqlite::Result<InputRequest> {
    let workspace_id: String = row.get(1)?;
    let kind: String = row.get(3)?;
    let status: String = row.get(4)?;
    let request_json: String = row.get(5)?;
    let request: Value = parse_json(&request_json)?;
    let response_json: Option<String> = row.get(6)?;
    Ok(InputRequest {
        id: row.get(0)?,
        workspace_id: parse_workspace_id(&workspace_id)?,
        revision: to_u64(row.get(2)?)?,
        kind: InputRequestKind::parse(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
        status: InputRequestStatus::parse(&status).ok_or(rusqlite::Error::InvalidQuery)?,
        prompt: request
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or(rusqlite::Error::InvalidQuery)?
            .to_owned(),
        choices: request
            .get("choices")
            .and_then(Value::as_array)
            .ok_or(rusqlite::Error::InvalidQuery)?
            .iter()
            .map(|choice| {
                choice
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(rusqlite::Error::InvalidQuery)
            })
            .collect::<Result<Vec<_>, _>>()?,
        cancellation_supported: request
            .get("cancellationSupported")
            .and_then(Value::as_bool)
            .ok_or(rusqlite::Error::InvalidQuery)?,
        response: response_json.as_deref().map(parse_json).transpose()?,
        attention_id: row.get(9)?,
        created_at: timestamp_millis(row.get(7)?),
        updated_at: timestamp_millis(row.get(8)?),
    })
}

fn attention_summary_tx(
    connection: &Connection,
    workspace_id: WorkspaceId,
) -> CoreResult<WorkspaceAttentionSummary> {
    let (input_required, errors, unread): (i64, i64, i64) = connection.query_row(
        "SELECT
            COALESCE(SUM(kind = 'input' AND lifecycle = 'active'), 0),
            COALESCE(SUM(kind = 'error' AND lifecycle = 'active'), 0),
            COALESCE(SUM(kind = 'completion' AND lifecycle = 'active'
                AND (acknowledged_revision IS NULL OR acknowledged_revision != revision)), 0)
         FROM attention_items WHERE workspace_id = ?1",
        [workspace_id.to_string()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let running: i64 = connection.query_row(
        "SELECT COUNT(*) FROM agent_sessions
         WHERE workspace_id = ?1 AND state IN ('running', 'starting', 'reconnecting')",
        [workspace_id.to_string()],
        |row| row.get(0),
    )?;
    let input_required = u64::try_from(input_required).unwrap_or_default();
    let errors = u64::try_from(errors).unwrap_or_default();
    let unread = u64::try_from(unread).unwrap_or_default();
    let running = u64::try_from(running).unwrap_or_default();
    let mut summary = WorkspaceAttentionSummary {
        state: Default::default(),
        input_required,
        errors,
        unread,
        running,
        total: input_required
            .saturating_add(errors)
            .saturating_add(unread)
            .saturating_add(running),
    };
    summary.state = summary.highest_state();
    Ok(summary)
}

fn attention_lifecycle(status: AttentionStatus) -> &'static str {
    match status {
        AttentionStatus::Unread | AttentionStatus::Acknowledged => "active",
        AttentionStatus::Resolved => "resolved",
        AttentionStatus::Expired => "expired",
        AttentionStatus::Superseded => "superseded",
    }
}

fn select_ui_state(
    connection: &Connection,
    workspace_id: WorkspaceId,
) -> CoreResult<Option<WorkspaceUiStateRecord>> {
    connection
        .query_row(
            "SELECT revision, state_json, updated_at FROM workspace_ui_state WHERE workspace_id = ?1",
            [workspace_id.to_string()],
            |row| {
                let state_json: String = row.get(1)?;
                Ok(WorkspaceUiStateRecord {
                    revision: to_u64(row.get(0)?)?,
                    state: parse_json(&state_json)?,
                    updated_at: timestamp_millis(row.get(2)?),
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn parse_workspace_id(value: &str) -> rusqlite::Result<WorkspaceId> {
    WorkspaceId::parse(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn to_u64(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn parse_navigation_target(value: &str) -> rusqlite::Result<WorkspaceNavigationTarget> {
    if let Ok(target) = serde_json::from_str(value) {
        return Ok(target);
    }
    let mut value: Value = parse_json(value)?;
    if let Value::Object(object) = &mut value {
        if let Some(kind) = object.remove("type") {
            object.insert("kind".to_owned(), kind);
        }
        if let Some(input_id) = object.remove("inputId") {
            object.insert("inputRequestId".to_owned(), input_id);
        }
        if let Some(session_id) = object.remove("sessionId") {
            object.insert("reviewSessionId".to_owned(), session_id);
        }
    }
    serde_json::from_value(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn json_string(value: &impl serde::Serialize) -> CoreResult<String> {
    serde_json::to_string(value).map_err(|error| CoreError::Serialization(error.to_string()))
}

fn timestamp_millis(value: i64) -> String {
    chrono::DateTime::from_timestamp_millis(value)
        .unwrap_or(chrono::DateTime::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn default_database_path() -> PathBuf {
    if let Some(path) = std::env::var_os("DIFFUSE_WORKBENCH_DATABASE") {
        return PathBuf::from(path);
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path)
            .join("diffuse")
            .join(DEFAULT_DATABASE_FILE_NAME);
    }
    if cfg!(windows) {
        if let Some(path) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(path)
                .join("Diffuse")
                .join(DEFAULT_DATABASE_FILE_NAME);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            return home
                .join("Library")
                .join("Application Support")
                .join("Diffuse")
                .join(DEFAULT_DATABASE_FILE_NAME);
        }
        return home
            .join(".local")
            .join("share")
            .join("diffuse")
            .join(DEFAULT_DATABASE_FILE_NAME);
    }
    PathBuf::from(DEFAULT_DATABASE_FILE_NAME)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn is_corrupt_database(error: &CoreError) -> bool {
    matches!(error, CoreError::DatabaseCorrupt(_))
        || matches!(
            error,
            CoreError::Database(rusqlite::Error::SqliteFailure(failure, _))
            if matches!(failure.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
        )
}

fn move_corrupt_database(path: &Path) -> CoreResult<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEFAULT_DATABASE_FILE_NAME);
    let backup = path.with_file_name(format!("{file_name}.corrupt-{}", now_millis()));
    std::fs::rename(path, &backup)?;
    let mut moved_sidecars = Vec::new();

    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = path.with_file_name(format!("{file_name}{suffix}"));
        if sidecar.exists() {
            let backup_name = backup
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(file_name);
            let sidecar_backup = backup.with_file_name(format!("{backup_name}{suffix}"));
            if let Err(error) = std::fs::rename(&sidecar, &sidecar_backup) {
                for (moved_backup, original) in moved_sidecars.into_iter().rev() {
                    let _ = std::fs::rename(moved_backup, original);
                }
                let _ = std::fs::rename(&backup, path);
                return Err(error.into());
            }
            moved_sidecars.push((sidecar_backup, sidecar));
        }
    }
    Ok(backup)
}

fn open_database_lock(path: &Path) -> CoreResult<File> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEFAULT_DATABASE_FILE_NAME);
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_file_name(format!("{file_name}.lock")))?)
}

#[cfg(windows)]
fn null_device() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn null_device() -> &'static str {
    "/dev/null"
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Seek, SeekFrom, Write};
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;

    const LOCK_CHILD_PATH_ENV: &str = "DIFFUSE_TEST_DATABASE_LOCK_CHILD_PATH";
    const LOCK_CHILD_EXPECT_ACQUIRED_ENV: &str = "DIFFUSE_TEST_DATABASE_LOCK_CHILD_EXPECT_ACQUIRED";
    const LOCK_CHILD_TEST: &str = "database::tests::database_lock_child_process";
    const LOCK_CHILD_SUCCESS_MARKER: &str = "diffuse-database-lock-child-complete";

    fn workspace(database: &WorkbenchDatabase, root: &str) -> (WorkspaceId, WorkspaceGeneration) {
        let generation = WorkspaceGeneration::new();
        let id = database
            .open_workspace(root, root, root.trim_start_matches('/'), generation)
            .unwrap()
            .id;
        (id, generation)
    }

    fn attention_request(
        workspace_id: WorkspaceId,
        generation: WorkspaceGeneration,
        source_id: &str,
        kind: AttentionKind,
        revision: u64,
    ) -> CreateAttentionRequest {
        CreateAttentionRequest {
            id: None,
            workspace_id,
            workspace_generation: generation,
            source_id: source_id.to_owned(),
            kind,
            revision,
            status: None,
            target: WorkspaceNavigationTarget::Workspace,
        }
    }

    fn input_request(
        workspace_id: WorkspaceId,
        generation: WorkspaceGeneration,
        id: &str,
        kind: InputRequestKind,
        cancellation_supported: bool,
    ) -> CreateInputRequest {
        CreateInputRequest {
            id: Some(id.to_owned()),
            workspace_id,
            workspace_generation: generation,
            revision: 1,
            kind,
            prompt: "Choose".to_owned(),
            choices: vec!["Yes".to_owned()],
            cancellation_supported,
            attention_id: None,
            target: None,
        }
    }

    fn attention_at_status(
        database: &WorkbenchDatabase,
        workspace_id: WorkspaceId,
        generation: WorkspaceGeneration,
        source_id: &str,
        kind: AttentionKind,
        status: AttentionStatus,
    ) -> AttentionItem {
        let request = attention_request(workspace_id, generation, source_id, kind, 2);
        let created = database.create_or_revise_attention(&request).unwrap();
        match status {
            AttentionStatus::Unread => created.item,
            AttentionStatus::Acknowledged => {
                database
                    .mutate_attention_revision(workspace_id, &created.item.id, 2, false)
                    .unwrap()
                    .item
            }
            terminal => {
                let mut terminal_request = request;
                terminal_request.status = Some(terminal);
                database
                    .create_or_revise_attention(&terminal_request)
                    .unwrap()
                    .item
            }
        }
    }

    #[test]
    fn migrations_are_idempotent_and_enable_foreign_keys() {
        let database = WorkbenchDatabase::open_in_memory().expect("open database");
        database.migrate().expect("rerun migrations");
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let connection = database.connection.lock().unwrap();
        let enabled: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
        for table in [
            "legacy_import_runs",
            "legacy_import_agents",
            "legacy_import_chats",
            "legacy_import_prompts",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1,
                "missing typed import table {table}"
            );
        }
        for table in [
            "legacy_import_reviews",
            "legacy_import_comments",
            "legacy_import_threads",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0,
                "portable-authority import table must not exist: {table}"
            );
        }
    }

    #[test]
    fn workspace_identity_survives_close_and_reopen() {
        let database = WorkbenchDatabase::open_in_memory().expect("open database");
        let first = database
            .open_workspace("/repo", "/repo", "repo", WorkspaceGeneration::new())
            .unwrap()
            .id;
        database.close_workspace(first).unwrap();
        let second = database
            .open_workspace("/repo", "/repo", "repo", WorkspaceGeneration::new())
            .unwrap()
            .id;
        assert_eq!(first, second);
    }

    #[test]
    fn schema_three_activity_is_migrated_to_normalized_history_and_turns() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, workspace_generation) = workspace(&database, "/old-acp");
        let mut session:crate::acp::SessionSnapshot=serde_json::from_value(json!({"id":"old-session","hostId":"old-host","workspaceId":workspace_id,"workspaceGeneration":workspace_generation,"adapterId":"fake","remoteSessionId":"remote","capabilities":{},"state":"running","turnId":"old-turn","permissionPolicy":"deny-all"})).unwrap();
        database
            .claim_acp_session(&session.id, workspace_id, workspace_generation, "test")
            .unwrap();
        database
            .record_acp_activity(&session, "test", "turn-started", json!({"text":"hello"}))
            .unwrap();
        database.record_acp_activity(&session,"test","session-update",json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer"}})).unwrap();
        session.state = crate::acp::SessionState::Ready;
        database
            .record_acp_activity(
                &session,
                "test",
                "turn-ended",
                json!({"stopReason":"end_turn"}),
            )
            .unwrap();
        database.connection.lock().unwrap().execute_batch("DROP TABLE acp_input_delivery; DROP TABLE acp_turns; DROP TABLE acp_history; DROP TABLE acp_replay_history; DROP TABLE acp_adapters; DROP TABLE acp_session_incarnations; DROP TABLE acp_legacy_quoted_scopes; DELETE FROM schema_migrations WHERE version>=4;").unwrap();
        database.migrate().unwrap();
        database.migrate().unwrap();
        let history = database.acp_history(workspace_id, &session.id, 0).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].kind, "user-message");
        assert_eq!(history[1].kind, "agent-message");
        let turns = database.acp_turns(workspace_id, &session.id).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].state, "completed");
        assert_eq!(turns[0].stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(
            database.acp_sessions(workspace_id).unwrap()[0].permission_policy,
            "deny-all"
        );
    }

    #[test]
    fn legacy_git_quoted_scopes_cannot_be_reinterpreted_as_literal_file_permissions() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, workspace_generation) = workspace(&database, "/quoted-scope");
        let quoted = "\"line\\nname.txt\"";
        let session = |id: &str, files: Value| {
            serde_json::from_value::<crate::acp::SessionSnapshot>(json!({"id":id,"hostId":"host","workspaceId":workspace_id,"workspaceGeneration":workspace_generation,"adapterId":"fake","remoteSessionId":null,"capabilities":{},"state":"closed","turnId":null,"permissionPolicy":"deny-all","reviewSessionId":"review","reviewFileIds":files})).unwrap()
        };
        for snapshot in [
            session("legacy-quoted", json!([quoted])),
            session("ordinary", json!(["*.txt"])),
            session("whole", Value::Null),
        ] {
            database
                .claim_acp_session(&snapshot.id, workspace_id, workspace_generation, "test")
                .unwrap();
            database
                .record_acp_activity(&snapshot, "test", "session-starting", json!({}))
                .unwrap();
        }
        database.connection.lock().unwrap().execute_batch("DROP TABLE acp_legacy_quoted_scopes; DELETE FROM schema_migrations WHERE version=7;").unwrap();
        database.migrate().unwrap();
        database.migrate().unwrap();
        assert!(
            database
                .ensure_current_acp_file_ids(workspace_id, "legacy-quoted")
                .is_err()
        );
        assert!(
            database
                .ensure_current_acp_file_ids(workspace_id, "ordinary")
                .is_ok()
        );
        assert!(
            database
                .ensure_current_acp_file_ids(workspace_id, "whole")
                .is_ok()
        );
        assert_eq!(
            database
                .acp_sessions(workspace_id)
                .unwrap()
                .into_iter()
                .find(|s| s.id == "legacy-quoted")
                .unwrap()
                .review_file_ids,
            Some(vec![quoted.into()])
        );
        // Newly selected literal quote/backslash filenames are still supported.
        let current = session("current-literal", json!([quoted]));
        database
            .claim_acp_session(&current.id, workspace_id, workspace_generation, "new")
            .unwrap();
        database
            .record_acp_activity(&current, "new", "session-starting", json!({}))
            .unwrap();
        assert!(
            database
                .ensure_current_acp_file_ids(workspace_id, &current.id)
                .is_ok()
        );
    }

    #[test]
    fn acp_input_delivery_is_claimed_once_and_only_the_producer_confirms_it() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, workspace_generation) = workspace(&database, "/acp-input");
        let session:crate::acp::SessionSnapshot=serde_json::from_value(json!({"id":"session","hostId":"host","workspaceId":workspace_id,"workspaceGeneration":workspace_generation,"adapterId":"fake","remoteSessionId":"remote","capabilities":{},"state":"ready","turnId":null,"permissionPolicy":"interactive"})).unwrap();
        database
            .claim_acp_session(&session.id, workspace_id, workspace_generation, "test")
            .unwrap();
        database
            .record_acp_activity(&session, "test", "session-starting", json!({}))
            .unwrap();
        let request = CreateInputRequest {
            id: Some("permission".into()),
            workspace_id,
            workspace_generation,
            revision: 1,
            kind: InputRequestKind::Permission,
            prompt: "Allow read?".into(),
            choices: vec!["allow".into()],
            cancellation_supported: true,
            attention_id: None,
            target: None,
        };
        database
            .create_acp_input(
                &request,
                &session.id,
                &json!({"method":"session/request_permission","params":{"sessionId":"remote"}}),
            )
            .unwrap();
        assert_eq!(database.pending_acp_inputs(workspace_id).unwrap().len(), 1);
        database
            .answer_input(
                workspace_id,
                "permission",
                1,
                InputResponse {
                    value: "allow".into(),
                    secret: None,
                },
                false,
            )
            .unwrap();
        assert!(
            database
                .claim_acp_input(workspace_id, "permission")
                .unwrap()
                .is_some()
        );
        assert!(
            database
                .claim_acp_input(workspace_id, "permission")
                .unwrap()
                .is_none()
        );
        for desired in [InputRequestStatus::Cancelled, InputRequestStatus::Accepted] {
            assert_eq!(
                database
                    .finish_input(workspace_id, "permission", 1, desired)
                    .unwrap()
                    .outcome,
                MutationOutcome::Invalid
            );
        }
        assert_eq!(
            database
                .finish_acp_input(workspace_id, "permission", 1, InputRequestStatus::Accepted)
                .unwrap()
                .outcome,
            MutationOutcome::Applied
        );
        assert!(
            database
                .pending_acp_inputs(workspace_id)
                .unwrap()
                .is_empty()
        );
        let pending = CreateInputRequest {
            id: Some("interrupted".into()),
            ..request
        };
        database
            .create_acp_input(&pending, &session.id, &json!({}))
            .unwrap();
        database.recover_acp_sessions().unwrap();
        assert_eq!(
            database
                .acp_input(workspace_id, "interrupted")
                .unwrap()
                .status,
            InputRequestStatus::Expired
        );
        assert_eq!(
            database
                .acp_input(workspace_id, "permission")
                .unwrap()
                .status,
            InputRequestStatus::Accepted
        );
    }

    #[test]
    fn acp_recovery_is_durable_idempotent_and_generation_fenced() {
        use crate::acp::{SessionSnapshot, SessionState};
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, workspace_generation) = workspace(&database, "/acp");
        let session = SessionSnapshot {
            id: "session".into(),
            host_id: "host".into(),
            workspace_id,
            workspace_generation,
            adapter_id: "fake".into(),
            remote_session_id: Some("remote".into()),
            capabilities: json!({"loadSession":true}),
            state: SessionState::Running,
            turn_id: Some("interrupted-turn".into()),
            permission_policy: "deny-all".into(),
            review_session_id: None,
            review_file_ids: None,
            modes: Value::Null,
            authentication_profile: None,
            history_revision: 0,
            continuity: crate::acp::SessionContinuity::Unknown,
        };
        database
            .claim_acp_session(&session.id, workspace_id, workspace_generation, "test")
            .unwrap();
        database
            .record_acp_activity(&session, "test", "turn-started", json!({"text":"hello"}))
            .unwrap();
        assert_eq!(database.attention_summary(workspace_id).unwrap().running, 1);
        database.recover_acp_sessions().unwrap();
        database.recover_acp_sessions().unwrap();
        assert_eq!(database.attention_summary(workspace_id).unwrap().running, 0);
        let recovered = database.acp_sessions(workspace_id).unwrap();
        assert_eq!(recovered[0].state, SessionState::Failed);
        assert_eq!(recovered[0].remote_session_id, session.remote_session_id);
        let activity = database.acp_activity(workspace_id, &session.id, 0).unwrap();
        assert_eq!(activity.len(), 2);
        assert_eq!(activity[1].turn_id.as_deref(), Some("interrupted-turn"));
        assert_eq!(activity[1].payload["reason"], "application-restarted");
        database.close_workspace(workspace_id).unwrap();
        database
            .open_workspace("/acp", "/acp", "acp", WorkspaceGeneration::new())
            .unwrap();
        assert!(matches!(
            database.record_acp_activity(&session, "test", "stale", json!({})),
            Err(CoreError::StaleWorkspaceGeneration)
        ));
        assert_eq!(
            database
                .acp_activity(workspace_id, &session.id, 0)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn stale_session_incarnation_cannot_overwrite_snapshot_or_cancel_new_turns() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, workspace_generation) = workspace(&database, "/incarnation");
        let mut old:crate::acp::SessionSnapshot=serde_json::from_value(json!({"id":"same-id","hostId":"same-pooled-host","workspaceId":workspace_id,"workspaceGeneration":workspace_generation,"adapterId":"fake","remoteSessionId":"remote","capabilities":{},"state":"ready","turnId":null,"permissionPolicy":"deny-all"})).unwrap();
        database
            .claim_acp_session(&old.id, workspace_id, workspace_generation, "old")
            .unwrap();
        database
            .record_acp_activity(&old, "old", "session-starting", json!({}))
            .unwrap();
        database
            .claim_acp_session(&old.id, workspace_id, workspace_generation, "new")
            .unwrap();
        database
            .record_acp_activity(&old, "new", "session-starting", json!({}))
            .unwrap();
        let queued = database
            .queue_acp_turn(workspace_id, &old.id, "new-request", "new prompt")
            .unwrap();
        old.state = crate::acp::SessionState::Closed;
        assert!(
            database
                .record_acp_activity(&old, "old", "session-ended", json!({}))
                .is_err()
        );
        assert!(database.next_acp_turn(&old.id, "old").is_err());
        assert_eq!(
            database.acp_sessions(workspace_id).unwrap()[0].state,
            crate::acp::SessionState::Ready
        );
        assert_eq!(
            database.acp_turns(workspace_id, &old.id).unwrap()[0].state,
            "queued"
        );
        assert_eq!(
            database.next_acp_turn(&old.id, "new").unwrap().unwrap().id,
            queued.id
        );
    }

    #[test]
    fn active_workspace_can_be_cleared_without_closing_it() {
        let database = WorkbenchDatabase::open_in_memory().expect("open database");
        let workspace = database
            .open_workspace("/repo", "/repo", "repo", WorkspaceGeneration::new())
            .unwrap()
            .id;
        database.activate_workspace(workspace).unwrap();
        let workspace_id = workspace.to_string();
        assert_eq!(
            database.active_workspace_id().unwrap().as_deref(),
            Some(workspace_id.as_str())
        );

        database.deactivate_workspace().unwrap();

        assert_eq!(database.active_workspace_id().unwrap(), None);
    }

    #[test]
    fn restorable_workspace_maps_a_null_active_id_to_false() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, _) = workspace(&database, "/restorable");

        let records = database.restorable_workspaces().unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, workspace_id);
        assert!(!records[0].active);
    }

    #[test]
    fn v1_rows_migrate_to_v2_without_losing_attention_lifecycle() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let workspace_id = WorkspaceId::new();
        let zero_workspace_id = WorkspaceId::new();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(&format!(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations VALUES (1, 0);
             CREATE TABLE workspaces (id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE,
                root TEXT NOT NULL, display_name TEXT NOT NULL, rail_order INTEGER NOT NULL,
                last_opened_at INTEGER NOT NULL, is_open INTEGER NOT NULL DEFAULT 0,
                generation TEXT, load_state TEXT NOT NULL DEFAULT 'closed');
             CREATE TABLE app_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL);
             INSERT INTO app_state VALUES (1, NULL);
             CREATE TABLE workspace_ui_state (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
                version INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                review_session_id TEXT, adapter TEXT NOT NULL, authentication_profile TEXT,
                remote_session_id TEXT, capabilities_json TEXT NOT NULL DEFAULT '{{}}', state TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE input_requests (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                agent_session_id TEXT REFERENCES agent_sessions(id), revision INTEGER NOT NULL, kind TEXT NOT NULL,
                status TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE attention_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                source_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
                target_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                UNIQUE(workspace_id, source_id, kind));
             INSERT INTO workspaces VALUES ('{workspace_id}', '/repo', '/repo', 'repo', 0, 0, 1, NULL, 'ready');
             INSERT INTO workspaces VALUES ('{zero_workspace_id}', '/zero', '/zero', 'zero', 1, 0, 1, NULL, 'ready');
              INSERT INTO attention_items VALUES
                ('old', '{workspace_id}', 'source', 'error', 4, 'acknowledged', '{{\"type\":\"workspace\"}}', 1, 2),
                ('input-attention', '{workspace_id}', 'input-one', 'input', 1, 'unread',
                 '{{\"type\":\"input\",\"inputRequestId\":\"input-one\"}}', 1, 2),
                 ('bad-attention', '{workspace_id}', 'bad', 'error', 1, 'unread', 'not-json', 1, 2),
                 ('zero-attention', '{zero_workspace_id}', 'zero-input', 'input', 0, 'unread',
                  '{{\"type\":\"input\",\"inputRequestId\":\"zero-input\"}}', 1, 2);
              INSERT INTO input_requests VALUES
                ('input-one', '{workspace_id}', NULL, 1, 'question', 'pending',
                 '{{\"prompt\":\"Continue?\",\"choices\":[],\"cancellationSupported\":false,\"attentionId\":\"input-attention\"}}',
                 NULL, 1, 2),
                 ('bad-input', '{workspace_id}', NULL, 1, 'question', 'pending', '{{}}', NULL, 1, 2),
                 ('zero-input', '{zero_workspace_id}', NULL, 0, 'question', 'pending',
                   '{{\"prompt\":\"Invalid\",\"choices\":[],\"cancellationSupported\":false,\"attentionId\":\"zero-attention\"}}',
                  NULL, 1, 2);
               INSERT INTO workspace_ui_state VALUES
                 ('{workspace_id}', 7, '{{\"route\":\"review\"}}', 3),
                 ('{zero_workspace_id}', 0, '{{\"route\":\"invalid\"}}', 3);"
        )).unwrap();
        drop(connection);

        let database = WorkbenchDatabase::open(&path).unwrap();

        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let items = database.attention_items().unwrap();
        let item = items.iter().find(|item| item.id == "old").unwrap();
        assert_eq!(item.status, AttentionStatus::Acknowledged);
        assert!(!items.iter().any(|item| item.id == "bad-attention"));
        assert_eq!(
            database.input_requests().unwrap()[0].attention_id,
            "input-attention"
        );
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM attention_item_quarantine",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM input_request_quarantine", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM workspace_ui_state_quarantine",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(connection);
        assert_eq!(
            database.workspace_ui_states().unwrap()[&workspace_id.to_string()].revision,
            7
        );
    }

    #[test]
    fn attention_acknowledgement_and_notification_are_exact_revision_cas() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, generation) = workspace(&database, "/attention");
        let first = database
            .create_or_revise_attention(&attention_request(
                workspace_id,
                generation,
                "job",
                AttentionKind::Completion,
                1,
            ))
            .unwrap();
        assert_eq!(first.outcome, MutationOutcome::Applied);
        assert_eq!(first.summary.unread, 1);

        assert!(matches!(
            database.mutate_attention_revision(workspace_id, &first.item.id, 0, false),
            Err(CoreError::InvalidParams(_))
        ));
        let acknowledged = database
            .mutate_attention_revision(workspace_id, &first.item.id, 1, false)
            .unwrap();
        assert_eq!(acknowledged.item.status, AttentionStatus::Acknowledged);
        assert_eq!(acknowledged.summary.unread, 0);
        assert_eq!(
            database
                .mutate_attention_revision(workspace_id, &first.item.id, 1, false)
                .unwrap()
                .outcome,
            MutationOutcome::Unchanged
        );
        assert_eq!(
            database
                .mutate_attention_revision(workspace_id, &first.item.id, 1, true)
                .unwrap()
                .outcome,
            MutationOutcome::Applied
        );
        assert_eq!(
            database
                .mutate_attention_revision(workspace_id, &first.item.id, 1, true)
                .unwrap()
                .outcome,
            MutationOutcome::Unchanged
        );

        let revised = database
            .create_or_revise_attention(&attention_request(
                workspace_id,
                generation,
                "job",
                AttentionKind::Completion,
                2,
            ))
            .unwrap();
        assert_eq!(revised.item.status, AttentionStatus::Unread);
        assert_eq!(revised.summary.unread, 1);
        assert_eq!(
            database
                .mutate_attention_revision(workspace_id, &first.item.id, 1, false)
                .unwrap()
                .outcome,
            MutationOutcome::Stale
        );

        let mut resolved_request = attention_request(
            workspace_id,
            generation,
            "job",
            AttentionKind::Completion,
            2,
        );
        resolved_request.status = Some(AttentionStatus::Resolved);
        let resolved = database
            .create_or_revise_attention(&resolved_request)
            .unwrap();
        assert_eq!(resolved.outcome, MutationOutcome::Applied);
        assert_eq!(resolved.item.status, AttentionStatus::Resolved);
        assert_eq!(resolved.summary.unread, 0);
        assert_eq!(
            database
                .create_or_revise_attention(&resolved_request)
                .unwrap()
                .outcome,
            MutationOutcome::Unchanged
        );
        assert_eq!(
            database
                .mutate_attention_revision(workspace_id, &first.item.id, 2, false)
                .unwrap()
                .outcome,
            MutationOutcome::Invalid
        );
    }

    #[test]
    fn acknowledgement_and_notification_truth_tables_cover_every_kind_and_status() {
        let kinds = [
            AttentionKind::Input,
            AttentionKind::Error,
            AttentionKind::Completion,
        ];
        let statuses = [
            AttentionStatus::Unread,
            AttentionStatus::Acknowledged,
            AttentionStatus::Resolved,
            AttentionStatus::Expired,
            AttentionStatus::Superseded,
        ];

        for (kind_index, kind) in kinds.into_iter().enumerate() {
            for (status_index, status) in statuses.into_iter().enumerate() {
                let database = WorkbenchDatabase::open_in_memory().unwrap();
                let (workspace_id, generation) =
                    workspace(&database, &format!("/ack-{kind_index}-{status_index}"));
                let item = attention_at_status(
                    &database,
                    workspace_id,
                    generation,
                    "ack-source",
                    kind,
                    status,
                );
                for expected_revision in [1, 3] {
                    assert_eq!(
                        database
                            .mutate_attention_revision(
                                workspace_id,
                                &item.id,
                                expected_revision,
                                false,
                            )
                            .unwrap()
                            .outcome,
                        MutationOutcome::Stale
                    );
                }
                let acknowledged = database
                    .mutate_attention_revision(workspace_id, &item.id, 2, false)
                    .unwrap();
                let expected = match status {
                    AttentionStatus::Unread => MutationOutcome::Applied,
                    AttentionStatus::Acknowledged => MutationOutcome::Unchanged,
                    AttentionStatus::Resolved
                    | AttentionStatus::Expired
                    | AttentionStatus::Superseded => MutationOutcome::Invalid,
                };
                assert_eq!(acknowledged.outcome, expected);
                if !status.is_terminal() {
                    assert_eq!(acknowledged.item.status, AttentionStatus::Acknowledged);
                    assert_eq!(
                        acknowledged.summary.input_required,
                        u64::from(kind == AttentionKind::Input)
                    );
                    assert_eq!(
                        acknowledged.summary.errors,
                        u64::from(kind == AttentionKind::Error)
                    );
                    assert_eq!(
                        acknowledged.summary.state,
                        match kind {
                            AttentionKind::Input => crate::WorkspaceAttentionState::InputRequired,
                            AttentionKind::Error => crate::WorkspaceAttentionState::Error,
                            AttentionKind::Completion => crate::WorkspaceAttentionState::Idle,
                        }
                    );
                }

                let notification_database = WorkbenchDatabase::open_in_memory().unwrap();
                let (notification_workspace_id, notification_generation) = workspace(
                    &notification_database,
                    &format!("/notification-{kind_index}-{status_index}"),
                );
                let notification_item = attention_at_status(
                    &notification_database,
                    notification_workspace_id,
                    notification_generation,
                    "notification-source",
                    kind,
                    status,
                );
                for expected_revision in [1, 3] {
                    assert_eq!(
                        notification_database
                            .mutate_attention_revision(
                                notification_workspace_id,
                                &notification_item.id,
                                expected_revision,
                                true,
                            )
                            .unwrap()
                            .outcome,
                        MutationOutcome::Stale
                    );
                }
                let first_claim = notification_database
                    .mutate_attention_revision(
                        notification_workspace_id,
                        &notification_item.id,
                        2,
                        true,
                    )
                    .unwrap();
                assert_eq!(
                    first_claim.outcome,
                    if status.is_terminal() {
                        MutationOutcome::Invalid
                    } else {
                        MutationOutcome::Applied
                    }
                );
                if !status.is_terminal() {
                    assert_eq!(first_claim.item.status, status);
                    assert_eq!(
                        notification_database
                            .mutate_attention_revision(
                                notification_workspace_id,
                                &notification_item.id,
                                2,
                                true,
                            )
                            .unwrap()
                            .outcome,
                        MutationOutcome::Unchanged
                    );
                }
            }
        }
    }

    #[test]
    fn separate_database_connections_cannot_acknowledge_a_newer_revision() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let first = WorkbenchDatabase::open(&path).unwrap();
        let (workspace_id, generation) = workspace(&first, "/race");
        let created = first
            .create_or_revise_attention(&attention_request(
                workspace_id,
                generation,
                "race",
                AttentionKind::Completion,
                1,
            ))
            .unwrap();
        let second = WorkbenchDatabase::open(&path).unwrap();
        second
            .create_or_revise_attention(&attention_request(
                workspace_id,
                generation,
                "race",
                AttentionKind::Completion,
                2,
            ))
            .unwrap();

        let stale = first
            .mutate_attention_revision(workspace_id, &created.item.id, 1, false)
            .unwrap();

        assert_eq!(stale.outcome, MutationOutcome::Stale);
        assert_eq!(stale.item.revision, 2);
        assert_eq!(stale.item.status, AttentionStatus::Unread);
    }

    #[test]
    fn input_transitions_are_distinct_and_terminal_updates_are_atomic() {
        for (name, terminal, needs_answer, attention_status) in [
            (
                "accept",
                InputRequestStatus::Accepted,
                true,
                AttentionStatus::Resolved,
            ),
            (
                "reject",
                InputRequestStatus::Rejected,
                true,
                AttentionStatus::Resolved,
            ),
            (
                "cancel",
                InputRequestStatus::Cancelled,
                false,
                AttentionStatus::Resolved,
            ),
            (
                "expire",
                InputRequestStatus::Expired,
                false,
                AttentionStatus::Expired,
            ),
            (
                "supersede",
                InputRequestStatus::Superseded,
                false,
                AttentionStatus::Superseded,
            ),
        ] {
            let database = WorkbenchDatabase::open_in_memory().unwrap();
            let (workspace_id, generation) = workspace(&database, &format!("/{name}"));
            let created = database
                .create_input(&input_request(
                    workspace_id,
                    generation,
                    name,
                    InputRequestKind::Permission,
                    true,
                ))
                .unwrap();
            assert_eq!(created.summary.input_required, 1);
            let acknowledged = database
                .mutate_attention_revision(
                    workspace_id,
                    &created.attention.as_ref().unwrap().id,
                    1,
                    false,
                )
                .unwrap();
            assert_eq!(acknowledged.item.status, AttentionStatus::Acknowledged);
            assert_eq!(acknowledged.summary.input_required, 1);
            let revision = if needs_answer {
                let answered = database
                    .answer_input(
                        workspace_id,
                        name,
                        1,
                        InputResponse {
                            value: "yes".to_owned(),
                            secret: None,
                        },
                        false,
                    )
                    .unwrap();
                assert_eq!(answered.input.status, InputRequestStatus::ResponseSubmitted);
                assert_eq!(answered.input.revision, 1);
                assert_eq!(answered.summary.input_required, 1);
                answered.input.revision
            } else {
                1
            };
            let result = database
                .finish_input(workspace_id, name, revision, terminal)
                .unwrap();
            assert_eq!(result.outcome, MutationOutcome::Applied);
            assert_eq!(result.input.status, terminal);
            assert_eq!(result.input.revision, 1);
            assert_eq!(result.attention.unwrap().status, attention_status);
            assert_eq!(result.summary.input_required, 0);
        }
    }

    #[test]
    fn unsupported_cancel_is_invalid_and_authentication_responses_are_redacted() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, generation) = workspace(&database, "/redaction");
        database
            .create_input(&input_request(
                workspace_id,
                generation,
                "auth",
                InputRequestKind::Authentication,
                false,
            ))
            .unwrap();
        let cancelled = database
            .finish_input(workspace_id, "auth", 1, InputRequestStatus::Cancelled)
            .unwrap();
        assert_eq!(cancelled.outcome, MutationOutcome::Invalid);
        let answered = database
            .answer_input(
                workspace_id,
                "auth",
                1,
                InputResponse {
                    value: "secret".to_owned(),
                    secret: Some(true),
                },
                false,
            )
            .unwrap();
        assert_eq!(
            answered.input.response,
            Some(InputResponse {
                value: String::new(),
                secret: Some(true),
            })
        );
        assert_eq!(
            database.input_requests().unwrap()[0].response,
            Some(InputResponse {
                value: String::new(),
                secret: Some(true),
            })
        );
    }

    #[test]
    fn provider_input_revisions_require_exact_replays_or_the_next_revision() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, generation) = workspace(&database, "/input-revisions");
        let request = input_request(
            workspace_id,
            generation,
            "input",
            InputRequestKind::Question,
            false,
        );
        database.create_input(&request).unwrap();

        let replay = database.create_input(&request).unwrap();
        assert_eq!(replay.outcome, MutationOutcome::Unchanged);
        let mut changed = request.clone();
        changed.prompt = "Different".to_owned();
        assert_eq!(
            database.create_input(&changed).unwrap().outcome,
            MutationOutcome::Invalid
        );
        changed.revision = 3;
        assert_eq!(
            database.create_input(&changed).unwrap().outcome,
            MutationOutcome::Invalid
        );
        changed.revision = 2;
        let revised = database.create_input(&changed).unwrap();
        assert_eq!(revised.outcome, MutationOutcome::Applied);
        assert_eq!(revised.input.revision, 2);
    }

    #[test]
    fn attention_summary_uses_absolute_counts_and_priority() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (workspace_id, generation) = workspace(&database, "/summary");
        for (source, kind) in [
            ("completion", AttentionKind::Completion),
            ("error", AttentionKind::Error),
            ("input", AttentionKind::Input),
        ] {
            database
                .create_or_revise_attention(&attention_request(
                    workspace_id,
                    generation,
                    source,
                    kind,
                    1,
                ))
                .unwrap();
        }
        let summary = database.attention_summary(workspace_id).unwrap();
        assert_eq!(summary.state, crate::WorkspaceAttentionState::InputRequired);
        assert_eq!(
            (summary.input_required, summary.errors, summary.unread),
            (1, 1, 1)
        );
        assert_eq!(summary.total, 3);

        database
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO agent_sessions(
                    id, workspace_id, adapter, capabilities_json, state, created_at, updated_at
                 ) VALUES ('running', ?1, 'test', '{}', 'running', 0, 0)",
                [workspace_id.to_string()],
            )
            .unwrap();
        let items = database.attention_items().unwrap();
        for item in items {
            database
                .mutate_attention_revision(workspace_id, &item.id, item.revision, false)
                .unwrap();
        }
        let acknowledged = database.attention_summary(workspace_id).unwrap();
        assert_eq!(acknowledged.input_required, 1);
        assert_eq!(acknowledged.errors, 1);
        assert_eq!(acknowledged.unread, 0);
        assert_eq!(acknowledged.running, 1);
        assert_eq!(acknowledged.total, 3);
        assert_eq!(
            acknowledged.state,
            crate::WorkspaceAttentionState::InputRequired
        );
    }

    #[test]
    fn rail_order_and_ui_state_cas_persist() {
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let (first, _) = workspace(&database, "/first");
        let (second, _) = workspace(&database, "/second");
        database.reorder_workspaces(&[second, first]).unwrap();
        assert_eq!(
            database.ordered_open_workspace_ids().unwrap(),
            [second, first]
        );
        database.close_workspace(second).unwrap();
        let reopened = database
            .open_workspace("/second", "/second", "second", WorkspaceGeneration::new())
            .unwrap();
        assert_eq!(reopened.id, second);
        assert_eq!(
            database.ordered_open_workspace_ids().unwrap(),
            [first, second]
        );

        let created = database
            .save_workspace_ui_state(first, 0, json!({ "route": "review" }))
            .unwrap();
        assert_eq!(created.outcome, MutationOutcome::Applied);
        let stale = database
            .save_workspace_ui_state(first, 0, json!({ "route": "agent" }))
            .unwrap();
        assert_eq!(stale.outcome, MutationOutcome::Stale);
        let updated = database
            .save_workspace_ui_state(first, 1, json!({ "route": "agent" }))
            .unwrap();
        assert_eq!(updated.record.revision, 2);
    }

    #[test]
    fn corrupt_data_page_is_preserved_and_recreated() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let (page_size, root_page) = create_multi_page_database(&path);
        let page_offset = (root_page - 1) * page_size;
        overwrite_bytes(&path, page_offset, &[0]);
        let corrupted = fs::read(&path).unwrap();

        let database = WorkbenchDatabase::open(&path).expect("recover corrupt database");
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let workspace_count: i64 = database
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(workspace_count, 0);
        assert_eq!(
            fs::read(corrupt_backup_path(temp.path())).unwrap(),
            corrupted
        );
    }

    #[test]
    fn corrupt_header_segment_is_preserved_and_recreated() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        create_multi_page_database(&path);
        overwrite_bytes(&path, 0, b"broken");
        let corrupted = fs::read(&path).unwrap();

        let database = WorkbenchDatabase::open(&path).expect("recover corrupt database");
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            fs::read(corrupt_backup_path(temp.path())).unwrap(),
            corrupted
        );
    }

    #[test]
    fn future_schema_version_is_rejected_without_replacement() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (8, 0);
                 CREATE TABLE future_data (value TEXT NOT NULL);
                 INSERT INTO future_data(value) VALUES ('preserve me');",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            WorkbenchDatabase::open(&path),
            Err(CoreError::UnsupportedDatabaseVersion(8))
        ));
        assert_no_corrupt_backup(temp.path());
        let connection = Connection::open(&path).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM future_data", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "preserve me");
    }

    #[test]
    fn migration_failure_is_rejected_without_replacement() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                 );
                 CREATE TABLE workspaces (marker TEXT NOT NULL);
                 INSERT INTO workspaces(marker) VALUES ('preserve me');",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            WorkbenchDatabase::open(&path),
            Err(CoreError::Database(_))
        ));
        assert_no_corrupt_backup(temp.path());
        let connection = Connection::open(&path).unwrap();
        let marker: String = connection
            .query_row("SELECT marker FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker, "preserve me");
    }

    #[test]
    fn corrupt_database_is_not_replaced_while_an_active_user_holds_the_lock() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        fs::write(&path, b"not a sqlite database").unwrap();
        let active_lock = open_database_lock(&path).unwrap();
        FileExt::lock_shared(&active_lock).unwrap();

        assert!(WorkbenchDatabase::open(&path).is_err());
        assert!(
            !fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        );
    }

    #[test]
    fn database_retains_its_shared_lock_for_its_loaded_lifetime() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let database = WorkbenchDatabase::open(&path).unwrap();
        let exclusive = open_database_lock(&path).unwrap();

        assert!(FileExt::try_lock_exclusive(&exclusive).is_err());
        drop((exclusive, database));
    }

    #[test]
    fn database_shared_lock_blocks_a_child_process_for_its_loaded_lifetime() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let database = WorkbenchDatabase::open(&path).unwrap();

        run_lock_child(&path, false);
        drop(database);
        run_lock_child(&path, true);
    }

    #[test]
    fn database_lock_child_process() {
        let Some(path) = std::env::var_os(LOCK_CHILD_PATH_ENV) else {
            return;
        };
        let expected_acquired = std::env::var_os(LOCK_CHILD_EXPECT_ACQUIRED_ENV)
            .expect("child lock expectation")
            == "true";
        let lock = open_database_lock(Path::new(&path)).expect("open child database lock");
        let acquired = FileExt::try_lock_exclusive(&lock).is_ok();

        assert_eq!(
            acquired, expected_acquired,
            "child exclusive lock acquisition did not match expectation"
        );
        if acquired {
            FileExt::unlock(&lock).expect("unlock child database lock");
        }
        println!("{LOCK_CHILD_SUCCESS_MARKER}");
    }

    #[test]
    fn moving_corrupt_database_preserves_sidecars() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        let (page_size, root_page) = create_multi_page_database(&path);
        overwrite_bytes(&path, (root_page - 1) * page_size, &[0]);
        let sidecars = [
            ("-wal", b"wal contents".as_slice()),
            ("-shm", b"shm contents".as_slice()),
            ("-journal", b"journal contents".as_slice()),
        ];
        for (suffix, contents) in sidecars {
            fs::write(sidecar_path(&path, suffix), contents).unwrap();
        }

        let backup = move_corrupt_database(&path).unwrap();

        assert!(!path.exists());
        for (suffix, contents) in sidecars {
            assert!(!sidecar_path(&path, suffix).exists());
            assert_eq!(fs::read(sidecar_path(&backup, suffix)).unwrap(), contents);
        }
    }

    fn create_multi_page_database(path: &Path) -> (usize, usize) {
        let database = WorkbenchDatabase::open(path).unwrap();
        let mut connection = database.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        for index in 0..256 {
            transaction
                .execute(
                    "INSERT INTO workspaces(
                        id, canonical_root, root, display_name, rail_order, last_opened_at,
                        is_open, generation, load_state
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, NULL, 'closed')",
                    params![
                        format!("workspace-{index}"),
                        format!("/canonical/{index}"),
                        format!("/root/{index}"),
                        format!("workspace-{index}-{}", "x".repeat(512)),
                        index,
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
        let page_size = connection
            .query_row("PRAGMA page_size", [], |row| row.get::<_, usize>(0))
            .unwrap();
        let page_count = connection
            .query_row("PRAGMA page_count", [], |row| row.get::<_, usize>(0))
            .unwrap();
        let root_page = connection
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name = 'workspaces'",
                [],
                |row| row.get::<_, usize>(0),
            )
            .unwrap();
        assert!(page_count > 8, "test database must span multiple pages");
        assert!(
            root_page > 1,
            "workspaces root must not share the file header"
        );
        drop(connection);
        let lock = database.into_lock();
        FileExt::unlock(&lock).unwrap();
        drop(lock);
        (page_size, root_page)
    }

    fn run_lock_child(path: &Path, expected_acquired: bool) {
        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args(["--exact", LOCK_CHILD_TEST, "--nocapture"])
            .env(LOCK_CHILD_PATH_ENV, path)
            .env(
                LOCK_CHILD_EXPECT_ACQUIRED_ENV,
                expected_acquired.to_string(),
            )
            .output()
            .expect("run database lock child process");

        assert!(
            output.status.success(),
            "database lock child failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(LOCK_CHILD_SUCCESS_MARKER),
            "database lock child test did not run\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn overwrite_bytes(path: &Path, offset: usize, bytes: &[u8]) {
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start(offset.try_into().unwrap()))
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    fn corrupt_backup_path(directory: &Path) -> PathBuf {
        let prefix = format!("{DEFAULT_DATABASE_FILE_NAME}.corrupt-");
        fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .find_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                let timestamp = name.strip_prefix(&prefix)?;
                timestamp
                    .chars()
                    .all(|character| character.is_ascii_digit())
                    .then(|| entry.path())
            })
            .expect("corrupt database backup")
    }

    fn assert_no_corrupt_backup(directory: &Path) {
        assert!(
            fs::read_dir(directory)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().contains(".corrupt-"))
        );
    }

    fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
        let file_name = path.file_name().unwrap().to_string_lossy();
        path.with_file_name(format!("{file_name}{suffix}"))
    }
}
