//! Deterministic, provider-free ACP v1 peer used only by integration tests.
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn send(value: Value) {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value).unwrap();
    stdout.write_all(b"\n").unwrap();
    stdout.flush().unwrap();
}

fn result(id: &Value, value: Value) {
    send(json!({"jsonrpc":"2.0","id":id,"result":value}));
}

fn update(session: &str, text: &str) {
    send(
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}}),
    );
}

fn reused_form(session: &str, step: usize) {
    let (message, schema) = if step < 2 {
        (
            "Which strategy?",
            json!({"type":"object","properties":{"strategy":{"type":"string","enum":["safe","fast"]}},"required":["strategy"]}),
        )
    } else {
        (
            "Which colors?",
            json!({"type":"object","properties":{"colors":{"type":"array","items":{"type":"string","enum":["red","blue"]},"minItems":1}},"required":["colors"]}),
        )
    };
    send(
        json!({"jsonrpc":"2.0","id":"q","method":"elicitation/create","params":{"sessionId":session,"mode":"form","message":message,"requestedSchema":schema}}),
    );
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "git-blocker" {
        let address = spawn_descendant();
        std::fs::write(std::env::args().nth(2).unwrap(), address).unwrap();
        loop {
            std::thread::park();
        }
    }
    if mode == "descendant" {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        println!("{}", listener.local_addr().unwrap());
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
    let mut pending = std::collections::HashMap::<String, Value>::new();
    let mut cancelled_requests = std::collections::HashSet::<String>::new();
    let mut remote_sessions = Vec::<String>::new();
    let mut mcp = Value::Null;
    let mut reuse: Option<(String, usize, bool)> = None;
    let session = "remote-session"; // Deliberate collision across isolated hosts.
    for line in std::io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = &message["id"];
        let params = &message["params"];
        match message["method"].as_str() {
            Some("initialize") => {
                if let Ok(value) = std::env::var("DIFFUSE_FIXTURE_ALLOWED") {
                    assert_eq!(value, "explicit-only");
                }
                assert!(std::env::var_os("HOME").is_none());
                assert_eq!(params["protocolVersion"], 1);
                assert_eq!(
                    params["clientCapabilities"],
                    json!({"elicitation":{"form":{}}})
                );
                if mode == "init-hang" {
                    loop {
                        std::thread::park();
                    }
                }
                if mode == "minimal" {
                    result(id, json!({"protocolVersion":1}));
                    continue;
                }
                if mode == "resume" {
                    result(
                        id,
                        json!({"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"resume":{},"close":{}}}}),
                    );
                    continue;
                }
                if mode == "mcp" {
                    result(
                        id,
                        json!({"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}),
                    );
                    continue;
                }
                result(
                    id,
                    json!({"protocolVersion":if mode == "version" { 999 } else { 1 },"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true}}}),
                );
            }
            Some("session/new") => {
                assert!(params.get("reviewFileIds").is_none());
                if mode == "mcp" {
                    mcp = params["mcpServers"][0].clone();
                    assert_eq!(mcp["type"], "http");
                    let initialized = mcp_request(
                        &mcp,
                        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),
                    );
                    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
                } else {
                    assert_eq!(params["mcpServers"], json!([]));
                }
                assert_eq!(
                    std::path::Path::new(params["cwd"].as_str().unwrap()),
                    std::env::current_dir().unwrap()
                );
                let remote = if mode.starts_with("pool") {
                    format!("remote-{}", remote_sessions.len() + 1)
                } else {
                    session.into()
                };
                remote_sessions.push(remote.clone());
                let mut response = json!({"sessionId":remote});
                if mode == "modes" {
                    response["modes"] = json!({"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"review","name":"Review"}]});
                }
                result(id, response);
                if mode == "idle-disconnect" {
                    return;
                }
            }
            Some("session/prompt") => {
                let session = params["sessionId"].as_str().unwrap();
                assert!(remote_sessions.iter().any(|s| s == session));
                assert_eq!(params["prompt"][0]["type"], "text");
                pending.insert(session.into(), id.clone());
                let text = params["prompt"][0]["text"].as_str().unwrap();
                match text {
                    "disconnect" => return,
                    "oversize" => {
                        std::io::stdout()
                            .write_all(&vec![b'x'; 256 * 1024 + 1])
                            .unwrap();
                        return;
                    }
                    "wrong-id" => result(&json!(9999), json!({"stopReason":"end_turn"})),
                    "invalid-json" => {
                        std::io::stdout().write_all(b"not json\n").unwrap();
                        return;
                    }
                    "foreign" => update("foreign-session", "must not persist"),
                    "permission" => send(
                        json!({"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":session,"toolCall":{"toolCallId":"edit","title":"Unrestricted shell","kind":"execute"},"options":[{"optionId":"all","name":"Allow always","kind":"allow_always"}]}}),
                    ),
                    "wait" | "ignore-cancel" => update(session, "waiting"),
                    "tree" => update(session, &spawn_descendant()),
                    "updates" => {
                        for update in [
                            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"must-not-persist-thought"}}),
                            json!({"sessionUpdate":"plan","entries":[{"content":"Review","priority":"high","status":"in_progress"}]}),
                            json!({"sessionUpdate":"tool_call","toolCallId":"read","title":"Read diff","kind":"read","status":"pending"}),
                            json!({"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed"}),
                            json!({"sessionUpdate":"current_mode_update","currentModeId":"review"}),
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"message","content":{"type":"text","text":"hello"}}),
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"message","content":{"type":"text","text":" world"}}),
                        ] {
                            send(
                                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}}),
                            );
                        }
                        result(id, json!({"stopReason":"end_turn"}));
                    }
                    "flood" => {
                        for _ in 0..700 {
                            update(session, "delta");
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                        result(id, json!({"stopReason":"end_turn"}));
                    }
                    "question" => send(
                        json!({"jsonrpc":"2.0","id":"question","method":"elicitation/create","params":{"sessionId":session,"mode":"form","message":"Which strategy?","requestedSchema":{"type":"object","properties":{"strategy":{"type":"string","enum":["safe","fast"]}},"required":["strategy"]}}}),
                    ),
                    "held-question" | "cancel-question" => {
                        let question = format!("question:{session}");
                        send(
                            json!({"jsonrpc":"2.0","id":question,"method":"elicitation/create","params":{"sessionId":session,"mode":"form","message":"Which strategy?","requestedSchema":{"type":"object","properties":{"strategy":{"type":"string","enum":["safe","fast"]}},"required":["strategy"]}}}),
                        );
                        if text == "cancel-question" {
                            cancelled_requests.insert(question.clone());
                            send(
                                json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":question}}),
                            );
                            send(
                                json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":question}}),
                            );
                            send(
                                json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"not-pending"}}),
                            );
                        }
                    }
                    "reuse-forms" | "reuse-forms-cancel" => {
                        assert!(reuse.is_none());
                        reuse = Some((session.into(), 0, text == "reuse-forms-cancel"));
                        reused_form(session, 0);
                    }
                    text if text.starts_with("mcp:") => {
                        let params: Value = serde_json::from_str(&text[4..]).unwrap();
                        let reply = mcp_request(
                            &mcp,
                            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":params}),
                        );
                        update(session, &reply.to_string());
                        result(id, json!({"stopReason":"end_turn"}));
                    }
                    _ => {
                        update(session, "hello");
                        result(id, json!({"stopReason":"end_turn"}));
                    }
                }
                if !matches!(
                    text,
                    "wait"
                        | "ignore-cancel"
                        | "tree"
                        | "permission"
                        | "question"
                        | "foreign"
                        | "held-question"
                        | "cancel-question"
                        | "reuse-forms"
                        | "reuse-forms-cancel"
                ) {
                    pending.remove(session);
                }
            }
            Some("session/cancel") => {
                if mode == "pool-delayed" {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
                if mode == "crash-cancel" {
                    return;
                }
                assert!(message.get("id").is_none());
                let session = params["sessionId"].as_str().unwrap();
                if mode != "ignore-cancel" {
                    if let Some(pending) = pending.remove(session) {
                        update(session, "cancel acknowledged");
                        result(&pending, json!({"stopReason":"cancelled"}));
                    }
                }
            }
            None if id == "permission" => {
                if mode == "interactive" && message["result"]["outcome"]["outcome"] != "cancelled" {
                    assert_eq!(message["result"]["outcome"]["outcome"], "selected");
                } else {
                    assert_eq!(
                        message["result"],
                        json!({"outcome":{"outcome":"cancelled"}})
                    );
                }
                update(session, "permission denied");
                result(&pending[session], json!({"stopReason":"end_turn"}));
                pending.remove(session);
            }
            None if id == "question" => {
                if message["result"]["action"] != "cancel" {
                    assert_eq!(
                        message["result"],
                        json!({"action":"accept","content":{"strategy":"safe"}})
                    );
                }
                result(&pending[session], json!({"stopReason":"end_turn"}));
                pending.remove(session);
            }
            None if id == "q" => {
                let (session, step, cancel_middle) =
                    reuse.as_mut().expect("unexpected extra reused-ID response");
                if *step == 1 && *cancel_middle {
                    assert_eq!(message["error"]["code"], -32800);
                    assert!(message.get("result").is_none());
                } else {
                    let content = if *step < 2 {
                        json!({"strategy":"safe"})
                    } else {
                        json!({"colors":["red"]})
                    };
                    assert_eq!(
                        message["result"],
                        json!({"action":"accept","content":content})
                    );
                    assert!(message.get("error").is_none());
                }
                *step += 1;
                if *step < 3 {
                    reused_form(session, *step);
                    if *step == 1 && *cancel_middle {
                        send(
                            json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"q"}}),
                        );
                    }
                } else {
                    result(
                        &pending.remove(session).expect("live prompt"),
                        json!({"stopReason":"end_turn"}),
                    );
                    reuse = None;
                }
            }
            None if id.as_str().is_some_and(|s| s.starts_with("question:")) => {
                let session = id.as_str().unwrap().strip_prefix("question:").unwrap();
                if cancelled_requests.remove(id.as_str().unwrap()) {
                    assert_eq!(message["error"]["code"], -32800);
                    assert!(message.get("result").is_none());
                } else {
                    assert_eq!(message["result"]["action"], "accept");
                }
                result(&pending[session], json!({"stopReason":"end_turn"}));
                pending.remove(session);
            }
            Some(method @ ("session/load" | "session/resume")) => {
                assert!(params.get("reviewFileIds").is_none());
                if mode == "resume" {
                    assert_eq!(method, "session/resume");
                }
                if mode == "load" {
                    assert_eq!(method, "session/load");
                }
                assert_ne!(mode, "minimal");
                let remote = params["sessionId"].as_str().unwrap();
                remote_sessions.push(remote.into());
                if method == "session/load" {
                    for (role, text) in [
                        ("user_message_chunk", "hello"),
                        ("agent_message_chunk", "hello"),
                    ] {
                        send(
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":remote,"update":{"sessionUpdate":role,"messageId":format!("replayed-{role}"),"content":{"type":"text","text":text}}}}),
                        );
                    }
                }
                result(id, json!({}));
            }
            Some("session/close") => {
                result(id, json!({}));
            }
            Some("session/set_mode") => {
                assert!(matches!(params["modeId"].as_str(), Some("ask" | "review")));
                result(id, json!({}));
            }
            method => panic!("unexpected method {method:?}"),
        }
    }
}

fn mcp_request(server: &Value, message: Value) -> Value {
    use std::io::Read;
    let url = server["url"]
        .as_str()
        .unwrap()
        .strip_prefix("http://")
        .unwrap();
    let (address, path) = url.split_once('/').unwrap();
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let body = message.to_string();
    let auth = server["headers"][0]["value"].as_str().unwrap();
    write!(socket,"POST /{path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}

// The test deliberately leaves this child alive for the supervisor to terminate,
// including when the ACP parent exits first.
#[allow(clippy::zombie_processes)]
fn spawn_descendant() -> String {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("descendant")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut address = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    address.trim().to_owned()
}
