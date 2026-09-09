#![cfg(any(unix, windows))]

use diffuse_core::acp::{AdapterDefinition, OpenSessionRequest, SessionState};
use diffuse_core::{
    AppCore, EventSubscription, WorkbenchDatabase, WorkbenchEvent, WorkspaceRequestContext,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tempfile::TempDir;

async fn workspace(core: &AppCore) -> (TempDir, WorkspaceRequestContext) {
    let dir = TempDir::new().unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .arg(dir.path())
        .output()
        .unwrap()
        .status;
    assert!(status.success());
    let snapshot = core.open_workspace(dir.path()).await.unwrap();
    (
        dir,
        WorkspaceRequestContext {
            workspace_id: snapshot.summary.workspace_id,
            workspace_generation: snapshot.summary.workspace_generation,
            request_id: "test".into(),
        },
    )
}
fn adapter(core: &AppCore, id: &str, mode: &str, multiplex: bool) {
    core.save_acp_adapter(AdapterDefinition {
        id: id.into(),
        executable: env!("CARGO_BIN_EXE_diffuse-acp-fixture").into(),
        args: vec![mode.into()],
        environment_keys: vec![],
        authentication_profile: None,
        multiplex,
    })
    .unwrap();
}
fn wait(events: &EventSubscription, session: &str, kind: &str) -> WorkbenchEvent {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|e| panic!("waiting for {session}/{kind}: {e}"));
        if event.kind == "acp/activity"
            && event.payload["session"]["id"] == session
            && event.payload["activity"]["kind"] == kind
        {
            return event;
        }
    }
}
fn queue(
    core: &AppCore,
    context: &WorkspaceRequestContext,
    session: &str,
    request: &str,
    text: &str,
) -> diffuse_core::acp::QueuedTurn {
    core.queue_acp_prompt(
        &WorkspaceRequestContext {
            request_id: request.into(),
            ..context.clone()
        },
        session,
        text,
    )
    .unwrap()
}

async fn exercise_reused_forms(cancel_middle: bool) {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "forms", "forms", false);
    let (_, events) = core.acp_events().subscribe(512);
    let session = core.open_acp_session(&context, "forms", None).unwrap();
    wait(&events, &session, "session-ready");
    queue(
        &core,
        &context,
        &session,
        "reuse",
        if cancel_middle {
            "reuse-forms-cancel"
        } else {
            "reuse-forms"
        },
    );
    let mut ids = Vec::new();
    let mut parameters = Vec::new();
    for step in 0..3 {
        let requested = wait(&events, &session, "input-requested");
        let payload = &requested.payload["activity"]["payload"];
        let id = payload["input"]["id"].as_str().unwrap().to_owned();
        assert!(
            !ids.contains(&id),
            "reused peer ID must create a new durable input"
        );
        ids.push(id.clone());
        parameters.push(payload["params"].clone());
        if step == 1 && cancel_middle {
            let cancelled = wait(&events, &session, "input-cancelled");
            assert_eq!(cancelled.payload["activity"]["payload"]["inputId"], id);
        } else {
            let snapshot = core.workbench_snapshot().unwrap();
            for (previous, previous_id) in ids[..step].iter().enumerate() {
                let expected = if previous == 1 && cancel_middle {
                    diffuse_core::InputRequestStatus::Cancelled
                } else {
                    diffuse_core::InputRequestStatus::ResponseSubmitted
                };
                assert_eq!(
                    snapshot
                        .input_requests
                        .iter()
                        .find(|i| &i.id == previous_id)
                        .unwrap()
                        .status,
                    expected,
                    "old response must retain its own producer bookkeeping"
                );
            }
            let content = if step < 2 {
                json!({"strategy":"safe"})
            } else {
                json!({"colors":["red"]})
            };
            let answer = core
                .answer_input_request(diffuse_core::AnswerInputRequest {
                    workspace_id: context.workspace_id,
                    workspace_generation: context.workspace_generation,
                    input_id: id,
                    expected_revision: 1,
                    response: diffuse_core::InputResponse {
                        value: json!({"action":"accept","content":content}).to_string(),
                        secret: None,
                    },
                    redact_response: false,
                })
                .unwrap();
            assert_eq!(
                answer.input.status,
                diffuse_core::InputRequestStatus::ResponseSubmitted
            );
        }
    }
    assert_eq!(parameters[0], parameters[1]);
    assert_ne!(parameters[1], parameters[2]);
    wait(&events, &session, "turn-ended");
    let snapshot = core.workbench_snapshot().unwrap();
    for (step, id) in ids.iter().enumerate() {
        let expected = if step == 1 && cancel_middle {
            diffuse_core::InputRequestStatus::Cancelled
        } else {
            diffuse_core::InputRequestStatus::Accepted
        };
        assert_eq!(
            snapshot
                .input_requests
                .iter()
                .find(|i| &i.id == id)
                .unwrap()
                .status,
            expected
        );
    }
    assert_eq!(snapshot.aggregate_attention.input_required, 0);
    // Detect a late duplicate response or a poisoned connection after completion.
    queue(&core, &context, &session, "still-healthy", "hello");
    wait(&events, &session, "turn-ended");
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].state,
        SessionState::Ready
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn answered_form_ids_can_be_reused_with_identical_and_different_parameters() {
    exercise_reused_forms(false).await;
}

#[tokio::test]
async fn cancellation_of_reused_id_does_not_cancel_an_earlier_answered_input() {
    exercise_reused_forms(true).await;
}

#[tokio::test]
async fn pool_grows_instead_of_overloading_an_existing_host() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "pool", "pool", true);
    let (_, events) = core.acp_events().subscribe(1024);
    for _ in 0..9 {
        let id = core.open_acp_session(&context, "pool", None).unwrap();
        wait(&events, &id, "session-ready");
    }
    let sessions = core.acp_sessions(&context).unwrap();
    let hosts: std::collections::HashSet<_> = sessions.iter().map(|s| &s.host_id).collect();
    assert_eq!(hosts.len(), 2);
    assert!(sessions.iter().all(|s| s.state == SessionState::Ready));
    core.shutdown().unwrap();
}

#[tokio::test]
async fn reconnect_waits_for_delayed_pooled_worker_cleanup() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "delayed", "pool-delayed", true);
    let (_, events) = core.acp_events().subscribe(512);
    let id = core.open_acp_session(&context, "delayed", None).unwrap();
    wait(&events, &id, "session-ready");
    let other = core.open_acp_session(&context, "delayed", None).unwrap();
    wait(&events, &other, "session-ready");
    let host = core
        .acp_sessions(&context)
        .unwrap()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
        .host_id;
    queue(&core, &context, &id, "old", "wait");
    wait(&events, &id, "session-update");
    core.stop_acp_session(&context, &id).unwrap();
    assert!(
        core.open_acp_session(&context, "delayed", Some(&id))
            .is_err()
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        core.open_acp_session(&context, "delayed", Some(&id))
            .is_err()
    );
    wait(&events, &id, "session-ended");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if core
            .open_acp_session(&context, "delayed", Some(&id))
            .is_ok()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    wait(&events, &id, "session-ready");
    let current = queue(&core, &context, &id, "new", "wait");
    wait(&events, &id, "session-update");
    std::thread::sleep(Duration::from_millis(750));
    let snapshot = core.acp_workspace_snapshot(&context).unwrap();
    assert_eq!(
        snapshot["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["hostId"],
        host
    );
    assert!(
        snapshot["turnsBySession"][&id]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == current.id && t["state"] == "running")
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn request_cancellation_replies_once_and_peer_completes_without_session_cancel() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "pool", "pool", true);
    let (_, events) = core.acp_events().subscribe(512);
    let first = core.open_acp_session(&context, "pool", None).unwrap();
    wait(&events, &first, "session-ready");
    let second = core.open_acp_session(&context, "pool", None).unwrap();
    wait(&events, &second, "session-ready");
    queue(&core, &context, &first, "held", "held-question");
    let held = wait(&events, &first, "input-requested");
    let held_id = held.payload["activity"]["payload"]["input"]["id"]
        .as_str()
        .unwrap();
    queue(&core, &context, &second, "cancel", "cancel-question");
    wait(&events, &second, "input-cancelled");
    // The peer waits for the original question's -32800 response before it
    // completes this prompt. No client session/cancel is needed to release it.
    wait(&events, &second, "turn-ended");
    let snapshot = core.workbench_snapshot().unwrap();
    assert_eq!(
        snapshot
            .input_requests
            .iter()
            .find(|i| i.id == held_id)
            .unwrap()
            .status,
        diffuse_core::InputRequestStatus::Pending
    );
    assert!(
        snapshot
            .input_requests
            .iter()
            .any(|i| i.status == diffuse_core::InputRequestStatus::Cancelled)
    );
    assert!(core.acp_sessions(&context).unwrap().iter().all(|s| s.state
        == if s.id == first {
            SessionState::Running
        } else {
            SessionState::Ready
        }));
    core.answer_input_request(diffuse_core::AnswerInputRequest {
        workspace_id: context.workspace_id,
        workspace_generation: context.workspace_generation,
        input_id: held_id.into(),
        expected_revision: 1,
        response: diffuse_core::InputResponse {
            value: json!({"action":"accept","content":{"strategy":"safe"}}).to_string(),
            secret: None,
        },
        redact_response: false,
    })
    .unwrap();
    wait(&events, &first, "turn-ended");
    queue(&core, &context, &second, "still-healthy", "hello");
    wait(&events, &second, "turn-ended");
    assert!(
        core.acp_sessions(&context)
            .unwrap()
            .iter()
            .all(|s| s.state == SessionState::Ready)
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn bulk_terminal_turn_events_reduce_to_the_persisted_snapshot() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "fake", "", false);
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.open_acp_session(&context, "fake", None).unwrap();
    wait(&events, &id, "session-ready");
    let fence = core.acp_events().current_sequence();
    queue(&core, &context, &id, "active", "wait");
    wait(&events, &id, "session-update");
    for n in 0..5 {
        queue(&core, &context, &id, &format!("queued-{n}"), "hello");
    }
    core.stop_acp_session(&context, &id).unwrap();
    wait(&events, &id, "session-ended");
    let replay = core.acp_events().replay_after(fence);
    assert!(!replay.requires_snapshot);
    let mut states = std::collections::BTreeMap::new();
    for event in replay
        .events
        .into_iter()
        .filter(|e| e.kind == "agent/turnChanged" && e.payload["sessionId"] == id)
    {
        states.insert(
            event.payload["id"].as_str().unwrap().to_owned(),
            event.payload["state"].clone(),
        );
    }
    let snapshot = core.acp_workspace_snapshot(&context).unwrap();
    let persisted: std::collections::BTreeMap<_, _> = snapshot["turnsBySession"][&id]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["id"].as_str().unwrap().to_owned(), t["state"].clone()))
        .collect();
    assert_eq!(states, persisted);
    assert_eq!(states.len(), 6);
    assert!(states.values().all(|s| s == "cancelled"));
    core.shutdown().unwrap();
}

#[tokio::test]
async fn blocked_git_tool_is_reaped_on_deadline_and_workspace_close() {
    for action in ["timeout", "close"] {
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let (dir, context) = workspace(&core).await;
        let marker_dir = TempDir::new().unwrap();
        let marker = marker_dir.path().join("started");
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(dir.path())
                    .args(args)
                    .env("GIT_AUTHOR_NAME", "Fixture")
                    .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
                    .env("GIT_COMMITTER_NAME", "Fixture")
                    .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        std::fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        std::fs::write(dir.path().join(".gitattributes"), "file.txt diff=blocked\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);
        std::fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        let command = format!(
            "'{}' git-blocker '{}'",
            env!("CARGO_BIN_EXE_diffuse-acp-fixture"),
            marker.display()
        );
        git(&["config", "diff.blocked.textconv", &command]);
        let store = diffuse_core::review::ReviewStore::new(dir.path());
        store.create_session(serde_json::from_value(json!({"id":"blocked","repositoryRoot":dir.path().to_str().unwrap(),"target":{"base":"HEAD","includeStaged":true,"includeUnstaged":true},"headAtCreation":"HEAD","createdAt":"0","updatedAt":"0","status":"active","participants":[]})).unwrap()).unwrap();
        adapter(&core, "mcp", "mcp", false);
        let (_, events) = core.acp_events().subscribe(256);
        let id = core
            .launch_acp_session(OpenSessionRequest {
                context: context.clone(),
                adapter_id: "mcp".into(),
                session_id: None,
                review_session_id: Some("blocked".into()),
                review_file_ids: None,
                interactive: false,
            })
            .unwrap();
        wait(&events, &id, "session-ready");
        queue(
            &core,
            &context,
            &id,
            "blocked",
            &format!(
                "mcp:{}",
                json!({"name":"readDiff","arguments":{"fileId":"file.txt"}})
            ),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let address = loop {
            if let Ok(address) = std::fs::read_to_string(&marker) {
                if !address.is_empty() {
                    break address;
                }
            }
            assert!(Instant::now() < deadline, "Git textconv did not start");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(std::net::TcpListener::bind(&address).is_err());
        let started = Instant::now();
        if action == "close" {
            core.close_workspace(&diffuse_core::CloseWorkspaceRequest {
                workspace_id: context.workspace_id,
                workspace_generation: context.workspace_generation,
                force: true,
            })
            .unwrap();
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "close did not interrupt Git"
            );
        } else {
            wait(&events, &id, "session-ended");
            assert!(started.elapsed() < Duration::from_secs(13));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while std::net::TcpListener::bind(&address).is_err() {
            assert!(
                Instant::now() < deadline,
                "tool descendant survived {action}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        core.shutdown().unwrap();
    }
}

#[tokio::test]
async fn pooled_sessions_queue_cancel_and_crash_only_their_mapped_host() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_a, a) = workspace(&core).await;
    let (_b, b) = workspace(&core).await;
    adapter(&core, "pool", "pool", true);
    let (_, events) = core.acp_events().subscribe(1024);
    let first = core.open_acp_session(&a, "pool", None).unwrap();
    wait(&events, &first, "session-ready");
    let second = core.open_acp_session(&a, "pool", None).unwrap();
    wait(&events, &second, "session-ready");
    let other = core.open_acp_session(&b, "pool", None).unwrap();
    wait(&events, &other, "session-ready");
    let sessions = core.acp_sessions(&a).unwrap();
    assert_eq!(sessions[0].host_id, sessions[1].host_id);
    assert_ne!(sessions[0].remote_session_id, sessions[1].remote_session_id);
    assert_ne!(
        sessions[0].host_id,
        core.acp_sessions(&b).unwrap()[0].host_id
    );
    queue(&core, &a, &first, "wait-a", "wait");
    wait(&events, &first, "session-update");
    queue(&core, &a, &second, "wait-b", "wait");
    wait(&events, &second, "session-update");
    let queued = queue(&core, &a, &first, "queued", "hello");
    assert_eq!(queued.id, queue(&core, &a, &first, "queued", "hello").id);
    assert!(
        core.queue_acp_prompt(
            &WorkspaceRequestContext {
                request_id: "queued".into(),
                ..a.clone()
            },
            &first,
            "different"
        )
        .is_err()
    );
    let cancelled = queue(&core, &a, &first, "cancel-queued", "never execute");
    assert!(
        !core
            .cancel_queued_acp_turn(&b, &first, &cancelled.id)
            .unwrap()
    );
    assert!(
        core.cancel_queued_acp_turn(&a, &first, &cancelled.id)
            .unwrap()
    );
    core.cancel_acp_session(&a, &first).unwrap();
    wait(&events, &first, "turn-ended");
    wait(&events, &first, "turn-ended");
    let snapshot = core.acp_workspace_snapshot(&a).unwrap();
    assert!(
        snapshot["turnsBySession"][&first]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == queued.id && t["state"] == "completed")
    );
    assert!(
        snapshot["turnsBySession"][&first]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == cancelled.id && t["state"] == "cancelled")
    );
    let (_, crash_events) = core.acp_events().subscribe(256);
    queue(&core, &a, &first, "crash", "disconnect");
    let mut ended = std::collections::HashSet::new();
    while ended.len() < 2 {
        let event = crash_events.recv_timeout(Duration::from_secs(10)).unwrap();
        if event.kind == "acp/activity" && event.payload["activity"]["kind"] == "session-ended" {
            assert_eq!(event.payload["session"]["state"], "failed");
            ended.insert(event.payload["session"]["id"].as_str().unwrap().to_owned());
        }
    }
    assert!(ended.contains(&first) && ended.contains(&second));
    assert_eq!(core.acp_sessions(&b).unwrap()[0].state, SessionState::Ready);
    assert_eq!(
        core.acp_workspace_snapshot(&a).unwrap()["summary"]["attention"]["running"],
        0
    );
    assert!(
        core.workbench_snapshot()
            .unwrap()
            .aggregate_attention
            .errors
            > 0
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn durable_inactive_questions_and_explicit_permissions_are_confirmed_by_peer() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_a, a) = workspace(&core).await;
    let (_b, b) = workspace(&core).await;
    adapter(&core, "interactive", "interactive", false);
    let (_, events) = core.acp_events().subscribe(512);
    let id = core
        .launch_acp_session(OpenSessionRequest {
            context: a.clone(),
            adapter_id: "interactive".into(),
            session_id: None,
            review_session_id: None,
            review_file_ids: None,
            interactive: true,
        })
        .unwrap();
    wait(&events, &id, "session-ready");
    for (request, text, response) in [
        (
            "question",
            "question",
            r#"{"action":"accept","content":{"strategy":"safe"}}"#,
        ),
        ("permission", "permission", "all"),
    ] {
        queue(&core, &a, &id, request, text);
        let asked = wait(&events, &id, "input-requested");
        let input_id = asked.payload["activity"]["payload"]["input"]["id"]
            .as_str()
            .unwrap();
        let snapshot = core.workbench_snapshot().unwrap();
        assert_eq!(snapshot.active_workspace_id, Some(b.workspace_id));
        let input = snapshot
            .input_requests
            .iter()
            .find(|i| i.id == input_id)
            .unwrap();
        let reloaded = core.acp_workspace_snapshot(&a).unwrap();
        assert_eq!(reloaded["inputs"][0]["input"]["id"], input_id);
        assert!(reloaded["inputs"][0]["params"].is_object());
        assert_eq!(input.workspace_id, a.workspace_id);
        assert!(snapshot.aggregate_attention.input_required > 0);
        let answer = core
            .answer_input_request(diffuse_core::AnswerInputRequest {
                workspace_id: a.workspace_id,
                workspace_generation: a.workspace_generation,
                input_id: input_id.into(),
                expected_revision: 1,
                response: diffuse_core::InputResponse {
                    value: response.into(),
                    secret: None,
                },
                redact_response: false,
            })
            .unwrap();
        assert_eq!(
            answer.input.status,
            diffuse_core::InputRequestStatus::ResponseSubmitted
        );
        wait(&events, &id, "turn-ended");
        assert_eq!(
            core.workbench_snapshot()
                .unwrap()
                .input_requests
                .iter()
                .find(|i| i.id == input_id)
                .unwrap()
                .status,
            diffuse_core::InputRequestStatus::Accepted
        );
    }
    assert!(
        core.acp_history(&a, &id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "input-request")
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn queued_prompt_survives_host_failure_and_database_reopen_without_retrying_active_turn() {
    let storage = TempDir::new().unwrap();
    let database = storage.path().join("workbench.sqlite3");
    let core = AppCore::new(WorkbenchDatabase::open(&database).unwrap());
    let (dir, context) = workspace(&core).await;
    adapter(&core, "crash", "crash-cancel", false);
    let (_, events) = core.acp_events().subscribe(512);
    let id = core.open_acp_session(&context, "crash", None).unwrap();
    wait(&events, &id, "session-ready");
    let active = queue(&core, &context, &id, "active", "wait");
    wait(&events, &id, "session-update");
    let pending = queue(&core, &context, &id, "pending", "hello");
    core.cancel_acp_session(&context, &id).unwrap();
    wait(&events, &id, "session-ended");
    core.shutdown().unwrap();
    drop(core);
    let core = AppCore::new(WorkbenchDatabase::open(&database).unwrap());
    let opened = core.open_workspace(dir.path()).await.unwrap();
    let context = WorkspaceRequestContext {
        workspace_generation: opened.summary.workspace_generation,
        ..context
    };
    let snapshot = core.acp_workspace_snapshot(&context).unwrap();
    assert!(
        snapshot["turnsBySession"][&id]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == pending.id && t["state"] == "queued")
    );
    let (_, events) = core.acp_events().subscribe(512);
    core.open_acp_session(&context, "crash", Some(&id)).unwrap();
    wait(&events, &id, "turn-ended");
    let snapshot = core.acp_workspace_snapshot(&context).unwrap();
    assert!(
        snapshot["turnsBySession"][&id]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == pending.id && t["state"] == "completed")
    );
    assert!(
        snapshot["turnsBySession"][&id]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == active.id && t["state"] == "failed")
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn mode_changes_are_capability_gated_persisted_and_reject_overlap() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "modes", "modes", false);
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.open_acp_session(&context, "modes", None).unwrap();
    wait(&events, &id, "session-ready");
    assert!(core.set_acp_mode(&context, &id, "unadvertised").is_err());
    assert_eq!(
        core.set_acp_mode(&context, &id, "review").unwrap(),
        json!({"modeId":"review"})
    );
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].modes["currentModeId"],
        "review"
    );
    assert!(
        core.acp_history(&context, &id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "mode" && e.content["modeId"] == "review")
    );
    queue(&core, &context, &id, "wait", "wait");
    wait(&events, &id, "turn-started");
    assert!(core.set_acp_mode(&context, &id, "ask").is_err());
    core.shutdown().unwrap();
}

#[tokio::test]
async fn visible_updates_are_normalized_and_thoughts_are_not_persisted() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "updates", "updates", false);
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.open_acp_session(&context, "updates", None).unwrap();
    wait(&events, &id, "session-ready");
    queue(&core, &context, &id, "updates", "updates");
    wait(&events, &id, "turn-ended");
    let history = core.acp_history(&context, &id, 0).unwrap();
    for kind in ["user-message", "agent-message", "tool-call", "plan", "mode"] {
        assert!(history.iter().any(|e| e.kind == kind), "missing {kind}");
    }
    assert_eq!(
        history.iter().filter(|e| e.kind == "agent-message").count(),
        2
    );
    assert!(
        !serde_json::to_string(&history)
            .unwrap()
            .contains("must-not-persist")
    );
    assert!(
        !serde_json::to_string(&core.acp_activity(&context, &id, 0).unwrap())
            .unwrap()
            .contains("must-not-persist")
    );
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].modes["currentModeId"],
        "review"
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn cancelled_input_is_not_delivered_as_a_grant() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    adapter(&core, "question", "question", false);
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.open_acp_session(&context, "question", None).unwrap();
    wait(&events, &id, "session-ready");
    queue(&core, &context, &id, "question", "question");
    let requested = wait(&events, &id, "input-requested");
    let input = requested.payload["activity"]["payload"]["input"]["id"]
        .as_str()
        .unwrap();
    core.cancel_acp_session(&context, &id).unwrap();
    wait(&events, &id, "turn-ended");
    assert_eq!(
        core.workbench_snapshot()
            .unwrap()
            .input_requests
            .iter()
            .find(|i| i.id == input)
            .unwrap()
            .status,
        diffuse_core::InputRequestStatus::Cancelled
    );
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].state,
        SessionState::Ready
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn restart_reconnect_uses_resume_load_or_marks_new_session_fallback() {
    for mode in ["resume", "load", "minimal"] {
        let storage = TempDir::new().unwrap();
        let path = storage.path().join("workbench.sqlite3");
        let core = AppCore::new(WorkbenchDatabase::open(&path).unwrap());
        let (dir, context) = workspace(&core).await;
        adapter(&core, "persisted", mode, false);
        let (_, events) = core.acp_events().subscribe(256);
        let id = core.open_acp_session(&context, "persisted", None).unwrap();
        wait(&events, &id, "session-ready");
        queue(&core, &context, &id, "first", "hello");
        wait(&events, &id, "turn-ended");
        let host = core.acp_sessions(&context).unwrap()[0].host_id.clone();
        core.shutdown().unwrap();
        drop(core);
        let core = AppCore::new(WorkbenchDatabase::open(&path).unwrap());
        assert_eq!(core.discover_acp_adapters().unwrap().len(), 1);
        let opened = core.open_workspace(dir.path()).await.unwrap();
        let context = WorkspaceRequestContext {
            workspace_generation: opened.summary.workspace_generation,
            ..context
        };
        let (_, events) = core.acp_events().subscribe(256);
        assert_eq!(
            core.open_acp_session(&context, "persisted", Some(&id))
                .unwrap(),
            id
        );
        wait(&events, &id, "session-ready");
        assert_ne!(core.acp_sessions(&context).unwrap()[0].host_id, host);
        let history = core.acp_activity(&context, &id, 0).unwrap();
        assert_eq!(
            history.iter().any(|e| e.kind == "continuity-lost"),
            mode == "minimal"
        );
        queue(&core, &context, &id, "second", "hello");
        wait(&events, &id, "turn-ended");
        assert_eq!(
            core.acp_history(&context, &id, 0)
                .unwrap()
                .iter()
                .filter(|e| e.kind == "user-message")
                .count(),
            2
        );
        core.shutdown().unwrap();
    }
}

#[tokio::test]
async fn scoped_mcp_writes_portable_review_artifacts_and_rejects_foreign_scope() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (dir, context) = workspace(&core).await;
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    std::fs::write(dir.path().join("file.txt"), "before\n").unwrap();
    git(&["add", "file.txt"]);
    git(&["commit", "-m", "base"]);
    std::fs::write(dir.path().join("file.txt"), "after\n").unwrap();
    let store = diffuse_core::review::ReviewStore::new(dir.path());
    store.create_session(serde_json::from_value(json!({"id":"review","repositoryRoot":dir.path().to_str().unwrap(),"target":{"base":"HEAD","includeStaged":true,"includeUnstaged":true},"headAtCreation":"HEAD","createdAt":"0","updatedAt":"0","status":"active","participants":[]})).unwrap()).unwrap();
    adapter(&core, "mcp", "mcp", false);
    let (_, events) = core.acp_events().subscribe(512);
    let id = core
        .launch_acp_session(OpenSessionRequest {
            context: context.clone(),
            adapter_id: "mcp".into(),
            session_id: None,
            review_session_id: Some("review".into()),
            review_file_ids: None,
            interactive: false,
        })
        .unwrap();
    wait(&events, &id, "session-ready");
    for (n,(name,args,denied)) in [
        ("listChangedFiles",json!({}),false),
        ("readDiff",json!({"fileId":"file.txt"}),false),
        ("addFinding",json!({"filePath":"file.txt","side":"new","startLine":1,"endLine":1,"body":"Check this line"}),false),
        ("updateProgress",json!({"status":"completed","reviewedFiles":1,"completedFiles":["file.txt"]}),false),
        ("updateReviewedFiles",json!({"files":{"file.txt":{"fileId":"file.txt","reviewedAt":"0","reviewedBy":"agent","signature":"test"}}}),false),
        ("readThreads",json!({}),false),
        ("reportActivity",json!({"message":"Checking the selected review"}),false),
        ("readDiff",json!({"fileId":"../secret"}),true),
        ("addFinding",json!({"filePath":"file.txt","side":"new","startLine":999,"endLine":999,"body":"bad anchor"}),true),
        ("updateProgress",json!({"workspaceId":"foreign","status":"completed"}),true),
        ("updateReviewedFiles",json!({"files":{"foreign":{"fileId":"foreign","reviewedAt":"0","reviewedBy":"agent","signature":"x"}}}),true),
    ].into_iter().enumerate() {
        queue(&core,&context,&id,&format!("tool-{n}"),&format!("mcp:{}",json!({"name":name,"arguments":args})));
        let output=wait(&events,&id,"session-update");
        let response:Value=serde_json::from_str(output.payload["activity"]["payload"]["content"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(response["result"]["isError"],denied,"{name}: {response}");
        wait(&events,&id,"turn-ended");
    }
    assert_eq!(store.get_threads("review").unwrap().len(), 1);
    assert_eq!(
        store.get_progress("review").unwrap().unwrap().status,
        diffuse_core::review::ReviewProgressStatus::Completed
    );
    assert!(
        store
            .get_reviewed_files("review")
            .unwrap()
            .files
            .contains_key("file.txt")
    );
    queue(&core, &context, &id, "denied-permission", "permission");
    wait(&events, &id, "turn-ended");
    assert_eq!(
        core.workbench_snapshot()
            .unwrap()
            .aggregate_attention
            .input_required,
        0
    );
    core.shutdown().unwrap();
}

fn git_ok(dir: &std::path::Path, args: &[&str]) {
    assert!(
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
            .output()
            .unwrap()
            .status
            .success()
    );
}

fn shard_request(
    context: &WorkspaceRequestContext,
    session: Option<&str>,
    files: Option<Vec<&str>>,
) -> OpenSessionRequest {
    OpenSessionRequest {
        context: context.clone(),
        adapter_id: "mcp".into(),
        session_id: session.map(str::to_owned),
        review_session_id: Some("sharded-review".into()),
        review_file_ids: files.map(|ids| ids.into_iter().map(str::to_owned).collect()),
        interactive: false,
    }
}

#[allow(clippy::too_many_arguments)]
fn tool_call(
    core: &AppCore,
    context: &WorkspaceRequestContext,
    events: &EventSubscription,
    session: &str,
    request: &str,
    name: &str,
    args: Value,
    denied: bool,
) -> Value {
    queue(
        core,
        context,
        session,
        request,
        &format!("mcp:{}", json!({"name":name,"arguments":args})),
    );
    let output = wait(events, session, "session-update");
    let response: Value = serde_json::from_str(
        output.payload["activity"]["payload"]["content"]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(response["result"]["isError"], denied, "{name}: {response}");
    wait(events, session, "turn-ended");
    if denied {
        response
    } else {
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn literal_git_filenames_cannot_bypass_mcp_shards_or_finding_anchors() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (dir, context) = workspace(&core).await;
    let names = [
        "*.txt",
        "[ab].txt",
        ":(glob)*.txt",
        ":(literal)*.txt",
        ":(exclude)private.txt",
        ":(icase)case.txt",
        "line\nname.txt",
        "tab\tname.txt",
    ];
    let private_names = [
        "private.txt",
        "a.txt",
        "b.txt",
        "CASE.txt",
        "\"line\\nname.txt\"",
        "\"tab\\tname.txt\"",
    ];
    for (index, name) in names.iter().enumerate() {
        std::fs::write(dir.path().join(name), format!("owned-{index}-before\n")).unwrap();
    }
    let private_before = (1..=9)
        .map(|line| format!("PRIVATE_before_{line}\n"))
        .collect::<String>();
    for name in private_names {
        std::fs::write(dir.path().join(name), &private_before).unwrap();
    }
    git_ok(dir.path(), &["--literal-pathspecs", "add", "."]);
    git_ok(dir.path(), &["commit", "-m", "literal filenames"]);
    for (index, name) in names.iter().enumerate() {
        std::fs::write(dir.path().join(name), format!("owned-{index}-after\n")).unwrap();
    }
    let private_after = private_before.replace("PRIVATE_before_7", "PRIVATE_SECRET_after_7");
    for name in private_names {
        std::fs::write(dir.path().join(name), &private_after).unwrap();
    }
    let store = diffuse_core::review::ReviewStore::new(dir.path());
    store.create_session(serde_json::from_value(json!({"id":"sharded-review","repositoryRoot":dir.path().to_str().unwrap(),"target":{"base":"HEAD","includeStaged":true,"includeUnstaged":true},"headAtCreation":"HEAD","createdAt":"0","updatedAt":"0","status":"active","participants":[]})).unwrap()).unwrap();
    adapter(&core, "mcp", "mcp", false);
    let (_, events) = core.acp_events().subscribe(512);
    for (index, name) in names.iter().enumerate() {
        let id = core
            .launch_acp_session(shard_request(&context, None, Some(vec![name])))
            .unwrap();
        wait(&events, &id, "session-ready");
        let listed = tool_call(
            &core,
            &context,
            &events,
            &id,
            "list",
            "listChangedFiles",
            json!({}),
            false,
        );
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], *name);
        let diff = tool_call(
            &core,
            &context,
            &events,
            &id,
            "diff",
            "readDiff",
            json!({"fileId":name}),
            false,
        );
        let text = diff["diff"].as_str().unwrap();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("diff --git "))
                .count(),
            1,
            "{name}: {text}"
        );
        assert!(
            text.contains(&format!("-owned-{index}-before"))
                && text.contains(&format!("+owned-{index}-after")),
            "{name}: {text}"
        );
        assert!(!text.contains("PRIVATE_"), "{name}: {text}");
        for other in 0..names.len() {
            if other != index {
                assert!(!text.contains(&format!("owned-{other}-")), "{name}: {text}");
            }
        }
        // Line 7 is changed in the unassigned files, never in the assigned file.
        for side in ["old", "new"] {
            tool_call(
                &core,
                &context,
                &events,
                &id,
                &format!("deny-{side}"),
                "addFinding",
                json!({"filePath":name,"side":side,"startLine":7,"endLine":7,"body":"must not anchor to an unassigned file"}),
                true,
            );
        }
        tool_call(
            &core,
            &context,
            &events,
            &id,
            "valid-finding",
            "addFinding",
            json!({"filePath":name,"side":"new","startLine":1,"endLine":1,"body":"assigned line only"}),
            false,
        );
        core.stop_acp_session(&context, &id).unwrap();
        wait(&events, &id, "session-ended");
    }
    let threads = store.get_threads("sharded-review").unwrap();
    assert_eq!(threads.len(), names.len());
    assert!(
        threads
            .iter()
            .all(|thread| names.contains(&thread.file_id.as_str()))
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn immutable_shards_are_enforced_by_every_review_tool_and_survive_reconnect() {
    let storage = TempDir::new().unwrap();
    let database = storage.path().join("workbench.sqlite3");
    let core = AppCore::new(WorkbenchDatabase::open(&database).unwrap());
    let (dir, context) = workspace(&core).await;
    for file in ["a.txt", "b.txt"] {
        std::fs::write(dir.path().join(file), "before\n").unwrap();
    }
    git_ok(dir.path(), &["add", "."]);
    git_ok(dir.path(), &["commit", "-m", "base"]);
    for file in ["a.txt", "b.txt"] {
        std::fs::write(dir.path().join(file), "after\n").unwrap();
    }
    let store = diffuse_core::review::ReviewStore::new(dir.path());
    store.create_session(serde_json::from_value(json!({"id":"sharded-review","repositoryRoot":dir.path().to_str().unwrap(),"target":{"base":"HEAD","includeStaged":true,"includeUnstaged":true},"headAtCreation":"HEAD","createdAt":"0","updatedAt":"0","status":"active","participants":[]})).unwrap()).unwrap();
    store.add_comment_payload("sharded-review","seed-b",serde_json::from_value(json!({"filePath":"b.txt","side":"new","startLine":1,"endLine":1,"body":"B private thread"})).unwrap()).unwrap();
    store.save_progress("sharded-review",serde_json::from_value(json!({"status":"running","totalFiles":2,"reviewedFiles":0,"activeFiles":["b.txt"],"pendingFiles":["a.txt"],"completedFiles":[],"message":"B private progress"})).unwrap()).unwrap();
    store.update_reviewed_files("sharded-review",serde_json::from_value(json!({"files":{"b.txt":{"fileId":"b.txt","reviewedAt":"0","reviewedBy":"B","signature":"B private signature"}}})).unwrap()).unwrap();
    adapter(&core, "mcp", "mcp", false);

    for files in [vec![], vec!["a.txt", "a.txt"], vec!["not-changed.txt"]] {
        assert!(
            core.launch_acp_session(shard_request(&context, None, Some(files)))
                .is_err()
        );
    }
    let mut missing_review = shard_request(&context, None, Some(vec!["a.txt"]));
    missing_review.review_session_id = None;
    assert!(core.launch_acp_session(missing_review).is_err());
    assert!(core.acp_sessions(&context).unwrap().is_empty());

    let (_, events) = core.acp_events().subscribe(1024);
    let a = core
        .launch_acp_session(shard_request(&context, None, Some(vec!["a.txt"])))
        .unwrap();
    wait(&events, &a, "session-ready");
    let b = core
        .launch_acp_session(shard_request(&context, None, Some(vec!["b.txt"])))
        .unwrap();
    wait(&events, &b, "session-ready");
    let whole = core
        .launch_acp_session(shard_request(&context, None, None))
        .unwrap();
    wait(&events, &whole, "session-ready");
    let both = core
        .launch_acp_session(shard_request(&context, None, Some(vec!["b.txt", "a.txt"])))
        .unwrap();
    wait(&events, &both, "session-ready");
    assert_eq!(
        core.acp_sessions(&context)
            .unwrap()
            .into_iter()
            .find(|s| s.id == both)
            .unwrap()
            .review_file_ids,
        Some(vec!["a.txt".into(), "b.txt".into()])
    );
    assert!(
        serde_json::to_value(
            core.acp_sessions(&context)
                .unwrap()
                .into_iter()
                .find(|s| s.id == whole)
                .unwrap()
        )
        .unwrap()
        .get("reviewFileIds")
        .is_none()
    );
    let a_snapshot = core
        .acp_sessions(&context)
        .unwrap()
        .into_iter()
        .find(|s| s.id == a)
        .unwrap();
    assert_eq!(a_snapshot.review_file_ids, Some(vec!["a.txt".into()]));
    assert_eq!(
        serde_json::to_value(&a_snapshot).unwrap()["reviewFileIds"],
        json!(["a.txt"])
    );

    let listed = tool_call(
        &core,
        &context,
        &events,
        &a,
        "list-a",
        "listChangedFiles",
        json!({}),
        false,
    );
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a.txt"]
    );
    assert_eq!(
        tool_call(
            &core,
            &context,
            &events,
            &a,
            "threads-empty",
            "readThreads",
            json!({}),
            false
        ),
        json!([])
    );
    assert_eq!(
        tool_call(
            &core,
            &context,
            &events,
            &whole,
            "list-whole",
            "listChangedFiles",
            json!({}),
            false
        )
        .as_array()
        .unwrap()
        .len(),
        2
    );
    for (n,(name,args)) in [
        ("listChangedFiles",json!({"reviewFileIds":["b.txt"]})),
        ("readDiff",json!({"fileId":"b.txt"})),
        ("readDiff",json!({"fileId":"a.txt","reviewSessionId":"other"})),
        ("addFinding",json!({"filePath":"b.txt","side":"new","startLine":1,"endLine":1,"body":"out of shard"})),
        ("updateProgress",json!({"status":"running","activeFiles":["b.txt"]})),
        ("updateProgress",json!({"status":"running","pendingFiles":["b.txt"]})),
        ("updateProgress",json!({"status":"completed","completedFiles":["b.txt"]})),
        ("updateProgress",json!({"status":"running","totalFiles":2})),
        ("updateProgress",json!({"status":"completed","reviewedFiles":1})),
        ("updateProgress",json!({"status":"running","activeFiles":["a.txt"],"completedFiles":["a.txt"]})),
        ("updateReviewedFiles",json!({"files":{"b.txt":{"fileId":"b.txt","reviewedAt":"1","reviewedBy":"A","signature":"wrong"}}})),
        ("updateReviewedFiles",json!({"files":{"a.txt":{"fileId":"b.txt","reviewedAt":"1","reviewedBy":"A","signature":"wrong"}}})),
        ("updateReviewedFiles",json!({"removeFileIds":["b.txt"]})),
        ("readThreads",json!({"fileId":"b.txt"})),
    ].into_iter().enumerate() {
        tool_call(&core,&context,&events,&a,&format!("deny-{n}"),name,args,true);
    }
    assert_eq!(store.get_threads("sharded-review").unwrap().len(), 1);
    assert_eq!(
        store
            .get_progress("sharded-review")
            .unwrap()
            .unwrap()
            .active_files,
        Some(vec!["b.txt".into()])
    );
    assert!(
        !store
            .get_reviewed_files("sharded-review")
            .unwrap()
            .files
            .contains_key("a.txt")
    );

    let diff = tool_call(
        &core,
        &context,
        &events,
        &a,
        "read-a",
        "readDiff",
        json!({"fileId":"a.txt"}),
        false,
    );
    assert_eq!(diff["fileId"], "a.txt");
    tool_call(
        &core,
        &context,
        &events,
        &a,
        "finding-a",
        "addFinding",
        json!({"filePath":"a.txt","side":"new","startLine":1,"endLine":1,"body":"A finding"}),
        false,
    );
    let threads = tool_call(
        &core,
        &context,
        &events,
        &a,
        "threads-a",
        "readThreads",
        json!({}),
        false,
    );
    assert_eq!(threads.as_array().unwrap().len(), 1);
    assert!(!threads.to_string().contains("B private"));
    let reviewed = tool_call(
        &core,
        &context,
        &events,
        &a,
        "reviewed-a",
        "updateReviewedFiles",
        json!({"files":{"a.txt":{"fileId":"a.txt","reviewedAt":"1","reviewedBy":"A","signature":"A signature"}}}),
        false,
    );
    assert!(reviewed["files"].get("a.txt").is_some());
    assert!(reviewed["files"].get("b.txt").is_none());
    assert_eq!(
        store.get_reviewed_files("sharded-review").unwrap().files["b.txt"].signature,
        "B private signature"
    );
    let progress = tool_call(
        &core,
        &context,
        &events,
        &a,
        "complete-a",
        "updateProgress",
        json!({"status":"completed","totalFiles":1,"reviewedFiles":1,"completedFiles":["a.txt"]}),
        false,
    );
    assert_eq!(progress["totalFiles"], 1);
    assert_eq!(progress["completedFiles"], json!(["a.txt"]));
    assert!(!progress.to_string().contains("b.txt"));
    assert!(!progress.to_string().contains("B private"));
    let global = store.get_progress("sharded-review").unwrap().unwrap();
    assert_eq!(global.total_files, Some(2));
    assert_eq!(global.reviewed_files, Some(1));
    assert_eq!(
        global.status,
        diffuse_core::review::ReviewProgressStatus::Running
    );
    assert_eq!(global.active_files, Some(vec!["b.txt".into()]));
    tool_call(
        &core,
        &context,
        &events,
        &b,
        "complete-b",
        "updateProgress",
        json!({"status":"completed","reviewedFiles":1,"completedFiles":["b.txt"]}),
        false,
    );
    assert_eq!(
        store
            .get_progress("sharded-review")
            .unwrap()
            .unwrap()
            .completed_files,
        Some(vec!["a.txt".into(), "b.txt".into()])
    );
    assert_eq!(
        store
            .get_progress("sharded-review")
            .unwrap()
            .unwrap()
            .status,
        diffuse_core::review::ReviewProgressStatus::Completed
    );
    core.shutdown().unwrap();
    drop(core);

    let restored = AppCore::new(WorkbenchDatabase::open(&database).unwrap());
    let opened = restored.open_workspace(dir.path()).await.unwrap();
    let context = WorkspaceRequestContext {
        workspace_generation: opened.summary.workspace_generation,
        ..context
    };
    assert!(
        restored
            .launch_acp_session(shard_request(
                &context,
                Some(&a),
                Some(vec!["a.txt", "b.txt"])
            ))
            .is_err()
    );
    assert!(
        restored
            .launch_acp_session(shard_request(&context, Some(&a), Some(vec!["b.txt"])))
            .is_err()
    );
    assert!(
        restored
            .launch_acp_session(shard_request(&context, Some(&whole), Some(vec!["a.txt"])))
            .is_err()
    );
    assert!(
        restored
            .launch_acp_session(shard_request(&context, Some(&both), Some(vec!["a.txt"])))
            .is_err()
    );
    let (_, events) = restored.acp_events().subscribe(256);
    // Omission on reconnect inherits the saved assignment, not whole-review access.
    restored
        .open_acp_session(&context, "mcp", Some(&a))
        .unwrap();
    wait(&events, &a, "session-ready");
    assert_eq!(
        restored
            .acp_sessions(&context)
            .unwrap()
            .into_iter()
            .find(|s| s.id == a)
            .unwrap()
            .review_file_ids,
        Some(vec!["a.txt".into()])
    );
    assert_eq!(
        tool_call(
            &restored,
            &context,
            &events,
            &a,
            "after-reconnect",
            "listChangedFiles",
            json!({}),
            false
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    tool_call(
        &restored,
        &context,
        &events,
        &a,
        "still-denied",
        "readDiff",
        json!({"fileId":"b.txt"}),
        true,
    );
    restored
        .launch_acp_session(shard_request(
            &context,
            Some(&both),
            Some(vec!["b.txt", "a.txt"]),
        ))
        .unwrap();
    wait(&events, &both, "session-ready");
    restored.shutdown().unwrap();
}
