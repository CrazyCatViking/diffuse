//! Session-scoped MCP Streamable HTTP (2025-06-18), JSON responses only.
use crate::operation::OperationControl;
use crate::workspace::WorkspaceRuntime;
use crate::{CoreError, CoreResult, DiffTarget, EventHub};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub(crate) struct Server {
    pub descriptor: Value,
    pub turn: Arc<TurnScope>,
    stop: tokio::sync::watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
pub(crate) type ActivityRecorder = Arc<dyn Fn(&str, &str) -> CoreResult<()> + Send + Sync>;
#[derive(Clone)]
pub(crate) struct ReviewScope {
    pub session_id: String,
    pub file_ids: Option<BTreeSet<String>>,
}
impl Server {
    pub async fn start(
        workspace: Weak<WorkspaceRuntime>,
        review: ReviewScope,
        events: Arc<EventHub>,
        record_activity: ActivityRecorder,
    ) -> CoreResult<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let token = uuid::Uuid::new_v4().to_string();
        let descriptor = json!({"type":"http","name":"diffuse-review","url":format!("http://{address}/mcp"),"headers":[{"name":"Authorization","value":format!("Bearer {token}")}]});
        let turn = Arc::new(TurnScope::default());
        let active_turn = turn.clone();
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let initialized = AtomicBool::new(false);
            loop {
                let accepted = tokio::select! { biased; _=stopped.wait_for(|s|*s)=>break, result=listener.accept()=>result };
                let Ok((socket, _)) = accepted else {
                    break;
                };
                // Serial bounded requests prevent an agent from creating an unbounded task pool.
                let operation = OperationControl::new(Duration::from_secs(10));
                let request = handle(
                    socket,
                    &token,
                    &workspace,
                    &review,
                    &active_turn,
                    &events,
                    &initialized,
                    &record_activity,
                    &operation,
                );
                tokio::pin!(request);
                tokio::select! {
                    biased;
                    _ = async {let _=stopped.wait_for(|s|*s).await;} => {
                        operation.cancel();
                        let _=request.await;
                        break;
                    },
                    _ = operation.interrupted() => {
                        operation.cancel();
                        // Keep admission occupied until the actual blocking job
                        // has observed cancellation and reaped its processes.
                        let _=request.await;
                    },
                    _ = &mut request => {},
                }
            }
        });
        Ok(Self {
            descriptor,
            turn,
            stop,
            task: Some(task),
        })
    }
    pub async fn close(&mut self) {
        self.stop.send_replace(true);
        self.turn.end().await;
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

#[derive(Default)]
pub(crate) struct TurnScope {
    state: Mutex<(Option<String>, usize, Option<OperationControl>)>,
    idle: tokio::sync::Notify,
}
struct ToolPermit(Arc<TurnScope>);
impl Drop for ToolPermit {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().expect("MCP turn poisoned");
        state.1 -= 1;
        state.2 = None;
        drop(state);
        self.0.idle.notify_one();
    }
}
impl TurnScope {
    pub fn start(&self, id: Option<String>) {
        self.state.lock().expect("MCP turn poisoned").0 = id;
    }
    fn enter(self: &Arc<Self>, operation: OperationControl) -> CoreResult<(String, ToolPermit)> {
        let mut state = self.state.lock().expect("MCP turn poisoned");
        if state.1 != 0 {
            return Err(invalid("previous tool is still running"));
        }
        let id = state
            .0
            .clone()
            .ok_or_else(|| invalid("no active agent turn"))?;
        state.1 += 1;
        state.2 = Some(operation);
        Ok((id, ToolPermit(self.clone())))
    }
    pub async fn end(&self) {
        {
            let mut state = self.state.lock().expect("MCP turn poisoned");
            state.0 = None;
            if let Some(operation) = &state.2 {
                operation.cancel();
            }
        }
        loop {
            if self.state.lock().expect("MCP turn poisoned").1 == 0 {
                break;
            }
            self.idle.notified().await;
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError::InvalidParams(message.into())
}

#[allow(clippy::too_many_arguments)]
async fn handle(
    socket: TcpStream,
    token: &str,
    workspace: &Weak<WorkspaceRuntime>,
    review: &ReviewScope,
    turn: &Arc<TurnScope>,
    events: &Arc<EventHub>,
    initialized: &AtomicBool,
    record_activity: &ActivityRecorder,
    operation: &OperationControl,
) -> CoreResult<()> {
    let mut socket = CancellableSocket {
        stream: socket,
        operation: operation.clone(),
    };
    let mut bytes = Vec::new();
    let (offset, length, method) = loop {
        let mut buffer = [0u8; 4096];
        let count = socket.read(&mut buffer).await?;
        if count == 0 {
            return Err(invalid("incomplete HTTP request"));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 8192 {
            return reply(&mut socket, 431, Value::Null).await;
        }
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut request = httparse::Request::new(&mut headers);
        let parsed = request.parse(&bytes).map_err(|_| invalid("invalid HTTP"))?;
        if let httparse::Status::Complete(offset) = parsed {
            let mut auth = false;
            let mut auth_seen = false;
            let mut length = None;
            for header in request.headers.iter() {
                if header.name.eq_ignore_ascii_case("authorization") {
                    if auth_seen {
                        return reply(&mut socket, 400, Value::Null).await;
                    }
                    auth_seen = true;
                    auth = header.value == format!("Bearer {token}").as_bytes();
                }
                // Native ACP hosts do not need browser origins. Reject all browser requests.
                if header.name.eq_ignore_ascii_case("origin")
                    || header.name.eq_ignore_ascii_case("transfer-encoding")
                {
                    return reply(&mut socket, 403, Value::Null).await;
                }
                if header.name.eq_ignore_ascii_case("content-length") {
                    if length.is_some() {
                        return reply(&mut socket, 400, Value::Null).await;
                    }
                    length = Some(
                        std::str::from_utf8(header.value)
                            .ok()
                            .and_then(|s| s.parse::<usize>().ok())
                            .ok_or_else(|| invalid("invalid length"))?,
                    );
                }
            }
            if !auth || request.path != Some("/mcp") {
                return reply(&mut socket, 403, Value::Null).await;
            }
            break (
                offset,
                length.unwrap_or(0),
                request.method.unwrap_or_default().to_owned(),
            );
        }
    };
    if method != "POST" {
        return reply(&mut socket, 405, Value::Null).await;
    }
    if length > 64 * 1024 {
        return reply(&mut socket, 413, Value::Null).await;
    }
    while bytes.len() < offset + length {
        let mut buffer = [0u8; 4096];
        let count = socket.read(&mut buffer).await?;
        if count == 0 {
            return Err(invalid("incomplete body"));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > offset + 64 * 1024 {
            return reply(&mut socket, 413, Value::Null).await;
        }
    }
    let message: Value = serde_json::from_slice(&bytes[offset..offset + length])
        .map_err(|_| invalid("invalid JSON"))?;
    if message["jsonrpc"] != "2.0" {
        return reply(&mut socket, 400, Value::Null).await;
    }
    let Some(id) = message.get("id").cloned() else {
        return reply(&mut socket, 202, Value::Null).await;
    };
    let method = message["method"].as_str().unwrap_or_default();
    if method != "initialize" && !initialized.load(Ordering::Acquire) {
        return reply(&mut socket,200,json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"MCP initialize is required"}})).await;
    }
    let result = match method {
        "initialize" => {
            if !message["params"]["protocolVersion"].is_string() {
                return reply(&mut socket, 400, Value::Null).await;
            }
            initialized.store(true, Ordering::Release);
            Ok(
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"diffuse-review","version":crate::VERSION}}),
            )
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":tools()})),
        "tools/call" => {
            let admission = (|| {
                let workspace = workspace.upgrade().ok_or(CoreError::WorkspaceClosing)?;
                // Tools cannot create blocking input. Keep their lifetime with
                // the agent so close can drain input mutations, decide policy,
                // then cancel tool I/O before waiting for background work.
                let permit = workspace.acquire_background_operation()?;
                let (turn, tool_permit) = turn.enter(operation.clone())?;
                Ok::<_, CoreError>((workspace, permit, turn, tool_permit))
            })();
            let (workspace,permit,turn,tool_permit)=match admission {
                Ok(admitted)=>admitted,
                Err(error)=>return reply(&mut socket,200,json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":error.to_string()}],"isError":true}})).await,
            };
            let review = review.clone();
            let params = message["params"].clone();
            let events = events.clone();
            let record_activity = record_activity.clone();
            let operation = operation.clone();
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let _tool_permit = tool_permit;
                call_tool(
                    &workspace,
                    &review,
                    &turn,
                    &params,
                    &events,
                    &record_activity,
                    &operation,
                )
            })
            .await
            .map_err(|_| invalid("tool task failed"))?;
            Ok(match result {
                Ok(value) => {
                    json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
                }
                Err(error) => {
                    json!({"content":[{"type":"text","text":error.to_string()}],"isError":true})
                }
            })
        }
        _ => Err(invalid("method not found")),
    };
    let response = match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":e.to_string()}}),
    };
    reply(&mut socket, 200, response).await
}

struct CancellableSocket {
    stream: TcpStream,
    operation: OperationControl,
}
impl CancellableSocket {
    async fn read(&mut self, buffer: &mut [u8]) -> CoreResult<usize> {
        tokio::select! {biased; _=self.operation.interrupted()=>{self.operation.check()?;unreachable!()},result=self.stream.read(buffer)=>Ok(result?)}
    }
    async fn write_all(&mut self, buffer: &[u8]) -> CoreResult<()> {
        tokio::select! {biased; _=self.operation.interrupted()=>self.operation.check(),result=self.stream.write_all(buffer)=>Ok(result?)}
    }
}

async fn reply(socket: &mut CancellableSocket, status: u16, value: Value) -> CoreResult<()> {
    let mut body = if value.is_null() {
        String::new()
    } else {
        value.to_string()
    };
    let status = if body.len() > 256 * 1024 {
        body.clear();
        413
    } else {
        status
    };
    let header = format!(
        "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(body.as_bytes()).await?;
    Ok(())
}

fn tools() -> Vec<Value> {
    [
        ("listChangedFiles",json!({})),
        ("readDiff",json!({"fileId":{"type":"string"}})),
        ("addFinding",json!({"filePath":{"type":"string"},"side":{"type":"string","enum":["old","new"]},"startLine":{"type":"integer"},"endLine":{"type":"integer"},"body":{"type":"string"},"severity":{"type":"string"},"category":{"type":"string"},"confidence":{"type":"string"},"selectedText":{"type":"string"}})),
        ("updateProgress",json!({"status":{"type":"string"},"message":{"type":"string"},"totalFiles":{"type":"integer"},"reviewedFiles":{"type":"integer"},"activeFiles":{"type":"array","items":{"type":"string"}},"pendingFiles":{"type":"array","items":{"type":"string"}},"completedFiles":{"type":"array","items":{"type":"string"}}})),
        ("updateReviewedFiles",json!({"files":{"type":"object"},"removeFileIds":{"type":"array","items":{"type":"string"}}})),
        ("readThreads",json!({})),
        ("reportActivity",json!({"message":{"type":"string","maxLength":4096}})),
    ].into_iter().map(|(name,properties)| {
        let description=if name=="updateProgress" {
            "Update progress within the bound review. For sharded sessions, include completedFiles when reporting reviewedFiles, and cover all assigned files for status completed. Other shards' file states are preserved.".to_owned()
        } else {format!("{name} within the bound Diffuse review session")};
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"additionalProperties":false}})
    }).collect()
}

fn call_tool(
    workspace: &WorkspaceRuntime,
    scope: &ReviewScope,
    turn: &str,
    params: &Value,
    events: &EventHub,
    record_activity: &ActivityRecorder,
    operation: &OperationControl,
) -> CoreResult<Value> {
    operation.check()?;
    let review = &scope.session_id;
    let repository = workspace.repository.with_operation(operation.clone());
    let name = params["name"]
        .as_str()
        .ok_or_else(|| invalid("missing tool name"))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let definition = tools()
        .into_iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| invalid("unknown tool"))?;
    let object = args
        .as_object()
        .ok_or_else(|| invalid("arguments must be object"))?;
    if object
        .keys()
        .any(|key| definition["inputSchema"]["properties"].get(key).is_none())
    {
        return Err(invalid("unknown or out-of-scope argument"));
    }
    let session = workspace
        .reviews
        .get_session(review)?
        .ok_or_else(|| invalid("review no longer exists"))?;
    let target: DiffTarget = serde_json::from_value(json!(session.target))
        .map_err(|_| invalid("invalid review target"))?;
    // Scope comes from the persisted session, never from tool arguments. The
    // current review target can remove files from this set, but cannot widen it.
    let scoped_files = || -> CoreResult<Vec<crate::ChangedFile>> {
        Ok(repository
            .list_changed_files(&target)?
            .into_iter()
            .filter(|file| {
                scope
                    .file_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&file.id))
            })
            .collect())
    };
    let serialize =
        |value| serde_json::to_value(value).map_err(|e| CoreError::Serialization(e.to_string()));
    let (value, event) = match name {
        "reportActivity" => {
            let message = args["message"]
                .as_str()
                .filter(|m| !m.is_empty() && m.len() <= 4096)
                .ok_or_else(|| invalid("invalid activity message"))?;
            record_activity(turn, message)?;
            (json!({"recorded":true}), None)
        }
        "listChangedFiles" => (json!(scoped_files()?), None),
        "readDiff" => {
            let file = args["fileId"]
                .as_str()
                .ok_or_else(|| invalid("missing fileId"))?;
            if !scoped_files()?.iter().any(|f| f.id == file) {
                return Err(invalid("file not in assigned review scope"));
            }
            (
                json!({"fileId":file,"diff":repository.git_diff(&target,&[],Some(file))?}),
                None,
            )
        }
        "addFinding" => {
            let comment: crate::review::ReviewCommentPayload =
                serde_json::from_value(args).map_err(|_| invalid("invalid finding"))?;
            let files = scoped_files()?;
            let file = files
                .iter()
                .find(|f| {
                    f.id == comment.file_path || f.old_path.as_deref() == Some(&comment.file_path)
                })
                .ok_or_else(|| invalid("finding outside assigned review scope"))?;
            let model = crate::diff::get_diff_render_model(
                &repository,
                &file.id,
                &file.id,
                crate::DiffRenderOptions::default(),
                &target,
            )?;
            if !model.rows.iter().any(|r| {
                let line = match comment.side {
                    crate::review::ReviewSide::Old => r.old_line,
                    crate::review::ReviewSide::New => r.new_line,
                };
                matches!(
                    r.kind,
                    crate::DiffRowKind::Added
                        | crate::DiffRowKind::Deleted
                        | crate::DiffRowKind::Modified
                ) && line.is_some_and(|n| n >= comment.start_line && n <= comment.end_line)
            }) {
                return Err(invalid("finding must intersect a changed line"));
            }
            operation.check()?;
            let operation = workspace
                .reviews
                .add_comment_payload(review, turn, comment)?;
            (serialize(operation.result)?, operation.event)
        }
        "updateProgress" => {
            let files = scoped_files()?;
            for key in ["activeFiles", "pendingFiles", "completedFiles"] {
                if args[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|v| !files.iter().any(|f| v.as_str() == Some(&f.id)))
                {
                    return Err(invalid(
                        "progress references a file outside the assigned review scope",
                    ));
                }
            }
            let progress: crate::review::ReviewProgress =
                serde_json::from_value(args).map_err(|_| invalid("invalid progress"))?;
            if scope.file_ids.is_some() {
                let ids: BTreeSet<_> = files.iter().map(|file| file.id.clone()).collect();
                if ids.is_empty() {
                    return Err(invalid("assigned files are no longer in the review target"));
                }
                let mut seen = BTreeSet::new();
                for id in [
                    &progress.active_files,
                    &progress.pending_files,
                    &progress.completed_files,
                ]
                .into_iter()
                .flatten()
                .flatten()
                {
                    if !seen.insert(id) {
                        return Err(invalid("progress file states must be unique and disjoint"));
                    }
                }
                let completed = progress.completed_files.as_ref().map_or(0, Vec::len);
                if progress.total_files.is_some_and(|n| n as usize > ids.len())
                    || progress
                        .reviewed_files
                        .is_some_and(|n| n as usize != completed)
                    || (progress.status == crate::review::ReviewProgressStatus::Completed
                        && completed != ids.len())
                {
                    return Err(invalid(
                        "progress counts/completion must describe the assigned files",
                    ));
                }
                let all_ids: Vec<_> = repository
                    .list_changed_files(&target)?
                    .into_iter()
                    .map(|file| file.id)
                    .collect();
                operation.check()?;
                let operation = workspace
                    .reviews
                    .save_scoped_progress(review, progress, &ids, &all_ids)?;
                (json!(operation.result), operation.event)
            } else {
                operation.check()?;
                let operation = workspace.reviews.save_progress(review, progress)?;
                (json!(operation.result), operation.event)
            }
        }
        "updateReviewedFiles" => {
            let files = scoped_files()?;
            if args["files"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.keys())
                .any(|id| !files.iter().any(|f| &f.id == id))
                || args["removeFileIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|v| !files.iter().any(|f| v.as_str() == Some(&f.id)))
            {
                return Err(invalid(
                    "reviewed file is outside the assigned review scope",
                ));
            }
            let update: crate::review::ReviewedFilesUpdate =
                serde_json::from_value(args).map_err(|_| invalid("invalid reviewed files"))?;
            if update
                .files
                .as_ref()
                .is_some_and(|entries| entries.iter().any(|(id, file)| id != &file.file_id))
            {
                return Err(invalid("reviewed fileId must match its assigned map key"));
            }
            operation.check()?;
            let operation = workspace.reviews.update_reviewed_files(review, update)?;
            let mut result = operation.result;
            if scope.file_ids.is_some() {
                result.files.retain(|id, reviewed| {
                    reviewed.file_id == *id && files.iter().any(|file| &file.id == id)
                });
                result.extra.clear();
            }
            (json!(result), operation.event)
        }
        "readThreads" => {
            let mut threads = workspace.reviews.get_threads(review)?;
            if scope.file_ids.is_some() {
                let files = scoped_files()?;
                threads.retain(|thread| {
                    files.iter().any(|file| match thread.anchor.side {
                        crate::review::ReviewSide::Old => {
                            file.status != crate::FileStatus::Added
                                && (file.id == thread.file_id
                                    || file.old_path.as_ref() == Some(&thread.file_id))
                        }
                        crate::review::ReviewSide::New => {
                            file.status != crate::FileStatus::Deleted && file.id == thread.file_id
                        }
                    })
                });
            }
            (json!(threads), None)
        }
        _ => return Err(invalid("unknown tool")),
    };
    if let Some(event) = event {
        events.publish(
            "review/changed",
            Some((workspace.id, workspace.generation)),
            json!(event),
        );
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn request(address: &str, headers: &str, body: &str) -> String {
        let mut socket = TcpStream::connect(address).await.unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: {address}\r\n{headers}Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn http_authentication_initialization_and_origin_are_enforced() {
        let mut server = Server::start(
            Weak::new(),
            ReviewScope {
                session_id: "review".into(),
                file_ids: None,
            },
            Arc::new(EventHub::nonblocking(16)),
            Arc::new(|_, _| Ok(())),
        )
        .await
        .unwrap();
        let url = server.descriptor["url"].as_str().unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let authorization = server.descriptor["headers"][0]["value"].as_str().unwrap();
        let headers = format!("Authorization: {authorization}\r\n");
        let list = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}).to_string();
        assert!(
            request(address, "", &list)
                .await
                .starts_with("HTTP/1.1 403")
        );
        assert!(
            request(
                address,
                &format!("{headers}Origin: https://evil.invalid\r\n"),
                &list
            )
            .await
            .starts_with("HTTP/1.1 403")
        );
        let before = request(address, &headers, &list).await;
        assert!(before.contains("initialize is required"));
        let initialized=request(address,&headers,&json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}).to_string()).await;
        assert!(initialized.contains("2025-06-18"));
        let listed = request(address, &headers, &list).await;
        assert!(listed.contains("addFinding"));
        let closed=request(address,&headers,&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"listChangedFiles","arguments":{}}}).to_string()).await;
        assert!(closed.contains("\"isError\":true"));
        server.close().await;
    }

    #[tokio::test]
    async fn turn_end_fences_new_tools_and_drains_admitted_tools() {
        let scope = Arc::new(TurnScope::default());
        scope.start(Some("old-turn".into()));
        let control = OperationControl::new(Duration::from_secs(5));
        let (turn, permit) = scope.enter(control.clone()).unwrap();
        assert_eq!(turn, "old-turn");
        let end = scope.end();
        tokio::pin!(end);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut end)
                .await
                .is_err()
        );
        assert!(control.check().is_err());
        assert!(scope.enter(control.clone()).is_err());
        drop(permit);
        tokio::time::timeout(Duration::from_secs(1), &mut end)
            .await
            .unwrap();
        scope.start(Some("new-turn".into()));
        assert_eq!(
            scope
                .enter(OperationControl::new(Duration::from_secs(5)))
                .unwrap()
                .0,
            "new-turn"
        );
    }
}
