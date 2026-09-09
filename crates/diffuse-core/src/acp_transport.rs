//! One bounded JSON-RPC dispatcher per ACP connection; sessions never own stdout.
use crate::acp::{AdapterConfig, MAX_MESSAGE_BYTES};
use crate::{CoreError, CoreResult};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

fn error(s: &str) -> CoreError {
    CoreError::TaskFailed(format!("ACP: {s}"))
}
const DEADLINE: Duration = Duration::from_secs(10);

struct Outgoing {
    value: Value,
    peer: mpsc::Sender<Incoming>,
    reply_ticket: Option<u64>,
}
pub(crate) struct Incoming {
    pub value: Value,
    pub ticket: Option<u64>,
}
type AgentRequests = HashMap<String, (u64, mpsc::Sender<Incoming>)>;

fn take_reply(requests: &mut AgentRequests, command: &Outgoing) -> bool {
    let key = command.value["id"].to_string();
    if !requests.get(&key).is_some_and(|(ticket, owner)| {
        Some(*ticket) == command.reply_ticket && owner.same_channel(&command.peer)
    }) {
        return false;
    }
    requests.remove(&key);
    true
}
pub(crate) struct Host {
    pub id: String,
    outgoing: mpsc::Sender<Outgoing>,
    initialized: watch::Receiver<Option<Result<Value, String>>>,
    failed: watch::Receiver<bool>,
    stop: watch::Sender<bool>,
    thread: Option<std::thread::JoinHandle<()>>,
    sessions: AtomicUsize,
}

pub(crate) struct HostSession(Arc<Host>);
impl std::ops::Deref for HostSession {
    type Target = Host;
    fn deref(&self) -> &Host {
        &self.0
    }
}
impl Drop for HostSession {
    fn drop(&mut self) {
        self.0.sessions.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Host {
    pub fn spawn(adapter: AdapterConfig, cwd: String) -> CoreResult<Arc<Self>> {
        if !cfg!(any(unix, windows)) {
            return Err(error(
                "process-tree containment is unsupported on this platform",
            ));
        }
        let (outgoing, mut commands) = mpsc::channel::<Outgoing>(32);
        let (ready, initialized) = watch::channel(None);
        let (failure, failed) = watch::channel(false);
        let (stop, mut stopping) = watch::channel(false);
        let thread = std::thread::Builder::new()
            .name("diffuse-acp-host".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                if let Ok(runtime) = result {
                    runtime.block_on(async {
                        let mut command = Command::new(adapter.executable);
                        command
                            .args(adapter.args)
                            .env_clear()
                            .envs(adapter.environment)
                            .current_dir(cwd)
                            .stdin(Stdio::piped())
                            .stdout(Stdio::piped())
                            .stderr(Stdio::null())
                            .kill_on_drop(true);
                        #[cfg(unix)]
                        command.process_group(0);
                        #[cfg(windows)]
                        let mut job = None;
                        #[cfg(windows)]
                        let spawned = crate::windows_job::WindowsJob::spawn_tokio(&mut command)
                            .await
                            .map(|(child, owned_job)| {
                                job = Some(owned_job);
                                child
                            });
                        #[cfg(not(windows))]
                        let spawned = command.spawn();
                        let result = match spawned {
                            Err(e) => Err(e.into()),
                            Ok(mut child) => {
                                #[cfg(unix)]
                                let mut group =
                                    ProcessGroup(child.id().expect("child PID") as libc::pid_t);
                                let mut stream = Stream {
                                    input: child.stdin.take().expect("stdin"),
                                    output: BufReader::new(child.stdout.take().expect("stdout")),
                                    buffer: vec![],
                                };
                                let result = tokio::select! {
                                    biased;
                                    _ = stopping.wait_for(|v| *v) => Ok(()),
                                    result = dispatch(&mut stream, &mut commands, &ready) => result,
                                };
                                #[cfg(unix)]
                                let cleanup = group.terminate();
                                #[cfg(windows)]
                                drop(job.take());
                                let _ = child.kill().await;
                                let _ = child.wait().await;
                                #[cfg(unix)]
                                let result = result.and(cleanup);
                                result
                            }
                        };
                        if let Err(e) = result {
                            ready.send_replace(Some(Err(e.to_string())));
                        }
                    });
                }
                failure.send_replace(true);
            })?;
        Ok(Arc::new(Self {
            id: uuid::Uuid::new_v4().to_string(),
            outgoing,
            initialized,
            failed,
            stop,
            thread: Some(thread),
            sessions: AtomicUsize::new(0),
        }))
    }
    pub fn alive(&self) -> bool {
        !*self.failed.borrow()
    }
    pub fn reserve(self: &Arc<Self>) -> Option<HostSession> {
        // Keep headroom in the bounded RPC queues. This grows the pool rather
        // than imposing a product-wide session limit or crashing a saturated host.
        self.sessions
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 8).then_some(n + 1)
            })
            .ok()?;
        Some(HostSession(self.clone()))
    }
    pub fn stop(&self) {
        self.stop.send_replace(true);
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) struct Wire {
    host: HostSession,
    peer: mpsc::Sender<Incoming>,
    incoming: mpsc::Receiver<Incoming>,
    local: Option<Value>,
    prompt: Option<Value>,
}

impl Wire {
    pub fn new(host: HostSession) -> Self {
        let (peer, incoming) = mpsc::channel(64);
        Self {
            host,
            peer,
            incoming,
            local: None,
            prompt: None,
        }
    }
    pub async fn send(&mut self, value: Value) -> CoreResult<()> {
        if value.get("method").is_none() {
            return Err(error("agent responses require an explicit request ticket"));
        }
        if value["method"] == "initialize" {
            let mut ready = self.host.initialized.clone();
            let mut failed = self.host.failed.clone();
            let result = tokio::select! {
                result = ready.wait_for(|v| v.is_some()) => result.map_err(|_| error("host disconnected"))?.clone().expect("ready"),
                _ = failed.wait_for(|v| *v) => return Err(error("host disconnected")),
            }.map_err(|e| CoreError::TaskFailed(format!("ACP: {e}")))?;
            self.local = Some(json!({"jsonrpc":"2.0","id":value["id"],"result":result}));
            return Ok(());
        }
        if value["method"] == "session/prompt" {
            self.prompt = Some(value["id"].clone());
        }
        self.host
            .outgoing
            .try_send(Outgoing {
                reply_ticket: None,
                value,
                peer: self.peer.clone(),
            })
            .map_err(|_| error("host queue full or disconnected"))?;
        Ok(())
    }
    /// Delayed replies must use the ticket captured with the original request,
    /// not whichever request currently occupies its reusable JSON-RPC ID.
    pub async fn send_response(&mut self, value: Value, ticket: u64) -> CoreResult<()> {
        if value.get("method").is_some() || value.get("id").is_none() {
            return Err(error("invalid agent response envelope"));
        }
        self.host
            .outgoing
            .try_send(Outgoing {
                value,
                peer: self.peer.clone(),
                reply_ticket: Some(ticket),
            })
            .map_err(|_| error("host queue full or disconnected"))?;
        Ok(())
    }

    pub async fn receive(&mut self) -> CoreResult<Incoming> {
        if let Some(value) = self.local.take() {
            return Ok(Incoming {
                value,
                ticket: None,
            });
        }
        let mut failed = self.host.failed.clone();
        let incoming = tokio::select! {
            biased;
            value = self.incoming.recv() => value.ok_or_else(|| error("host disconnected"))?,
            _ = failed.wait_for(|v| *v) => return Err(error("host disconnected")),
        };
        let value = incoming.value;
        if value.get("method").is_none() && self.prompt.as_ref() == value.get("id") {
            self.prompt = None;
        }
        Ok(Incoming {
            value,
            ticket: incoming.ticket,
        })
    }
    pub async fn close(&mut self, remote: Option<&str>, capabilities: &Value) {
        let Some(remote) = remote else {
            return;
        };
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            if self.prompt.is_some() {
                self.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":remote}})).await?;
                while self.prompt.is_some() { self.drain_response().await?; }
            }
            if capabilities["sessionCapabilities"]["close"].is_object() {
                self.send(json!({"jsonrpc":"2.0","id":"close","method":"session/close","params":{"sessionId":remote}})).await?;
                loop { let value = self.drain_response().await?; if value["id"] == "close" { if value.get("error").is_some() {return Err(error("peer rejected session cleanup"));} break; } }
            }
            Ok::<(),CoreError>(())
        }).await;
        if !matches!(result, Ok(Ok(()))) {
            self.host.stop();
        }
    }
    async fn drain_response(&mut self) -> CoreResult<Value> {
        let incoming = self.receive().await?;
        let value = incoming.value;
        if value["method"] == "session/request_permission" && value.get("id").is_some() {
            let ticket = incoming
                .ticket
                .ok_or_else(|| error("missing permission request ticket"))?;
            self.send_response(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}),ticket).await?;
        }
        Ok(value)
    }
}

async fn dispatch(
    stream: &mut Stream,
    commands: &mut mpsc::Receiver<Outgoing>,
    ready: &watch::Sender<Option<Result<Value, String>>>,
) -> CoreResult<()> {
    stream.send(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"diffuse","version":crate::VERSION}}})).await?;
    let initialized = tokio::time::timeout(DEADLINE, stream.receive())
        .await
        .map_err(|_| error("initialize deadline exceeded"))??;
    if initialized["id"] != 0 || initialized["result"]["protocolVersion"] != 1 {
        return Err(error("unsupported protocol or invalid initialization"));
    }
    ready.send_replace(Some(Ok(initialized["result"].clone())));
    let mut next_id = 1_u64;
    let mut pending: HashMap<u64, (Value, mpsc::Sender<Incoming>, String)> = HashMap::new();
    let mut sessions: HashMap<String, mpsc::Sender<Incoming>> = HashMap::new();
    let mut agent_requests = AgentRequests::new();
    let mut next_ticket = 1_u64;
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()); };
                if command.value.get("method").is_none() && !take_reply(&mut agent_requests,&command) {continue;}
                let Outgoing { mut value, peer, .. }=command;
                sessions.retain(|_,peer|!peer.is_closed());
                agent_requests.retain(|_,(_,peer)|!peer.is_closed());
                if let Some(method) = value["method"].as_str().map(str::to_owned) {
                    if let Some(id) = value.get("id").cloned() {
                        if pending.len() >= 32 { return Err(error("too many outstanding requests")); }
                        if matches!(method.as_str(), "session/load" | "session/resume") {
                            if let Some(remote) = value["params"]["sessionId"].as_str() { sessions.insert(remote.into(),peer.clone()); }
                        }
                        value["id"] = json!(next_id);
                        pending.insert(next_id,(id,peer,method)); next_id += 1;
                    }
                }
                stream.send(value).await?;
            }
            value = stream.receive() => {
                let mut value = value?;
                if value.get("id").is_none() && value["method"]=="$/cancel_request" {
                    if let Some(id)=value["params"].get("requestId").cloned() {
                        if let Some((ticket,peer))=agent_requests.remove(&id.to_string()) {
                            // Retire and answer in this single dispatcher. Worker
                            // replies with the old ticket can no longer win, even
                            // if the agent immediately reuses the request ID.
                            let _=peer.try_send(Incoming {value,ticket:Some(ticket)});
                            stream.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32800,"message":"Request cancelled"}})).await?;
                        }
                    }
                    continue;
                }
                if value.get("id").is_none() && value["method"].as_str().is_some_and(|m|m.starts_with("$/")) {continue;}
                if value.get("method").is_none() {
                    let id = value["id"].as_u64().ok_or_else(|| error("invalid response ID"))?;
                    let (original,peer,method) = pending.remove(&id).ok_or_else(|| error("unknown response ID"))?;
                    if value.get("result").is_some() == value.get("error").is_some() { return Err(error("invalid response")); }
                    if method == "session/new" {
                        if let Some(remote) = value["result"]["sessionId"].as_str() {
                            if sessions.get(remote).is_some_and(|p| !p.is_closed()) { return Err(error("duplicate remote session ID")); }
                            sessions.insert(remote.into(),peer.clone());
                        }
                    }
                    value["id"] = original;
                    if !peer.is_closed() && peer.try_send(Incoming {value,ticket:None}).is_err() { return Err(error("session output queue full")); }
                } else {
                    let peer=value["params"]["sessionId"].as_str().and_then(|id|sessions.get(id))
                        .or_else(|| if value["method"]=="elicitation/create" {value["params"]["requestId"].as_u64().and_then(|id|pending.get(&id).map(|(_,peer,_)|peer))} else {None});
                    if let Some(peer)=peer {
                        let ticket=if let Some(id)=value.get("id") {
                            if agent_requests.len()>=128 {return Err(error("too many agent requests"));}
                            if agent_requests.contains_key(&id.to_string()) {return Err(error("duplicate agent request ID"));}
                            let ticket=next_ticket;next_ticket=next_ticket.checked_add(1).ok_or_else(||error("request ticket exhausted"))?;
                            agent_requests.insert(id.to_string(),(ticket,peer.clone()));
                            Some(ticket)
                        } else {None};
                        if !peer.is_closed() && peer.try_send(Incoming {value,ticket}).is_err() { return Err(error("session output queue full")); }
                    } else if value.get("id").is_some() {
                        stream.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"Request has no live session or request scope"}})).await?;
                    } else {return Err(error("message for foreign session"));}
                }
            }
        }
    }
}

struct Stream {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    buffer: Vec<u8>,
}
impl Stream {
    async fn send(&mut self, value: Value) -> CoreResult<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| error("invalid outgoing JSON"))?;
        if bytes.len() >= MAX_MESSAGE_BYTES {
            return Err(error("outgoing message exceeds limit"));
        }
        bytes.push(b'\n');
        tokio::time::timeout(DEADLINE, self.input.write_all(&bytes))
            .await
            .map_err(|_| error("write deadline exceeded"))??;
        Ok(())
    }
    async fn receive(&mut self) -> CoreResult<Value> {
        loop {
            let chunk = self.output.fill_buf().await?;
            if chunk.is_empty() {
                return Err(error("host disconnected"));
            }
            let newline = chunk.iter().position(|b| *b == b'\n');
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
                if value["jsonrpc"] != "2.0" {
                    return Err(error("invalid JSON-RPC envelope"));
                }
                return Ok(value);
            }
        }
    }
}

#[cfg(unix)]
struct ProcessGroup(libc::pid_t);
#[cfg(unix)]
impl ProcessGroup {
    fn terminate(&mut self) -> CoreResult<()> {
        if self.0 == 0 {
            return Ok(());
        }
        // SAFETY: this positive PGID belongs to our process_group(0) child.
        if unsafe { libc::killpg(self.0, libc::SIGKILL) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::ESRCH) {
                return Err(e.into());
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_request_ticket_cannot_reply_to_a_reused_id() {
        let (peer, _receiver) = mpsc::channel(4);
        let (foreign, _foreign_receiver) = mpsc::channel(4);
        let mut requests = AgentRequests::from([(json!("request").to_string(), (2, peer.clone()))]);
        let reply = |peer, ticket| Outgoing {
            value: json!({"jsonrpc":"2.0","id":"request","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}),
            peer,
            reply_ticket: Some(ticket),
        };
        assert!(!take_reply(&mut requests, &reply(peer.clone(), 1)));
        assert!(!take_reply(&mut requests, &reply(foreign, 2)));
        assert_eq!(requests.len(), 1);
        assert!(take_reply(&mut requests, &reply(peer.clone(), 2)));
        assert!(!take_reply(&mut requests, &reply(peer, 2)));
    }
}
