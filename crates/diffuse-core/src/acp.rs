//! ACP v1 sessions, durable turns and input delivery. Workspace-local host pools
//! multiplex only explicitly opted-in adapter configurations.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::acp_transport::{Host, HostSession, Incoming, Wire};
use crate::workspace::WorkspaceRuntime;
use crate::{CoreError, CoreResult, EventHub, WorkbenchDatabase, WorkspaceGeneration, WorkspaceId};

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);

/// Explicit executable and environment only: no shell, inherited environment,
/// automatic permission grants, or client filesystem/terminal capabilities.
/// The executable remains trusted code; ACP permission denial is not an OS sandbox.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterConfig {
    pub id: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

/// Persistable invocation metadata. Credentials are resolved from explicitly
/// named environment variables at launch, never stored in the database.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterDefinition {
    pub id: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub environment_keys: Vec<String>,
    #[serde(default)]
    pub authentication_profile: Option<String>,
    #[serde(default)]
    pub multiplex: bool,
}

impl AdapterDefinition {
    pub fn validate(&self) -> CoreResult<()> {
        if self.id.is_empty()
            || self.id.len() > 256
            || self.id.contains('\0')
            || self
                .authentication_profile
                .as_ref()
                .is_some_and(|p| p.is_empty() || p.len() > 256 || p.contains('\0'))
            || !self.executable.is_absolute()
            || self.args.len() > 128
            || self.args.iter().any(|s| s.len() > 4096 || s.contains('\0'))
            || self.environment_keys.len() > 128
            || self
                .environment_keys
                .iter()
                .any(|s| s.is_empty() || s.len() > 256 || s.contains(['=', '\0']))
        {
            return Err(CoreError::InvalidParams(
                "invalid ACP adapter definition".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn invocation(&self) -> CoreResult<AdapterConfig> {
        self.validate()?;
        Ok(AdapterConfig {
            id: self.id.clone(),
            executable: self.executable.clone(),
            args: self.args.clone(),
            environment: self
                .environment_keys
                .iter()
                .filter_map(|key| std::env::var(key).ok().map(|value| (key.clone(), value)))
                .collect(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDiscovery {
    pub adapter: AdapterDefinition,
    pub available: bool,
    pub platform_supported: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub id: String,
    pub session_id: String,
    pub request_id: String,
    pub text: String,
    pub state: String,
    pub stop_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sequence: u64,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub content: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenSessionRequest {
    pub context: crate::WorkspaceRequestContext,
    pub adapter_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub review_session_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_review_file_ids")]
    pub review_file_ids: Option<Vec<String>>,
    #[serde(default)]
    pub interactive: bool,
}

pub const MAX_REVIEW_FILE_IDS: usize = 1024;
pub const MAX_REVIEW_FILE_ID_BYTES: usize = 4096;
pub const MAX_REVIEW_SCOPE_BYTES: usize = 128 * 1024;

pub(crate) fn validate_review_file_ids(ids: &[String]) -> CoreResult<()> {
    if ids.is_empty()
        || ids.len() > MAX_REVIEW_FILE_IDS
        || ids
            .iter()
            .any(|id| id.is_empty() || id.len() > MAX_REVIEW_FILE_ID_BYTES || id.contains('\0'))
        || ids.iter().map(String::len).sum::<usize>() > MAX_REVIEW_SCOPE_BYTES
        || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
    {
        return Err(CoreError::InvalidParams(
            "reviewFileIds must be a nonempty, unique, bounded list of changed-file IDs".into(),
        ));
    }
    Ok(())
}

fn deserialize_review_file_ids<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    let ids = Vec::<String>::deserialize(deserializer)?;
    validate_review_file_ids(&ids).map_err(serde::de::Error::custom)?;
    Ok(Some(ids))
}

impl OpenSessionRequest {
    pub fn validate(&self) -> CoreResult<()> {
        if let Some(ids) = &self.review_file_ids {
            validate_review_file_ids(ids)?;
            if self.review_session_id.is_none() {
                return Err(CoreError::InvalidParams(
                    "reviewFileIds requires reviewSessionId".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Starting,
    Ready,
    Running,
    Failed,
    Closed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionContinuity {
    #[default]
    Unknown,
    New,
    Resumed,
    Loaded,
    Reset,
}

impl SessionState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub host_id: String,
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub adapter_id: String,
    pub remote_session_id: Option<String>,
    pub capabilities: Value,
    pub state: SessionState,
    pub turn_id: Option<String>,
    pub permission_policy: String,
    #[serde(default)]
    pub review_session_id: Option<String>,
    /// Immutable canonical changed-file IDs. Absence preserves whole-review scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_file_ids: Option<Vec<String>>,
    #[serde(default)]
    pub modes: Value,
    #[serde(default)]
    pub authentication_profile: Option<String>,
    #[serde(default)]
    pub history_revision: u64,
    #[serde(default)]
    pub continuity: SessionContinuity,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub sequence: u64,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

struct Handle {
    prompt: mpsc::Sender<String>,
    cancel: watch::Sender<bool>,
    stop: watch::Sender<bool>,
    // 0 starting, 1 ready, 2 prompt, 3 terminal, 4 queue claim, 5 mode change.
    state: Arc<AtomicU8>,
    mode: mpsc::Sender<ModeCommand>,
    wake: Arc<tokio::sync::Notify>,
    done: Arc<AtomicBool>,
}
struct WorkerCompletion(Arc<AtomicBool>);
impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct ModeCommand {
    mode_id: String,
    result: std::sync::mpsc::SyncSender<CoreResult<Value>>,
}

#[derive(Default)]
pub(crate) struct AgentManager {
    handles: Mutex<HashMap<String, Handle>>,
    hosts: Mutex<HashMap<String, Vec<Weak<Host>>>>,
}

#[derive(Default)]
pub(crate) struct SessionLaunch {
    pub previous: Option<SessionSnapshot>,
    pub multiplex: bool,
    pub authentication_profile: Option<String>,
}

fn error(message: impl Into<String>) -> CoreError {
    CoreError::TaskFailed(format!("ACP: {}", message.into()))
}

impl AgentManager {
    fn acquire_host(
        &self,
        adapter: &AdapterConfig,
        cwd: &str,
        multiplex: bool,
        profile: Option<&str>,
    ) -> CoreResult<HostSession> {
        let mut hosts = self.hosts.lock().expect("ACP pool poisoned");
        hosts.retain(|_, entries| {
            entries.retain(|h| h.strong_count() != 0);
            !entries.is_empty()
        });
        let key = serde_json::to_string(&(adapter, profile)).map_err(|e| error(e.to_string()))?;
        let existing: Vec<_> = hosts
            .get(&key)
            .into_iter()
            .flatten()
            .filter_map(Weak::upgrade)
            .collect();
        if multiplex {
            for host in &existing {
                if host.alive() {
                    if let Some(session) = host.reserve() {
                        drop(hosts);
                        drop(existing);
                        return Ok(session);
                    }
                }
            }
        }
        // Host::spawn only starts the dispatcher thread; process I/O runs there.
        let result = Host::spawn(adapter.clone(), cwd.to_owned());
        if let Ok(host) = &result {
            if multiplex {
                hosts.entry(key).or_default().push(Arc::downgrade(host));
            }
        }
        drop(hosts);
        drop(existing); // Last host references may join a process supervisor.
        result.map(|host| host.reserve().expect("new host has capacity"))
    }
    pub(crate) fn start(
        &self,
        runtime: &Arc<WorkspaceRuntime>,
        adapter: AdapterConfig,
        database: WorkbenchDatabase,
        events: Arc<EventHub>,
        phase5_gate: Arc<Mutex<()>>,
    ) -> CoreResult<String> {
        self.start_session(
            runtime,
            adapter,
            database,
            events,
            phase5_gate,
            SessionLaunch::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_session(
        &self,
        runtime: &Arc<WorkspaceRuntime>,
        adapter: AdapterConfig,
        database: WorkbenchDatabase,
        events: Arc<EventHub>,
        phase5_gate: Arc<Mutex<()>>,
        launch: SessionLaunch,
    ) -> CoreResult<String> {
        let mut previous = launch.previous;
        if !cfg!(any(unix, windows)) {
            return Err(error(
                "ACP host process-tree containment is not supported on this platform",
            ));
        }
        if adapter.id.is_empty() || adapter.id.len() > 256 || !adapter.executable.is_absolute() {
            return Err(CoreError::InvalidParams(
                "ACP requires an adapter ID and absolute executable".into(),
            ));
        }
        let mut handles = self.handles.lock().expect("ACP manager poisoned");
        let permit = runtime.acquire_background_operation()?;
        handles.retain(|_, handle| !handle.done.load(Ordering::Acquire));
        let id = previous
            .as_ref()
            .map(|s| s.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if handles.contains_key(&id) {
            return Err(error("session already live"));
        }
        let (prompt, prompts) = mpsc::channel(1);
        let (mode, modes) = mpsc::channel(1);
        let (cancel, cancellations) = watch::channel(false);
        let reset_cancel = cancel.clone();
        let (stop, mut stopping) = watch::channel(false);
        let state = Arc::new(AtomicU8::new(0));
        let wake = Arc::new(tokio::sync::Notify::new());
        let done = Arc::new(AtomicBool::new(false));
        handles.insert(
            id.clone(),
            Handle {
                prompt,
                cancel,
                stop,
                state: state.clone(),
                mode,
                wake: wake.clone(),
                done: done.clone(),
            },
        );
        drop(handles);
        let incarnation = uuid::Uuid::new_v4().to_string();
        if let Err(error) =
            database.claim_acp_session(&id, runtime.id, runtime.generation, &incarnation)
        {
            state.store(3, Ordering::Release);
            done.store(true, Ordering::Release);
            return Err(error);
        }
        // The caller may have read its snapshot while the old worker was still
        // finishing. Refresh only after reserving the now-complete local ID.
        if previous.is_some() {
            match database.acp_sessions(runtime.id) {
                Ok(sessions) => {
                    if let Some(latest) = sessions.into_iter().find(|s| s.id == id) {
                        previous = Some(latest);
                    }
                }
                Err(error) => {
                    state.store(3, Ordering::Release);
                    done.store(true, Ordering::Release);
                    return Err(error);
                }
            }
        }
        let host = match self.acquire_host(
            &adapter,
            &runtime.canonical_root,
            launch.multiplex,
            launch.authentication_profile.as_deref(),
        ) {
            Ok(host) => host,
            Err(error) => {
                state.store(3, Ordering::Release);
                done.store(true, Ordering::Release);
                return Err(error);
            }
        };
        let snapshot = SessionSnapshot {
            id: id.clone(),
            host_id: host.id.clone(),
            workspace_id: runtime.id,
            workspace_generation: runtime.generation,
            adapter_id: adapter.id.clone(),
            remote_session_id: previous.as_ref().and_then(|s| s.remote_session_id.clone()),
            capabilities: json!({}),
            state: SessionState::Starting,
            turn_id: None,
            permission_policy: previous
                .as_ref()
                .map(|s| s.permission_policy.clone())
                .unwrap_or_else(|| "deny-all".into()),
            review_session_id: previous.as_ref().and_then(|s| s.review_session_id.clone()),
            review_file_ids: previous.as_ref().and_then(|s| s.review_file_ids.clone()),
            modes: previous
                .as_ref()
                .map(|s| s.modes.clone())
                .unwrap_or(Value::Null),
            authentication_profile: launch.authentication_profile,
            history_revision: previous.as_ref().map(|s| s.history_revision).unwrap_or(0),
            continuity: SessionContinuity::Unknown,
        };
        let worker_state = state.clone();
        let cwd = runtime.canonical_root.clone();
        let workspace = Arc::downgrade(runtime);
        let recovered_error_source = previous
            .as_ref()
            .filter(|s| s.state == SessionState::Failed)
            .map(|s| format!("acp-session:{}:{}", s.id, s.host_id));
        let worker_done = done.clone();
        std::thread::Builder::new()
            .name("diffuse-acp".into())
            .spawn(move || {
                // This guard drops after both worker resources and its lifetime
                // permit, not when a terminal event is merely published.
                let _completion = WorkerCompletion(worker_done);
                let _permit = permit;
                let mut worker = Worker {
                    snapshot,
                    database,
                    events,
                    state: worker_state,
                    prompts,
                    cancellations,
                    workspace,
                    phase5_gate,
                    host: Some(host),
                    reset_cancel,
                    inputs: HashMap::new(),
                    mcp: None,
                    modes,
                    wake,
                    recovered_error_source,
                    loading: false,
                    incarnation,
                };
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match result {
                    Ok(executor) => executor.block_on(async {
                        let outcome = worker.run(cwd, &mut stopping).await;
                        worker.host.take();
                        worker.snapshot.state = if outcome.is_ok() {
                            SessionState::Closed
                        } else {
                            SessionState::Failed
                        };
                        let payload = match outcome {
                            Ok(()) => json!({"reason":"host-stopped"}),
                            Err(e) => json!({"error":e.to_string()}),
                        };
                        let _ = worker.record("session-ended", payload);
                    }),
                    Err(e) => {
                        worker.snapshot.state = SessionState::Failed;
                        let _ = worker.record("session-ended", json!({"error":e.to_string()}));
                    }
                }
                worker.state.store(3, Ordering::Release);
            })
            .inspect_err(|_| {
                state.store(3, Ordering::Release);
                done.store(true, Ordering::Release);
            })?;
        Ok(id)
    }

    pub(crate) fn prompt(&self, id: &str, text: String) -> CoreResult<()> {
        if text.len() > MAX_MESSAGE_BYTES / 8 {
            return Err(CoreError::InvalidParams("ACP prompt exceeds limit".into()));
        }
        let handles = self.handles.lock().expect("ACP manager poisoned");
        let handle = handles.get(id).ok_or_else(|| error("unknown session"))?;
        if *handle.stop.borrow() {
            return Err(error("session is stopping"));
        }
        handle
            .state
            .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| error("session not ready"))?;
        handle.cancel.send_replace(false);
        if handle.prompt.try_send(text).is_err() {
            handle.state.store(3, Ordering::Release);
            return Err(error("host disconnected"));
        }
        Ok(())
    }

    pub(crate) fn require_live(&self, id: &str) -> CoreResult<()> {
        let handles = self.handles.lock().expect("ACP manager poisoned");
        if handles
            .get(id)
            .is_none_or(|h| h.state.load(Ordering::Acquire) == 3 || *h.stop.borrow())
        {
            return Err(error("session is not live"));
        }
        Ok(())
    }

    pub(crate) fn wake(&self, id: &str) {
        if let Some(handle) = self.handles.lock().expect("ACP manager poisoned").get(id) {
            handle.wake.notify_one();
        }
    }
    pub(crate) fn wake_inputs(&self) {
        for handle in self.handles.lock().expect("ACP manager poisoned").values() {
            handle.wake.notify_one();
        }
    }

    pub(crate) fn request_mode(
        &self,
        id: &str,
        mode_id: &str,
    ) -> CoreResult<std::sync::mpsc::Receiver<CoreResult<Value>>> {
        if mode_id.is_empty() || mode_id.len() > 256 {
            return Err(CoreError::InvalidParams("invalid modeId".into()));
        }
        let (result, receiver) = std::sync::mpsc::sync_channel(1);
        {
            let handles = self.handles.lock().expect("ACP manager poisoned");
            let handle = handles.get(id).ok_or_else(|| error("unknown session"))?;
            if *handle.stop.borrow() {
                return Err(error("session is stopping"));
            }
            handle
                .state
                .compare_exchange(1, 5, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| error("mode changes require an idle session"))?;
            if handle
                .mode
                .try_send(ModeCommand {
                    mode_id: mode_id.into(),
                    result,
                })
                .is_err()
            {
                handle.state.store(3, Ordering::Release);
                return Err(error("session disconnected"));
            }
        }
        Ok(receiver)
    }

    pub(crate) fn cancel(&self, id: &str) -> CoreResult<()> {
        let handles = self.handles.lock().expect("ACP manager poisoned");
        let handle = handles.get(id).ok_or_else(|| error("unknown session"))?;
        if handle.state.load(Ordering::Acquire) == 2 {
            handle.cancel.send_replace(true);
        }
        Ok(())
    }

    pub(crate) fn stop_all(&self) {
        for (_, handle) in self.handles.lock().expect("ACP manager poisoned").drain() {
            handle.stop.send_replace(true);
        }
    }

    pub(crate) fn stop(&self, id: &str) -> CoreResult<()> {
        let handles = self.handles.lock().expect("ACP manager poisoned");
        let handle = handles.get(id).ok_or_else(|| error("unknown session"))?;
        handle.state.store(3, Ordering::Release);
        handle.stop.send_replace(true);
        Ok(())
    }
}

impl Drop for AgentManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

struct Worker {
    incarnation: String,
    loading: bool,
    recovered_error_source: Option<String>,
    wake: Arc<tokio::sync::Notify>,
    modes: mpsc::Receiver<ModeCommand>,
    mcp: Option<crate::acp_mcp::Server>,
    inputs: HashMap<String, PendingInput>,
    host: Option<HostSession>,
    reset_cancel: watch::Sender<bool>,
    phase5_gate: Arc<Mutex<()>>,
    workspace: Weak<WorkspaceRuntime>,
    snapshot: SessionSnapshot,
    database: WorkbenchDatabase,
    events: Arc<EventHub>,
    state: Arc<AtomicU8>,
    prompts: mpsc::Receiver<String>,
    cancellations: watch::Receiver<bool>,
}

struct PendingInput {
    peer_id: Value,
    request_ticket: u64,
    method: String,
    params: Value,
    delivered: bool,
}

impl Worker {
    fn record(&self, kind: &str, payload: Value) -> CoreResult<()> {
        // Share the snapshot/mutation boundary with AppCore. Enqueue absolute
        // summaries in commit order, but never hold this gate during delivery.
        let gate = self
            .phase5_gate
            .lock()
            .expect("phase 5 coordination lock poisoned");
        let commit = self.database.record_acp_activity(
            &self.snapshot,
            &self.incarnation,
            kind,
            payload.clone(),
        )?;
        let attention = if (kind == "turn-ended" && payload["stopReason"] != "cancelled")
            || (kind == "session-ended" && self.snapshot.state == SessionState::Failed)
        {
            Some(
                self.database
                    .create_or_revise_attention(&crate::CreateAttentionRequest {
                        id: None,
                        workspace_id: self.snapshot.workspace_id,
                        workspace_generation: self.snapshot.workspace_generation,
                        source_id: if kind == "turn-ended" {
                            format!(
                                "acp:{}",
                                self.snapshot
                                    .turn_id
                                    .as_deref()
                                    .unwrap_or(&self.snapshot.id)
                            )
                        } else {
                            format!("acp-session:{}:{}", self.snapshot.id, self.snapshot.host_id)
                        },
                        kind: if kind == "turn-ended" {
                            crate::AttentionKind::Completion
                        } else {
                            crate::AttentionKind::Error
                        },
                        revision: 1,
                        status: None,
                        target: crate::WorkspaceNavigationTarget::Agent {
                            agent_session_id: self.snapshot.id.clone(),
                        },
                    })?,
            )
        } else {
            None
        };
        if matches!(kind, "session-ready" | "turn-ended") {
            let previous = if kind == "session-ready" { 0 } else { 2 };
            let _ = self
                .state
                .compare_exchange(previous, 1, Ordering::AcqRel, Ordering::Acquire);
        } else if kind == "session-ended" {
            self.state.store(3, Ordering::Release);
        }
        let repaired = if kind == "session-ready" {
            if let Some(source) = &self.recovered_error_source {
                if let Some(item) = self.database.attention_items()?.into_iter().find(|i| {
                    i.workspace_id == self.snapshot.workspace_id
                        && i.source_id == *source
                        && i.kind == crate::AttentionKind::Error
                }) {
                    Some(self.database.create_or_revise_attention(
                        &crate::CreateAttentionRequest {
                            id: Some(item.id),
                            workspace_id: self.snapshot.workspace_id,
                            workspace_generation: self.snapshot.workspace_generation,
                            source_id: source.clone(),
                            kind: crate::AttentionKind::Error,
                            revision: item.revision + 1,
                            status: Some(crate::AttentionStatus::Resolved),
                            target: item.target,
                        },
                    )?)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        let scope = Some((
            self.snapshot.workspace_id,
            self.snapshot.workspace_generation,
        ));
        let summary = if let Some(workspace) = self.workspace.upgrade() {
            let mut summary = workspace.summary();
            summary.attention = self
                .database
                .attention_summary(self.snapshot.workspace_id)?;
            Some(summary)
        } else {
            None
        };
        let mut queued = vec![self.events.enqueue(
            "acp/activity",
            scope,
            json!({"session":self.snapshot,"activity":commit.activity}),
        )];
        if matches!(
            kind,
            "session-starting"
                | "session-ready"
                | "session-ended"
                | "host-initialized"
                | "continuity-lost"
        ) {
            queued.push(
                self.events
                    .enqueue("agent/sessionChanged", scope, json!(self.snapshot)),
            );
        }
        if kind == "history-replaced" {
            queued.push(self.events.enqueue("agent/historyReplaced",scope,json!({"sessionId":self.snapshot.id,"historyRevision":self.snapshot.history_revision})));
        }
        for turn in commit.turns {
            queued.push(self.events.enqueue("agent/turnChanged", scope, json!(turn)));
        }
        if kind == "session-update" {
            let event = match payload["sessionUpdate"].as_str() {
                Some("agent_message_chunk" | "user_message_chunk") => "agent/messageDelta",
                Some("tool_call" | "tool_call_update") => "agent/toolCallChanged",
                Some("plan") => "agent/planChanged",
                Some("current_mode_update") => "agent/modeChanged",
                _ => "agent/activity",
            };
            queued.push(self.events.enqueue(event,scope,json!({"sessionId":self.snapshot.id,"turnId":self.snapshot.turn_id,"update":payload})));
        }
        if let Some(attention) = attention {
            queued.push(self.events.enqueue(
                "workspace/attentionChanged",
                scope,
                json!({"item":attention.item,"summary":summary}),
            ));
        }
        if let Some(repaired) = repaired {
            queued.push(self.events.enqueue(
                "workspace/attentionChanged",
                scope,
                json!({"item":repaired.item,"summary":summary}),
            ));
        }
        if let Some(summary) = summary {
            queued.push(
                self.events
                    .enqueue("workspace/summaryChanged", scope, json!(summary)),
            );
        }
        drop(gate);
        for event in queued {
            self.events.deliver(event);
        }
        Ok(())
    }

    async fn run(&mut self, cwd: String, stopping: &mut watch::Receiver<bool>) -> CoreResult<()> {
        self.record("session-starting", json!({}))?;
        if *stopping.borrow() {
            return Ok(());
        }
        let mut wire = Wire::new(self.host.take().expect("worker host"));
        let outcome = tokio::select! {
            biased;
            _ = stopping.wait_for(|stop| *stop) => Ok(()),
            result = self.conversation(&mut wire, &cwd) => result,
        };
        if let Some(mcp) = &mut self.mcp {
            mcp.close().await;
        }
        wire.close(
            self.snapshot.remote_session_id.as_deref(),
            &self.snapshot.capabilities,
        )
        .await;
        self.finish_inputs(crate::InputRequestStatus::Expired)?;
        outcome
    }

    async fn conversation(&mut self, wire: &mut Wire, cwd: &str) -> CoreResult<()> {
        wire.send(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"diffuse","version":crate::VERSION}}})).await?;
        let initialized = tokio::time::timeout(IO_TIMEOUT, self.response(wire, 0))
            .await
            .map_err(|_| error("initialize deadline exceeded"))??;
        if initialized["protocolVersion"] != 1 {
            return Err(error("unsupported protocol version"));
        }
        // ACP defaults an omitted capability object to no optional capabilities.
        self.snapshot.capabilities = initialized
            .get("agentCapabilities")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !self.snapshot.capabilities.is_object() {
            return Err(error("invalid capabilities"));
        }
        self.record("host-initialized", json!({"protocolVersion":1}))?;
        let mut params = json!({"cwd":cwd,"mcpServers":[]});
        if let Some(review) = &self.snapshot.review_session_id {
            if self.snapshot.capabilities["mcpCapabilities"]["http"] != true {
                return Err(error("review tools require ACP mcpCapabilities.http"));
            }
            let database = self.database.clone();
            let gate = self.phase5_gate.clone();
            let events = self.events.clone();
            let workspace = self.workspace.clone();
            let session_id = self.snapshot.id.clone();
            let incarnation = self.incarnation.clone();
            let record_activity: crate::acp_mcp::ActivityRecorder = Arc::new(
                move |turn, message| {
                    let workspace = workspace.upgrade().ok_or(CoreError::WorkspaceClosing)?;
                    let locked = gate.lock().expect("phase 5 gate poisoned");
                    let session = database
                        .acp_sessions(workspace.id)?
                        .into_iter()
                        .find(|s| s.id == session_id)
                        .ok_or_else(|| error("missing agent session"))?;
                    if session.turn_id.as_deref() != Some(turn)
                        || session.state != SessionState::Running
                    {
                        return Err(error("stale agent turn"));
                    }
                    let activity = database.record_acp_activity(
                        &session,
                        &incarnation,
                        "agent-activity",
                        json!({"message":message}),
                    )?;
                    let event=events.enqueue("agent/activity",Some((workspace.id,workspace.generation)),json!({"sessionId":session_id,"turnId":turn,"message":message,"activitySequence":activity.activity.sequence}));
                    drop(locked);
                    events.deliver(event);
                    Ok(())
                },
            );
            let mcp = crate::acp_mcp::Server::start(
                self.workspace.clone(),
                crate::acp_mcp::ReviewScope {
                    session_id: review.clone(),
                    file_ids: self
                        .snapshot
                        .review_file_ids
                        .as_ref()
                        .map(|ids| ids.iter().cloned().collect()),
                },
                self.events.clone(),
                record_activity,
            )
            .await?;
            params["mcpServers"] = json!([mcp.descriptor]);
            self.mcp = Some(mcp);
        }
        let method = if let Some(remote) = &self.snapshot.remote_session_id {
            if self.snapshot.capabilities["sessionCapabilities"]["resume"].is_object() {
                params["sessionId"] = json!(remote);
                "session/resume"
            } else if self.snapshot.capabilities["loadSession"] == true {
                params["sessionId"] = json!(remote);
                "session/load"
            } else {
                self.snapshot.continuity = SessionContinuity::Reset;
                self.record("continuity-lost", json!({"reason":"resume-unsupported"}))?;
                self.snapshot.remote_session_id = None;
                "session/new"
            }
        } else {
            "session/new"
        };
        self.loading = method == "session/load";
        wire.send(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .await?;
        let created = tokio::time::timeout(IO_TIMEOUT, self.response(wire, 1))
            .await
            .map_err(|_| error("session/new deadline exceeded"))??;
        if method == "session/new" {
            self.snapshot.remote_session_id = Some(
                created["sessionId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| error("missing sessionId"))?
                    .to_owned(),
            );
            if self.snapshot.continuity != SessionContinuity::Reset {
                self.snapshot.continuity = SessionContinuity::New;
            }
        } else if method == "session/load" {
            self.snapshot.continuity = SessionContinuity::Loaded;
        } else {
            self.snapshot.continuity = SessionContinuity::Resumed;
        }
        if self.loading {
            self.snapshot.history_revision += 1;
            self.record(
                "history-replaced",
                json!({"historyRevision":self.snapshot.history_revision}),
            )?;
            self.loading = false;
        }
        self.snapshot.state = SessionState::Ready;
        self.finish_inputs(crate::InputRequestStatus::Accepted)?;
        if let Some(modes) = created.get("modes") {
            if !modes.is_null() && !modes.is_object() {
                return Err(error("invalid session modes"));
            }
            self.snapshot.modes = modes.clone();
        }
        self.record("session-ready", created)?;
        let mut request_id = 2_u64;
        let wake = self.wake.clone();
        loop {
            if let Ok(command) = self.modes.try_recv() {
                self.change_mode(wire, command, request_id).await?;
                request_id += 1;
                continue;
            }
            let (queued, event) = {
                let _gate = self.phase5_gate.lock().expect("phase 5 gate poisoned");
                let queued = if self
                    .state
                    .compare_exchange(1, 4, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    let queued = self
                        .database
                        .next_acp_turn(&self.snapshot.id, &self.incarnation)?;
                    let _ = self.state.compare_exchange(
                        4,
                        if queued.is_some() { 2 } else { 1 },
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                    queued
                } else {
                    None
                };
                let event = queued.as_ref().map(|turn| {
                    self.events.enqueue(
                        "agent/turnChanged",
                        Some((
                            self.snapshot.workspace_id,
                            self.snapshot.workspace_generation,
                        )),
                        json!(turn),
                    )
                });
                (queued, event)
            };
            if let Some(event) = event {
                self.events.deliver(event);
            }
            let (turn_id, text) = if let Some(turn) = queued {
                (turn.id, turn.text)
            } else {
                tokio::select! {
                    command = self.modes.recv() => {if let Some(command)=command {self.change_mode(wire,command,request_id).await?;request_id+=1;}continue;},
                    text = self.prompts.recv() => match text { Some(text) => (uuid::Uuid::new_v4().to_string(), text), None => return Ok(()) },
                    message = wire.receive() => { self.notification(wire, message?).await?; continue; }
                    _ = wake.notified() => continue,
                }
            };
            self.state.store(2, Ordering::Release);
            self.cancellations.borrow_and_update();
            self.snapshot.state = SessionState::Running;
            self.snapshot.turn_id = Some(turn_id);
            self.record("turn-started", json!({"text":text}))?;
            if let Some(mcp) = &self.mcp {
                mcp.turn.start(self.snapshot.turn_id.clone());
            }
            wire.send(json!({"jsonrpc":"2.0","id":request_id,"method":"session/prompt","params":{"sessionId":self.snapshot.remote_session_id,"prompt":[{"type":"text","text":text}]}})).await?;
            let mut cancelled = false;
            let deadline = tokio::time::sleep(TURN_TIMEOUT);
            tokio::pin!(deadline);
            let result = loop {
                tokio::select! {
                    biased;
                    _ = async { let _ = self.cancellations.wait_for(|value| *value).await; }, if !cancelled => {
                        self.cancel_inputs(wire).await?;
                        wire.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.snapshot.remote_session_id}})).await?;
                        cancelled = true;
                        deadline.as_mut().reset(tokio::time::Instant::now() + CANCEL_TIMEOUT);
                        self.record("cancel-requested", json!({}))?;
                    }
                    _ = &mut deadline => return Err(error(if cancelled { "cancel deadline exceeded" } else { "turn deadline exceeded" })),
                    _ = wake.notified() => self.deliver_inputs(wire).await?,
                    message = wire.receive() => {
                        let message = message?;
                        if message.value.get("method").is_none() {
                            break response_result(message.value, request_id)?;
                        }
                        self.notification(wire, message).await?;
                    }
                }
            };
            let reason = result["stopReason"]
                .as_str()
                .ok_or_else(|| error("missing stopReason"))?;
            if !matches!(
                reason,
                "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
            ) {
                return Err(error("invalid stopReason"));
            }
            self.snapshot.state = SessionState::Ready;
            if let Some(mcp) = &self.mcp {
                mcp.turn.end().await;
            }
            self.finish_inputs(crate::InputRequestStatus::Accepted)?;
            self.reset_cancel.send_replace(false);
            self.record("turn-ended", json!({"stopReason":reason}))?;
            request_id += 1;
        }
    }

    async fn response(&mut self, wire: &mut Wire, id: u64) -> CoreResult<Value> {
        let wake = self.wake.clone();
        loop {
            let message = tokio::select! {
                message=wire.receive()=>message?,
                _=wake.notified()=>{self.deliver_inputs(wire).await?;continue;}
            };
            if message.value.get("method").is_none() {
                return response_result(message.value, id);
            }
            self.notification(wire, message).await?;
        }
    }

    async fn notification(&mut self, wire: &mut Wire, incoming: Incoming) -> CoreResult<()> {
        let message = incoming.value;
        let method = message["method"]
            .as_str()
            .ok_or_else(|| error("unexpected response"))?;
        if method == "$/cancel_request" && message.get("id").is_none() {
            let requested = &message["params"]["requestId"];
            if let Some(id) = self
                .inputs
                .iter()
                .find(|(_, p)| p.peer_id == *requested && Some(p.request_ticket) == incoming.ticket)
                .map(|(id, _)| id.clone())
            {
                self.inputs.remove(&id);
                let event = {
                    let _gate = self.phase5_gate.lock().expect("phase 5 gate poisoned");
                    let input = self.database.acp_input(self.snapshot.workspace_id, &id)?;
                    let result = self.database.finish_acp_input(
                        self.snapshot.workspace_id,
                        &id,
                        input.revision,
                        crate::InputRequestStatus::Cancelled,
                    )?;
                    self.events.enqueue(
                        "input/resolved",
                        Some((
                            self.snapshot.workspace_id,
                            self.snapshot.workspace_generation,
                        )),
                        json!(result.input),
                    )
                };
                self.events.deliver(event);
                self.record("input-cancelled", json!({"inputId":id}))?;
            }
            return Ok(());
        }
        if let Some(id) = message.get("id") {
            let request_scoped = method == "elicitation/create"
                && message["params"]["requestId"].is_number()
                && message["params"].get("sessionId").is_none();
            if !request_scoped
                && message["params"]["sessionId"].as_str()
                    != self.snapshot.remote_session_id.as_deref()
            {
                return Err(error("request for foreign session"));
            }
            if (method == "session/request_permission"
                && self.snapshot.permission_policy == "interactive")
                || (method == "elicitation/create" && message["params"]["mode"] == "form")
            {
                let request_ticket = incoming
                    .ticket
                    .ok_or_else(|| error("missing input request ticket"))?;
                if self.inputs.len() >= 16 {
                    return Err(error("too many pending inputs"));
                }
                // Answered requests remain here until producer confirmation.
                // A reused peer ID with a new dispatcher ticket is a new input,
                // even when its parameters are identical to an earlier request.
                if let Some(existing) = self
                    .inputs
                    .values()
                    .find(|p| p.peer_id == *id && p.request_ticket == request_ticket)
                {
                    if existing.method == method && existing.params == message["params"] {
                        return Ok(());
                    }
                    return Err(error("conflicting input request ID"));
                }
                let workspace = self
                    .workspace
                    .upgrade()
                    .ok_or(CoreError::WorkspaceClosing)?;
                let _permit = workspace.acquire_operation()?;
                let params = &message["params"];
                let question = method == "elicitation/create";
                let request = crate::CreateInputRequest {
                    id: Some(uuid::Uuid::new_v4().to_string()),
                    workspace_id: self.snapshot.workspace_id,
                    workspace_generation: self.snapshot.workspace_generation,
                    revision: 1,
                    kind: if question {
                        crate::InputRequestKind::Question
                    } else {
                        crate::InputRequestKind::Permission
                    },
                    prompt: if question {
                        params["message"].as_str()
                    } else {
                        params["toolCall"]["title"].as_str()
                    }
                    .unwrap_or("Agent requests input")
                    .into(),
                    choices: if question {
                        vec![]
                    } else {
                        params["options"]
                            .as_array()
                            .ok_or_else(|| error("invalid permission options"))?
                            .iter()
                            .filter_map(|v| v["optionId"].as_str().map(str::to_owned))
                            .collect()
                    },
                    cancellation_supported: true,
                    attention_id: None,
                    target: None,
                };
                request.validate()?;
                let (input, event) = {
                    let _gate = self.phase5_gate.lock().expect("phase 5 gate poisoned");
                    let input = self.database.create_acp_input(
                        &request,
                        &self.snapshot.id,
                        &json!({"method":method,"params":params}),
                    )?;
                    let event = self.events.enqueue("input/requested",Some((self.snapshot.workspace_id,self.snapshot.workspace_generation)),json!({"input":input.input,"sessionId":self.snapshot.id,"method":method,"params":params}));
                    (input.input, event)
                };
                self.events.deliver(event);
                self.record(
                    "input-requested",
                    json!({"input":input,"method":method,"params":params}),
                )?;
                self.inputs.insert(
                    input.id,
                    PendingInput {
                        peer_id: id.clone(),
                        request_ticket,
                        method: method.into(),
                        params: params.clone(),
                        delivered: false,
                    },
                );
                return Ok(());
            }
            // Even allow_always options are never selected. No provider request
            // can access client files, terminals, another session, or user secrets.
            let reply = if method == "session/request_permission" {
                self.record("permission-denied",json!({"toolCallId":message["params"]["toolCall"]["toolCallId"],"reason":"review-policy"}))?;
                json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})
            } else if method == "elicitation/create" {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unsupported elicitation mode"}})
            } else {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client method not supported"}})
            };
            let request_ticket = incoming
                .ticket
                .ok_or_else(|| error("missing agent request ticket"))?;
            wire.send_response(reply, request_ticket).await?;
        } else if method == "session/update" {
            if self.snapshot.remote_session_id.as_deref() != message["params"]["sessionId"].as_str()
                || self.snapshot.remote_session_id.is_none()
            {
                return Err(error("update for foreign session"));
            }
            let update = &message["params"]["update"];
            if !update["sessionUpdate"].is_string() {
                return Err(error("invalid session update"));
            }
            if update["sessionUpdate"] == "agent_thought_chunk" {
                return Ok(());
            }
            if update["sessionUpdate"] == "current_mode_update" {
                self.snapshot.modes["currentModeId"] = update["currentModeId"].clone();
            }
            self.record(
                if self.loading {
                    "session-replay-update"
                } else {
                    "session-update"
                },
                update.clone(),
            )?;
        }
        Ok(())
    }

    async fn change_mode(
        &mut self,
        wire: &mut Wire,
        command: ModeCommand,
        id: u64,
    ) -> CoreResult<()> {
        if !self.snapshot.modes["availableModes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["id"] == command.mode_id)
        {
            self.state.store(1, Ordering::Release);
            let _ = command.result.send(Err(CoreError::InvalidParams(
                "mode was not advertised by this session".into(),
            )));
            return Ok(());
        }
        wire.send(json!({"jsonrpc":"2.0","id":id,"method":"session/set_mode","params":{"sessionId":self.snapshot.remote_session_id,"modeId":command.mode_id}})).await?;
        let response = tokio::time::timeout(IO_TIMEOUT, self.response(wire, id))
            .await
            .map_err(|_| error("mode deadline exceeded"))?;
        if let Err(error) = response {
            let _ = command
                .result
                .send(Err(crate::CoreError::TaskFailed(error.to_string())));
            return Err(error);
        }
        self.snapshot.modes["currentModeId"] = json!(command.mode_id);
        self.finish_inputs(crate::InputRequestStatus::Accepted)?;
        self.record(
            "session-update",
            json!({"sessionUpdate":"current_mode_update","currentModeId":command.mode_id}),
        )?;
        self.state.store(1, Ordering::Release);
        let _ = command.result.send(Ok(json!({"modeId":command.mode_id})));
        Ok(())
    }

    async fn deliver_inputs(&mut self, wire: &mut Wire) -> CoreResult<()> {
        for (id, pending) in &mut self.inputs {
            if pending.delivered {
                continue;
            }
            let input = self.database.acp_input(self.snapshot.workspace_id, id)?;
            let result = if input.status == crate::InputRequestStatus::ResponseSubmitted {
                let claimed = {
                    let _gate = self.phase5_gate.lock().expect("phase 5 gate poisoned");
                    self.database
                        .claim_acp_input(self.snapshot.workspace_id, id)?
                };
                let Some(input) = claimed else {
                    continue;
                };
                let response = input
                    .response
                    .as_ref()
                    .ok_or_else(|| error("missing input response"))?;
                if response.secret == Some(true) {
                    return Err(error(
                        "secret responses are not supported over ACP form input",
                    ));
                }
                input_response(&input, &pending.params, response)?
            } else if input.status.is_terminal() {
                if pending.method == "session/request_permission" {
                    json!({"outcome":{"outcome":"cancelled"}})
                } else {
                    json!({"action":"cancel"})
                }
            } else {
                continue;
            };
            wire.send_response(
                json!({"jsonrpc":"2.0","id":pending.peer_id,"result":result}),
                pending.request_ticket,
            )
            .await?;
            pending.delivered = true;
        }
        Ok(())
    }

    async fn cancel_inputs(&mut self, wire: &mut Wire) -> CoreResult<()> {
        for pending in self.inputs.values_mut().filter(|p| !p.delivered) {
            let result = if pending.method == "session/request_permission" {
                json!({"outcome":{"outcome":"cancelled"}})
            } else {
                json!({"action":"cancel"})
            };
            wire.send_response(
                json!({"jsonrpc":"2.0","id":pending.peer_id,"result":result}),
                pending.request_ticket,
            )
            .await?;
            pending.delivered = true;
        }
        self.finish_inputs(crate::InputRequestStatus::Cancelled)
    }

    fn finish_inputs(&mut self, outcome: crate::InputRequestStatus) -> CoreResult<()> {
        for (id, pending) in self.inputs.drain() {
            let event = {
                let _gate = self.phase5_gate.lock().expect("phase 5 gate poisoned");
                let input = self.database.acp_input(self.snapshot.workspace_id, &id)?;
                if input.status.is_terminal() {
                    continue;
                }
                let desired = if outcome == crate::InputRequestStatus::Accepted
                    && pending.delivered
                    && input.status == crate::InputRequestStatus::ResponseSubmitted
                {
                    crate::InputRequestStatus::Accepted
                } else if outcome == crate::InputRequestStatus::Cancelled {
                    outcome
                } else {
                    crate::InputRequestStatus::Expired
                };
                let result = self.database.finish_acp_input(
                    self.snapshot.workspace_id,
                    &id,
                    input.revision,
                    desired,
                )?;
                self.events.enqueue(
                    "input/resolved",
                    Some((
                        self.snapshot.workspace_id,
                        self.snapshot.workspace_generation,
                    )),
                    json!(result.input),
                )
            };
            self.events.deliver(event);
        }
        Ok(())
    }
}

fn validate_form(schema: &Value, value: &Value) -> CoreResult<()> {
    if schema["type"] != "object" {
        return Err(error("form schema must be an object"));
    }
    let values = value
        .as_object()
        .ok_or_else(|| error("form content must be an object"))?;
    let properties = schema["properties"]
        .as_object()
        .ok_or_else(|| error("invalid form schema"))?;
    if let Some(required) = schema.get("required") {
        for name in required
            .as_array()
            .ok_or_else(|| error("invalid required properties"))?
        {
            let name = name
                .as_str()
                .ok_or_else(|| error("invalid required property"))?;
            if !properties.contains_key(name) || !values.contains_key(name) {
                return Err(error("required form property missing"));
            }
        }
    }
    for (key, value) in values {
        let property = properties
            .get(key)
            .ok_or_else(|| error("unknown form property"))?;
        validate_form_property(property, value, 0)?;
    }
    Ok(())
}

fn validate_form_property(schema: &Value, value: &Value, depth: usize) -> CoreResult<()> {
    if depth > 3 || !schema.is_object() {
        return Err(error("unsupported form schema nesting"));
    }
    let valid = match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => {
            value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|n| n.fract() == 0.0)
        }
        Some("number") => value.is_number(),
        Some("array") => value.is_array(),
        None => ["const", "enum", "oneOf", "anyOf"]
            .iter()
            .any(|key| schema.get(key).is_some()),
        _ => false,
    };
    if !valid {
        return Err(error("invalid form value type"));
    }
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(error("value is not the enum constant"));
        }
    }
    if let Some(options) = schema.get("enum") {
        let options = options.as_array().ok_or_else(|| error("invalid enum"))?;
        if options.is_empty() || options.len() > 256 || !options.contains(value) {
            return Err(error("value is not in enum"));
        }
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(alternatives) = schema.get(key) {
            let alternatives = alternatives
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 256)
                .ok_or_else(|| error("invalid enum alternatives"))?;
            let count = alternatives
                .iter()
                .filter(|choice| validate_form_property(choice, value, depth + 1).is_ok())
                .count();
            if count == 0 || (key == "oneOf" && count != 1) {
                return Err(error("value does not match enum alternatives"));
            }
        }
    }
    let check_length = |length: usize, min: &str, max: &str| -> CoreResult<()> {
        for (key, lower) in [(min, true), (max, false)] {
            if let Some(bound) = schema.get(key) {
                let bound = bound
                    .as_u64()
                    .ok_or_else(|| error("invalid length bound"))?;
                if (lower && (length as u64) < bound) || (!lower && (length as u64) > bound) {
                    return Err(error("form length is out of bounds"));
                }
            }
        }
        Ok(())
    };
    if let Some(text) = value.as_str() {
        check_length(text.chars().count(), "minLength", "maxLength")?;
    }
    if let Some(items) = value.as_array() {
        check_length(items.len(), "minItems", "maxItems")?;
        let schema_items = schema
            .get("items")
            .ok_or_else(|| error("multi-select requires an items schema"))?;
        if schema_items.get("enum").is_none()
            && schema_items.get("oneOf").is_none()
            && schema_items.get("anyOf").is_none()
        {
            return Err(error("multi-select requires enum items"));
        }
        for (index, item) in items.iter().enumerate() {
            if !item.is_string() {
                return Err(error("multi-select values must be strings"));
            }
            validate_form_property(schema_items, item, depth + 1)?;
            if schema["uniqueItems"] == true && items[..index].contains(item) {
                return Err(error("duplicate multi-select value"));
            }
        }
    }
    if value.is_number() {
        for key in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
            if let Some(bound) = schema.get(key) {
                let integer = |v: &Value| {
                    v.as_i64()
                        .map(i128::from)
                        .or_else(|| v.as_u64().map(i128::from))
                };
                let order = if let (Some(a), Some(b)) = (integer(value), integer(bound)) {
                    a.cmp(&b)
                } else {
                    value
                        .as_f64()
                        .zip(bound.as_f64())
                        .and_then(|(a, b)| a.partial_cmp(&b))
                        .ok_or_else(|| error("invalid numeric bound"))?
                };
                let valid = match key {
                    "minimum" => !order.is_lt(),
                    "maximum" => !order.is_gt(),
                    "exclusiveMinimum" => order.is_gt(),
                    _ => order.is_lt(),
                };
                if !valid {
                    return Err(error("form number is out of bounds"));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn input_response(
    input: &crate::InputRequest,
    params: &Value,
    response: &crate::InputResponse,
) -> CoreResult<Value> {
    if response.secret == Some(true) {
        return Err(CoreError::InvalidParams(
            "ACP form inputs cannot contain secrets".into(),
        ));
    }
    if input.kind == crate::InputRequestKind::Permission {
        if !input.choices.contains(&response.value) {
            return Err(CoreError::InvalidParams("unknown permission option".into()));
        }
        return Ok(json!({"outcome":{"outcome":"selected","optionId":response.value}}));
    }
    let value: Value = serde_json::from_str(&response.value).map_err(|_| {
        CoreError::InvalidParams("ACP form response must be a JSON action/content object".into())
    })?;
    match value["action"].as_str() {
        Some("accept") => {
            validate_form(&params["requestedSchema"], &value["content"])
                .map_err(|e| CoreError::InvalidParams(e.to_string()))?;
            Ok(json!({"action":"accept","content":value["content"]}))
        }
        Some("decline") => Ok(json!({"action":"decline"})),
        Some("cancel") => Ok(json!({"action":"cancel"})),
        _ => Err(CoreError::InvalidParams(
            "invalid ACP elicitation action".into(),
        )),
    }
}

fn response_result(message: Value, id: u64) -> CoreResult<Value> {
    if message["id"].as_u64() != Some(id)
        || message.get("result").is_some() == message.get("error").is_some()
    {
        return Err(error("invalid response correlation"));
    }
    if message.get("error").is_some() {
        return Err(error("peer rejected request"));
    }
    Ok(message["result"].clone())
}

#[cfg(test)]
mod form_tests {
    use super::*;
    #[test]
    fn restricted_form_enums_multiselect_and_bounds() {
        let schema = json!({"type":"object","properties":{
            "colors":{"type":"array","items":{"type":"string","enum":["red","blue","green"]},"minItems":1,"maxItems":2,"uniqueItems":true},
            "strategy":{"type":"string","oneOf":[{"const":"safe","title":"Safe"},{"const":"fast","title":"Fast"}]},
            "name":{"type":"string","minLength":2,"maxLength":4},
            "count":{"type":"integer","minimum":1,"maximum":3},
            "ratio":{"type":"number","minimum":0.25,"maximum":0.75}
        },"required":["colors","strategy","name","count","ratio"]});
        let valid = json!({"colors":["red","blue"],"strategy":"safe","name":"\u{e9}\u{e9}","count":3,"ratio":0.25});
        assert!(validate_form(&schema, &valid).is_ok());
        for (key, value) in [
            ("colors", json!([])),
            ("colors", json!(["red", "orange"])),
            ("colors", json!(["red", "red"])),
            ("colors", json!(["red", "blue", "green"])),
            ("colors", json!("red")),
            ("strategy", json!("unlisted")),
            ("name", json!("x")),
            ("name", json!("12345")),
            ("count", json!(0)),
            ("count", json!(4)),
            ("count", json!(1.5)),
            ("ratio", json!(0.249)),
            ("ratio", json!(0.751)),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(
                validate_form(&schema, &invalid).is_err(),
                "accepted {invalid}"
            );
        }
        let titled = json!({"type":"object","properties":{"colors":{"type":"array","items":{"anyOf":[{"const":"red","title":"Red"},{"const":"blue","title":"Blue"}]}}}});
        assert!(validate_form(&titled, &json!({"colors":["blue"]})).is_ok());
        assert!(validate_form(&titled, &json!({"colors":["other"]})).is_err());
        let large = json!({"type":"object","properties":{"n":{"type":"integer","maximum":9007199254740992_u64}}});
        assert!(validate_form(&large, &json!({"n":9007199254740993_u64})).is_err());
    }
}
