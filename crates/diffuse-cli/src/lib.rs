use std::sync::{Arc, RwLock};

use diffuse_core::{
    AppCore, CoreError, WorkbenchDatabase, WorkspaceRequestContext, default_database_path,
    version_info,
};
use serde_json::{Value, json};
use uuid::Uuid;

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
            "getDiffTargetDefaults" => {
                let context = self
                    .current
                    .read()
                    .expect("RPC workspace lock poisoned")
                    .clone()
                    .ok_or_else(repository_not_open)?;
                let result = self
                    .core
                    .get_diff_target_defaults(&context)
                    .await
                    .map_err(core_error)?;
                serde_json::to_value(result).map_err(internal_json_error)
            }
            "listBranches" => {
                let context = self
                    .current
                    .read()
                    .expect("RPC workspace lock poisoned")
                    .clone()
                    .ok_or_else(repository_not_open)?;
                let result = self
                    .core
                    .list_branches(&context)
                    .await
                    .map_err(core_error)?;
                serde_json::to_value(result).map_err(internal_json_error)
            }
            _ => Err(RpcError {
                code: -32601,
                message: "MethodNotFound",
            }),
        }
    }
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
    RpcError {
        code: -32000,
        message: error.protocol_name(),
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
