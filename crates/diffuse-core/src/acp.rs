//! Minimal ACP v1 stdio client. Hosts are isolated per session until pooling parity.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

use crate::workspace::WorkspaceRuntime;
use crate::{CoreError, CoreResult, EventHub, WorkbenchDatabase, WorkspaceGeneration, WorkspaceId};

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);

/// Explicit executable and environment only: no shell, inherited environment,
/// automatic permission grants, or client filesystem/terminal capabilities.
/// The executable remains trusted code; ACP permission denial is not an OS sandbox.
#[derive(Clone, Debug)]
pub struct AdapterConfig {
    pub id: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
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
    // Starting, ready, busy, terminal. Admission never waits for external I/O.
    state: Arc<AtomicU8>,
}

#[derive(Default)]
pub(crate) struct AgentManager {
    handles: Mutex<HashMap<String, Handle>>,
}

fn error(message: impl Into<String>) -> CoreError {
    CoreError::TaskFailed(format!("ACP: {}", message.into()))
}

impl AgentManager {
    pub(crate) fn start(
        &self,
        runtime: &Arc<WorkspaceRuntime>,
        adapter: AdapterConfig,
        database: WorkbenchDatabase,
        events: Arc<EventHub>,
        phase5_gate: Arc<Mutex<()>>,
    ) -> CoreResult<String> {
        if !cfg!(unix) {
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
        handles.retain(|_, handle| handle.state.load(Ordering::Acquire) != 3);
        let id = uuid::Uuid::new_v4().to_string();
        let snapshot = SessionSnapshot {
            id: id.clone(),
            host_id: uuid::Uuid::new_v4().to_string(),
            workspace_id: runtime.id,
            workspace_generation: runtime.generation,
            adapter_id: adapter.id.clone(),
            remote_session_id: None,
            capabilities: json!({}),
            state: SessionState::Starting,
            turn_id: None,
            permission_policy: "deny-all".into(),
        };
        let (prompt, prompts) = mpsc::channel(1);
        let (cancel, cancellations) = watch::channel(false);
        let (stop, mut stopping) = watch::channel(false);
        let state = Arc::new(AtomicU8::new(0));
        let worker_state = state.clone();
        let cwd = runtime.canonical_root.clone();
        let workspace = Arc::downgrade(runtime);
        std::thread::Builder::new()
            .name("diffuse-acp".into())
            .spawn(move || {
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
                };
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match result {
                    Ok(executor) => executor.block_on(async {
                        let outcome = worker.run(adapter, cwd, &mut stopping).await;
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
            })?;
        handles.insert(
            id.clone(),
            Handle {
                prompt,
                cancel,
                stop,
                state,
            },
        );
        Ok(id)
    }

    pub(crate) fn prompt(&self, id: &str, text: String) -> CoreResult<()> {
        if text.len() > MAX_MESSAGE_BYTES / 8 {
            return Err(CoreError::InvalidParams("ACP prompt exceeds limit".into()));
        }
        let handles = self.handles.lock().expect("ACP manager poisoned");
        let handle = handles.get(id).ok_or_else(|| error("unknown session"))?;
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

struct Wire {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    buffer: Vec<u8>,
}

impl Wire {
    async fn send(&mut self, value: Value) -> CoreResult<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| error(e.to_string()))?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(error("outgoing message exceeds limit"));
        }
        bytes.push(b'\n');
        tokio::time::timeout(IO_TIMEOUT, self.input.write_all(&bytes))
            .await
            .map_err(|_| error("write deadline exceeded"))??;
        Ok(())
    }

    // Persistent bounded buffer makes this read cancellation-safe in select!.
    async fn receive(&mut self) -> CoreResult<Value> {
        loop {
            let chunk = self.output.fill_buf().await?;
            if chunk.is_empty() {
                return Err(error("host disconnected"));
            }
            let newline = chunk.iter().position(|byte| *byte == b'\n');
            let count = newline.map_or(chunk.len(), |n| n + 1);
            if self.buffer.len() + count > MAX_MESSAGE_BYTES {
                return Err(error("incoming message exceeds limit"));
            }
            self.buffer.extend_from_slice(&chunk[..count]);
            self.output.consume(count);
            if newline.is_some() {
                let value: Value =
                    serde_json::from_slice(&self.buffer).map_err(|_| error("invalid JSON"))?;
                self.buffer.clear();
                if value["jsonrpc"] != "2.0" || !value.is_object() {
                    return Err(error("invalid JSON-RPC envelope"));
                }
                return Ok(value);
            }
        }
    }
}

struct Worker {
    phase5_gate: Arc<Mutex<()>>,
    workspace: Weak<WorkspaceRuntime>,
    snapshot: SessionSnapshot,
    database: WorkbenchDatabase,
    events: Arc<EventHub>,
    state: Arc<AtomicU8>,
    prompts: mpsc::Receiver<String>,
    cancellations: watch::Receiver<bool>,
}

impl Worker {
    fn record(&self, kind: &str, payload: Value) -> CoreResult<()> {
        // Share the snapshot/mutation boundary with AppCore. Enqueue absolute
        // summaries in commit order, but never hold this gate during delivery.
        let gate = self
            .phase5_gate
            .lock()
            .expect("phase 5 coordination lock poisoned");
        let activity = self
            .database
            .record_acp_activity(&self.snapshot, kind, payload)?;
        if matches!(kind, "session-ready" | "turn-ended") {
            let previous = if kind == "session-ready" { 0 } else { 2 };
            let _ = self
                .state
                .compare_exchange(previous, 1, Ordering::AcqRel, Ordering::Acquire);
        } else if kind == "session-ended" {
            self.state.store(3, Ordering::Release);
        }
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
            json!({"session":self.snapshot,"activity":activity}),
        )];
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

    async fn run(
        &mut self,
        adapter: AdapterConfig,
        cwd: String,
        stopping: &mut watch::Receiver<bool>,
    ) -> CoreResult<()> {
        self.record("session-starting", json!({}))?;
        if *stopping.borrow() {
            return Ok(());
        }
        let mut command = Command::new(adapter.executable);
        command
            .args(adapter.args)
            .env_clear()
            .envs(adapter.environment)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn()?;
        #[cfg(unix)]
        let mut group = ProcessGroup(child.id().expect("new child has a PID") as libc::pid_t);
        let mut wire = Wire {
            input: child.stdin.take().expect("piped stdin"),
            output: BufReader::new(child.stdout.take().expect("piped stdout")),
            buffer: Vec::new(),
        };
        let outcome = tokio::select! {
            biased;
            _ = stopping.wait_for(|stop| *stop) => Ok(()),
            result = self.conversation(&mut wire, &cwd) => result,
        };
        #[cfg(unix)]
        group.terminate()?;
        let _ = child.kill().await;
        let _ = child.wait().await;
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
        wire.send(json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await?;
        let created = tokio::time::timeout(IO_TIMEOUT, self.response(wire, 1))
            .await
            .map_err(|_| error("session/new deadline exceeded"))??;
        self.snapshot.remote_session_id = Some(
            created["sessionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| error("missing sessionId"))?
                .to_owned(),
        );
        self.snapshot.state = SessionState::Ready;
        self.record("session-ready", created)?;
        let mut request_id = 2_u64;
        loop {
            let text = tokio::select! {
                text = self.prompts.recv() => match text { Some(text) => text, None => return Ok(()) },
                message = wire.receive() => { self.notification(wire, message?).await?; continue; }
            };
            self.snapshot.state = SessionState::Running;
            self.snapshot.turn_id = Some(uuid::Uuid::new_v4().to_string());
            self.record("turn-started", json!({"text":text}))?;
            wire.send(json!({"jsonrpc":"2.0","id":request_id,"method":"session/prompt","params":{"sessionId":self.snapshot.remote_session_id,"prompt":[{"type":"text","text":text}]}})).await?;
            let mut cancelled = false;
            let deadline = tokio::time::sleep(TURN_TIMEOUT);
            tokio::pin!(deadline);
            let result = loop {
                tokio::select! {
                    biased;
                    _ = async { let _ = self.cancellations.wait_for(|value| *value).await; }, if !cancelled => {
                        wire.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.snapshot.remote_session_id}})).await?;
                        cancelled = true;
                        deadline.as_mut().reset(tokio::time::Instant::now() + CANCEL_TIMEOUT);
                        self.record("cancel-requested", json!({}))?;
                    }
                    _ = &mut deadline => return Err(error(if cancelled { "cancel deadline exceeded" } else { "turn deadline exceeded" })),
                    message = wire.receive() => {
                        let message = message?;
                        if message.get("method").is_none() {
                            break response_result(message, request_id)?;
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
            self.record("turn-ended", json!({"stopReason":reason}))?;
            request_id += 1;
        }
    }

    async fn response(&mut self, wire: &mut Wire, id: u64) -> CoreResult<Value> {
        loop {
            let message = wire.receive().await?;
            if message.get("method").is_none() {
                return response_result(message, id);
            }
            self.notification(wire, message).await?;
        }
    }

    async fn notification(&self, wire: &mut Wire, message: Value) -> CoreResult<()> {
        let method = message["method"]
            .as_str()
            .ok_or_else(|| error("unexpected response"))?;
        if let Some(id) = message.get("id") {
            // Even allow_always options are never selected. No provider request
            // can access client files, terminals, another session, or user secrets.
            let reply = if method == "session/request_permission" {
                json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})
            } else {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client method not supported"}})
            };
            wire.send(reply).await?;
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
            self.record("session-update", update.clone())?;
        }
        Ok(())
    }
}

/// Own the dedicated Unix process group, including descendants that outlive
/// the adapter. This is lifecycle containment, not a sandbox against setsid().
#[cfg(unix)]
struct ProcessGroup(libc::pid_t);

#[cfg(unix)]
impl ProcessGroup {
    fn terminate(&mut self) -> CoreResult<()> {
        if self.0 == 0 {
            return Ok(());
        }
        // SAFETY: the positive PGID is the PID of our child, created with
        // process_group(0); it can never target Diffuse's own process group.
        let result = unsafe { libc::killpg(self.0, libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        self.0 = 0;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = self.terminate();
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
