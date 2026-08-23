use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior, params};

use crate::{CoreError, CoreResult, WorkspaceGeneration, WorkspaceId};

pub const DEFAULT_DATABASE_FILE_NAME: &str = "workbench.sqlite3";
const CURRENT_SCHEMA_VERSION: i64 = 1;

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
        let lock = open_database_lock(path)?;
        FileExt::lock_shared(&lock)?;
        match Self::open_once(path, lock) {
            Ok(database) => Ok(database),
            Err((error, lock)) if is_corrupt_database(&error) => {
                FileExt::unlock(&lock)?;
                drop(lock);
                let recovery_lock = open_database_lock(path)?;
                FileExt::try_lock_exclusive(&recovery_lock)?;

                // Another process may have recovered the file before the exclusive lock was acquired.
                match Self::open_once(path, recovery_lock) {
                    Ok(database) => {
                        let recovery_lock = database.into_lock();
                        FileExt::unlock(&recovery_lock)?;
                        Self::open(path)
                    }
                    Err((recheck_error, recovery_lock)) if is_corrupt_database(&recheck_error) => {
                        move_corrupt_database(path)?;
                        let database =
                            Self::open_once(path, recovery_lock).map_err(|(error, _)| error)?;
                        let recovery_lock = database.into_lock();
                        FileExt::unlock(&recovery_lock)?;
                        Self::open(path)
                    }
                    Err((recheck_error, _)) => Err(recheck_error),
                }
            }
            Err((error, _)) => Err(error),
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
        match database.migrate() {
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

        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn open_workspace(
        &self,
        canonical_root: &str,
        root: &str,
        display_name: &str,
        generation: WorkspaceGeneration,
    ) -> CoreResult<WorkspaceId> {
        let mut connection = self.connection.lock().expect("database lock poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT id FROM workspaces WHERE canonical_root = ?1",
                [canonical_root],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let id = match &existing {
            Some(id) => WorkspaceId::parse(id).map_err(|_| rusqlite::Error::InvalidQuery)?,
            None => WorkspaceId::new(),
        };

        if existing.is_some() {
            transaction.execute(
                "UPDATE workspaces
                 SET root = ?2, display_name = ?3, last_opened_at = ?4, is_open = 1,
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
                "SELECT COALESCE(MAX(rail_order) + 1, 0) FROM workspaces",
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
        Ok(id)
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
    matches!(
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

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn migrations_are_idempotent_and_enable_foreign_keys() {
        let database = WorkbenchDatabase::open_in_memory().expect("open database");
        database.migrate().expect("rerun migrations");
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let enabled: i64 = database
            .connection
            .lock()
            .unwrap()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[test]
    fn workspace_identity_survives_close_and_reopen() {
        let database = WorkbenchDatabase::open_in_memory().expect("open database");
        let first = database
            .open_workspace("/repo", "/repo", "repo", WorkspaceGeneration::new())
            .unwrap();
        database.close_workspace(first).unwrap();
        let second = database
            .open_workspace("/repo", "/repo", "repo", WorkspaceGeneration::new())
            .unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn corrupt_database_is_preserved_and_recreated() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DEFAULT_DATABASE_FILE_NAME);
        fs::write(&path, b"not a sqlite database").unwrap();

        let database = WorkbenchDatabase::open(&path).expect("recover corrupt database");
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert!(
            fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
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
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, 0);",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            WorkbenchDatabase::open(&path),
            Err(CoreError::UnsupportedDatabaseVersion(2))
        ));
        assert!(
            !fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        );
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
        drop(exclusive);
        drop(database);
        let exclusive = open_database_lock(&path).unwrap();
        FileExt::try_lock_exclusive(&exclusive).unwrap();
        FileExt::unlock(&exclusive).unwrap();
    }
}
