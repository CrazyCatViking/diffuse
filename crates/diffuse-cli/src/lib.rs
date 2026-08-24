use std::sync::{Arc, RwLock};

use diffuse_core::{
    AppCore, CoreError, WorkbenchDatabase, WorkbenchEvent, WorkspaceRequestContext,
    default_database_path, version_info,
};
use serde_json::{Value, json};
use uuid::Uuid;

const WORKSPACE_METHOD_NAMES: [&str; 42] = [
    "getDiffTargetDefaults",
    "listBranches",
    "listChangedFiles",
    "getDiffRenderModel",
    "getSyntaxSpans",
    "getLspConfigInfo",
    "getLspInstallInfo",
    "installLspServer",
    "restartLspServer",
    "getLspStatus",
    "getLspHover",
    "getLspDiagnostics",
    "getReviewConfig",
    "saveReviewConfig",
    "getActiveReviewSession",
    "listReviewSessions",
    "createReviewSession",
    "getReviewProgress",
    "saveReviewProgress",
    "getReviewedFiles",
    "saveReviewedFiles",
    "updateReviewedFiles",
    "getReviewAgentStates",
    "saveReviewAgentState",
    "getReviewRuns",
    "recoverStaleReviewRuns",
    "saveReviewRun",
    "createReviewRun",
    "updateReviewRun",
    "finishReviewRun",
    "getReviewThreads",
    "getReviewChatMessages",
    "saveReviewChatMessage",
    "addReviewCommentPayload",
    "addReviewComment",
    "saveReviewThread",
    "listTreeSitterGrammars",
    "syncTreeSitterRegistry",
    "installTreeSitterGrammar",
    "uninstallTreeSitterGrammar",
    "startSearch",
    "cancelSearch",
];

const CORE_EVENT_NAMES: [&str; 10] = [
    "repository/changed",
    "review/changed",
    "treeSitter/installProgress",
    "lsp/installProgress",
    "search/started",
    "search/results",
    "search/progress",
    "search/done",
    "search/cancelled",
    "search/error",
];

#[derive(Clone)]
pub struct RpcAdapter {
    core: AppCore,
    current: Arc<RwLock<Option<WorkspaceRequestContext>>>,
}

impl RpcAdapter {
    pub fn new(core: AppCore) -> Self {
        Self {
            core,
            current: Arc::new(RwLock::new(None)),
        }
    }

    pub fn with_default_database() -> Result<Self, CoreError> {
        Ok(Self::new(AppCore::new(WorkbenchDatabase::open(
            default_database_path(),
        )?)))
    }

    pub fn request_too_long_response() -> Value {
        rpc_error(json!(-1), -32700, "RequestTooLong")
    }

    pub fn invalid_utf8_response() -> Value {
        rpc_error(Value::Null, -32700, "SyntaxError")
    }

    pub fn current_event_sequence(&self) -> u64 {
        self.core.events().current_sequence()
    }

    pub fn subscribe_events(
        &self,
        capacity: usize,
    ) -> (
        u64,
        impl Iterator<Item = WorkbenchEvent> + Clone + Send + 'static,
        impl FnOnce() + Send + 'static,
    ) {
        let (sequence, subscription) = self.core.events().subscribe(capacity);
        let cancellation = subscription.clone();
        (sequence, subscription, move || cancellation.close())
    }

    pub fn shutdown(&self) -> Result<(), CoreError> {
        self.core.shutdown()
    }

    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        if line.trim().is_empty() {
            return None;
        }
        let request = match parse_request(line) {
            Ok(request) => request,
            Err(message) => return Some(rpc_error(Value::Null, -32700, message)),
        };
        let id = request.id;
        let result = self.dispatch(&request.method, request.params).await;
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => rpc_error(id, error.code, error.message),
        })
    }

    async fn dispatch(&self, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
        match method {
            "getVersion" => serde_json::to_value(version_info()).map_err(internal_json_error),
            "openRepository" => {
                let path = string_param(params.as_ref(), "path")?;
                let snapshot = self.core.open_workspace(path).await.map_err(core_error)?;
                *self.current.write().expect("RPC workspace lock poisoned") =
                    Some(WorkspaceRequestContext {
                        workspace_id: snapshot.summary.workspace_id,
                        workspace_generation: snapshot.summary.workspace_generation,
                        request_id: Uuid::new_v4().to_string(),
                    });
                serde_json::to_value(snapshot.repository).map_err(internal_json_error)
            }
            method if WORKSPACE_METHOD_NAMES.contains(&method) => {
                let context = self
                    .current
                    .read()
                    .expect("RPC workspace lock poisoned")
                    .clone()
                    .ok_or_else(repository_not_open)?;
                self.core
                    .dispatch_workspace(&context, method, params)
                    .await
                    .map_err(core_error)
            }
            _ => Err(RpcError {
                code: -32601,
                message: "MethodNotFound",
            }),
        }
    }
}

pub fn event_notification(event: WorkbenchEvent) -> Option<Value> {
    CORE_EVENT_NAMES.contains(&event.kind.as_str()).then(|| {
        json!({
            "jsonrpc": "2.0",
            "method": event.kind,
            "params": event.payload,
        })
    })
}

struct ParsedRequest {
    id: Value,
    method: String,
    params: Option<Value>,
}

fn parse_request(line: &str) -> Result<ParsedRequest, &'static str> {
    let value: Value = serde_json::from_str(line).map_err(|_| "SyntaxError")?;
    let object = value.as_object().ok_or("InvalidRequest")?;
    if let Some(version) = object.get("jsonrpc")
        && version.as_str() != Some("2.0")
    {
        return Err("InvalidRequest");
    }
    let id = object.get("id").ok_or("MissingId")?;
    if id.as_i64().is_none() {
        return Err("InvalidId");
    }
    let method = object
        .get("method")
        .ok_or("MissingMethod")?
        .as_str()
        .ok_or("InvalidMethod")?
        .to_owned();
    Ok(ParsedRequest {
        id: id.clone(),
        method,
        params: object.get("params").cloned(),
    })
}

fn string_param<'a>(params: Option<&'a Value>, name: &str) -> Result<&'a str, RpcError> {
    let params = params.ok_or(RpcError {
        code: -32602,
        message: "MissingParams",
    })?;
    let object = params.as_object().ok_or(RpcError {
        code: -32602,
        message: "InvalidParams",
    })?;
    object
        .get(name)
        .ok_or(RpcError {
            code: -32602,
            message: "MissingParam",
        })?
        .as_str()
        .ok_or(RpcError {
            code: -32602,
            message: "InvalidParam",
        })
}

#[derive(Debug)]
struct RpcError {
    code: i64,
    message: &'static str,
}

fn core_error(error: CoreError) -> RpcError {
    match error {
        CoreError::MethodNotFound => RpcError {
            code: -32601,
            message: "MethodNotFound",
        },
        CoreError::InvalidParams(_) => RpcError {
            code: -32602,
            message: "InvalidParams",
        },
        error => RpcError {
            code: -32000,
            message: error.protocol_name(),
        },
    }
}

fn repository_not_open() -> RpcError {
    core_error(CoreError::RepositoryNotOpen)
}

fn internal_json_error(_: serde_json::Error) -> RpcError {
    RpcError {
        code: -32000,
        message: "SerializationError",
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter() -> RpcAdapter {
        RpcAdapter::new(AppCore::new(WorkbenchDatabase::open_in_memory().unwrap()))
    }

    #[tokio::test]
    async fn reports_compatible_method_and_parameter_errors() {
        let adapter = adapter();
        assert_eq!(
            adapter
                .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"unknown","params":{}}"#)
                .await,
            Some(
                json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"MethodNotFound"}})
            )
        );
        assert_eq!(
            adapter
                .handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"openRepository","params":{}}"#)
                .await,
            Some(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"MissingParam"}}))
        );

        *adapter
            .current
            .write()
            .expect("RPC workspace lock poisoned") = Some(WorkspaceRequestContext {
            workspace_id: Default::default(),
            workspace_generation: Default::default(),
            request_id: "invalid-params-test".to_owned(),
        });
        assert_eq!(
            adapter
                .handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"listChangedFiles","params":{}}"#,)
                .await,
            Some(json!({"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"InvalidParams"}}))
        );
    }

    #[tokio::test]
    async fn routes_every_contract_workspace_method() {
        let adapter = adapter();
        let expected = [
            "getDiffTargetDefaults",
            "listBranches",
            "listChangedFiles",
            "getDiffRenderModel",
            "getSyntaxSpans",
            "getLspConfigInfo",
            "getLspInstallInfo",
            "installLspServer",
            "restartLspServer",
            "getLspStatus",
            "getLspHover",
            "getLspDiagnostics",
            "getReviewConfig",
            "saveReviewConfig",
            "getActiveReviewSession",
            "listReviewSessions",
            "createReviewSession",
            "getReviewProgress",
            "saveReviewProgress",
            "getReviewedFiles",
            "saveReviewedFiles",
            "updateReviewedFiles",
            "getReviewAgentStates",
            "saveReviewAgentState",
            "getReviewRuns",
            "recoverStaleReviewRuns",
            "saveReviewRun",
            "createReviewRun",
            "updateReviewRun",
            "finishReviewRun",
            "getReviewThreads",
            "getReviewChatMessages",
            "saveReviewChatMessage",
            "addReviewCommentPayload",
            "addReviewComment",
            "saveReviewThread",
            "listTreeSitterGrammars",
            "syncTreeSitterRegistry",
            "installTreeSitterGrammar",
            "uninstallTreeSitterGrammar",
            "startSearch",
            "cancelSearch",
        ];
        assert_eq!(WORKSPACE_METHOD_NAMES, expected);

        for (id, method) in WORKSPACE_METHOD_NAMES.iter().enumerate() {
            let response = adapter
                .handle_line(
                    &json!({ "jsonrpc": "2.0", "id": id as i64, "method": method }).to_string(),
                )
                .await
                .unwrap();
            assert_eq!(response["error"]["code"], -32000, "{method}");
            assert_eq!(
                response["error"]["message"], "RepositoryNotOpen",
                "{method}"
            );
        }
    }

    #[test]
    fn live_subscription_translates_core_events_and_filters_workspace_lifecycle_events() {
        let adapter = adapter();
        let (sequence, mut events, cancel) = adapter.subscribe_events(4);
        adapter
            .core
            .events()
            .publish("workspace/added", None, json!({ "ignored": true }));
        adapter.core.events().publish(
            "repository/changed",
            None,
            json!({ "root": "/repo", "paths": ["src/lib.rs"] }),
        );
        adapter.core.events().publish(
            "review/changed",
            None,
            json!({ "root": "/repo", "change": "thread.created" }),
        );

        let notifications = (0..3)
            .filter_map(|_| event_notification(events.next().unwrap()))
            .collect::<Vec<_>>();
        cancel();

        assert_eq!(sequence, 0);
        assert_eq!(
            notifications,
            vec![
                json!({
                    "jsonrpc": "2.0",
                    "method": "repository/changed",
                    "params": { "root": "/repo", "paths": ["src/lib.rs"] },
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "review/changed",
                    "params": { "root": "/repo", "change": "thread.created" },
                }),
            ]
        );
    }

    #[test]
    fn slow_live_subscription_does_not_lose_or_duplicate_events_past_replay_capacity() {
        use std::thread;
        use std::time::Duration;

        const EVENT_COUNT: u64 = 2_048;

        let adapter = adapter();
        let (sequence, mut events, cancel) = adapter.subscribe_events(8);
        let publisher = {
            let adapter = adapter.clone();
            thread::spawn(move || {
                for index in 0..EVENT_COUNT {
                    adapter.core.events().publish(
                        "search/progress",
                        None,
                        json!({ "index": index }),
                    );
                }
            })
        };

        let received = (0..EVENT_COUNT)
            .map(|_| {
                thread::sleep(Duration::from_micros(50));
                events.next().unwrap()
            })
            .collect::<Vec<_>>();
        publisher.join().unwrap();
        cancel();

        assert_eq!(sequence, 0);
        assert_eq!(
            received
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            (1..=EVENT_COUNT).collect::<Vec<_>>()
        );
        assert_eq!(
            received
                .iter()
                .map(|event| event.payload["index"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (0..EVENT_COUNT).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn returns_null_id_parse_errors() {
        let adapter = adapter();
        assert_eq!(
            adapter.handle_line("not json").await,
            Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"SyntaxError"}})
            )
        );
    }
}
