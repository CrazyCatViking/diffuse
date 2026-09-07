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

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "descendant" {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        println!("{}", listener.local_addr().unwrap());
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
    let mut pending = Value::Null;
    let session = "remote-session"; // Deliberate collision across isolated hosts.
    for line in std::io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = &message["id"];
        let params = &message["params"];
        match message["method"].as_str() {
            Some("initialize") => {
                assert_eq!(
                    std::env::var("DIFFUSE_FIXTURE_ALLOWED").as_deref(),
                    Ok("explicit-only")
                );
                assert!(std::env::var_os("HOME").is_none());
                assert_eq!(params["protocolVersion"], 1);
                assert_eq!(params["clientCapabilities"], json!({}));
                if mode == "init-hang" {
                    loop {
                        std::thread::park();
                    }
                }
                if mode == "minimal" {
                    result(id, json!({"protocolVersion":1}));
                    continue;
                }
                result(
                    id,
                    json!({"protocolVersion":if mode == "version" { 999 } else { 1 },"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true}}}),
                );
            }
            Some("session/new") => {
                assert_eq!(params["mcpServers"], json!([]));
                assert_eq!(
                    std::path::Path::new(params["cwd"].as_str().unwrap()),
                    std::env::current_dir().unwrap()
                );
                result(id, json!({"sessionId":session}));
                if mode == "idle-disconnect" {
                    return;
                }
            }
            Some("session/prompt") => {
                assert_eq!(params["sessionId"], session);
                assert_eq!(params["prompt"][0]["type"], "text");
                pending = id.clone();
                match params["prompt"][0]["text"].as_str().unwrap() {
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
                    _ => {
                        update(session, "hello");
                        result(id, json!({"stopReason":"end_turn"}));
                    }
                }
            }
            Some("session/cancel") => {
                assert!(message.get("id").is_none());
                assert_eq!(params["sessionId"], session);
                if mode != "ignore-cancel" {
                    update(session, "cancel acknowledged");
                    result(&pending, json!({"stopReason":"cancelled"}));
                }
            }
            None if id == "permission" => {
                assert_eq!(
                    message["result"],
                    json!({"outcome":{"outcome":"cancelled"}})
                );
                update(session, "permission denied");
                result(&pending, json!({"stopReason":"end_turn"}));
            }
            method => panic!("unexpected method {method:?}"),
        }
    }
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
