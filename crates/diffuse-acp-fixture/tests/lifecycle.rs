#![cfg(any(unix, windows))]

use std::collections::BTreeMap;
use std::process::Command;
use std::time::{Duration, Instant};

use diffuse_core::acp::{AdapterConfig, SessionState};
use diffuse_core::{
    AppCore, CloseWorkspaceRequest, CoreError, EventSubscription, WorkbenchDatabase,
    WorkbenchEvent, WorkspaceRequestContext,
};
use tempfile::TempDir;

fn adapter(mode: &str) -> AdapterConfig {
    AdapterConfig {
        id: "fake".into(),
        executable: env!("CARGO_BIN_EXE_diffuse-acp-fixture").into(),
        args: vec![mode.into()],
        environment: BTreeMap::from([("DIFFUSE_FIXTURE_ALLOWED".into(), "explicit-only".into())]),
    }
}

async fn workspace(core: &AppCore) -> (TempDir, WorkspaceRequestContext) {
    let dir = TempDir::new().unwrap();
    assert!(
        Command::new("git")
            .arg("init")
            .arg("--initial-branch=main")
            .arg(dir.path())
            .output()
            .unwrap()
            .status
            .success()
    );
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

fn activity(events: &EventSubscription, id: &str, kind: &str) -> WorkbenchEvent {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|e| panic!("waiting for {id}/{kind}: {e}"));
        if event.kind == "acp/activity"
            && event.payload["session"]["id"] == id
            && event.payload["activity"]["kind"] == kind
        {
            return event;
        }
    }
}

fn running(core: &AppCore, context: &WorkspaceRequestContext) -> u64 {
    core.workbench_snapshot()
        .unwrap()
        .workspaces
        .iter()
        .find(|w| w.workspace_id == context.workspace_id)
        .unwrap()
        .attention
        .running
}

#[tokio::test]
async fn owned_descendants_die_on_stop_timeout_close_and_shutdown() {
    for termination in ["stop", "timeout", "close", "shutdown"] {
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let (_dir, context) = workspace(&core).await;
        let (_, events) = core.acp_events().subscribe(256);
        let id = core
            .start_acp_session(&context, adapter("ignore-cancel"))
            .unwrap();
        activity(&events, &id, "session-ready");
        core.prompt_acp_session(&context, &id, "tree".into())
            .unwrap();
        let event = activity(&events, &id, "session-update");
        let address = event.payload["activity"]["payload"]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(
            std::net::TcpListener::bind(address).is_err(),
            "descendant must be alive"
        );
        match termination {
            "stop" => core.stop_acp_session(&context, &id).unwrap(),
            "timeout" => core.cancel_acp_session(&context, &id).unwrap(),
            "close" => core
                .close_workspace(&CloseWorkspaceRequest {
                    workspace_id: context.workspace_id,
                    workspace_generation: context.workspace_generation,
                    force: true,
                })
                .unwrap(),
            _ => core.shutdown().unwrap(),
        }
        activity(&events, &id, "session-ended");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if std::net::TcpListener::bind(address).is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant survived {termination}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        core.shutdown().unwrap();
    }
}

#[tokio::test]
async fn refused_close_preserves_active_acp_then_force_stops_it() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.start_acp_session(&context, adapter("")).unwrap();
    activity(&events, &id, "session-ready");
    core.prompt_acp_session(&context, &id, "wait".into())
        .unwrap();
    activity(&events, &id, "session-update");
    core.create_input_request(diffuse_core::CreateInputRequest {
        id: Some("pending".into()),
        workspace_id: context.workspace_id,
        workspace_generation: context.workspace_generation,
        revision: 1,
        kind: diffuse_core::InputRequestKind::Question,
        prompt: "Continue?".into(),
        choices: vec![],
        cancellation_supported: false,
        attention_id: None,
        target: None,
    })
    .unwrap();
    let request = CloseWorkspaceRequest {
        workspace_id: context.workspace_id,
        workspace_generation: context.workspace_generation,
        force: false,
    };
    assert!(matches!(
        core.close_workspace(&request),
        Err(CoreError::WorkspaceHasPendingInput)
    ));
    assert_eq!(running(&core, &context), 1);
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].state,
        SessionState::Running
    );
    // The very same host still responds, not merely a stale persisted running row.
    core.cancel_acp_session(&context, &id).unwrap();
    activity(&events, &id, "turn-ended");
    core.prompt_acp_session(&context, &id, "wait".into())
        .unwrap();
    activity(&events, &id, "session-update");
    core.close_workspace(&CloseWorkspaceRequest {
        force: true,
        ..request
    })
    .unwrap();
    assert_eq!(
        activity(&events, &id, "session-ended").payload["session"]["state"],
        "closed"
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn concurrent_same_workspace_summaries_follow_committed_session_states() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    let (_, startup) = core.acp_events().subscribe(256);
    let first = core.start_acp_session(&context, adapter("")).unwrap();
    activity(&startup, &first, "session-ready");
    let second = core.start_acp_session(&context, adapter("")).unwrap();
    activity(&startup, &second, "session-ready");
    let (_, events) = core.acp_events().subscribe(256);
    for _ in 0..10 {
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|scope| {
            for id in [&first, &second] {
                scope.spawn(|| {
                    barrier.wait();
                    core.prompt_acp_session(&context, id, "hello".into())
                        .unwrap();
                });
            }
            barrier.wait();
        });
        let mut states = BTreeMap::from([(first.clone(), false), (second.clone(), false)]);
        let mut ended = 0;
        loop {
            let event = events.recv_timeout(Duration::from_secs(5)).unwrap();
            if event.kind == "acp/activity" {
                states.insert(
                    event.payload["session"]["id"].as_str().unwrap().to_owned(),
                    event.payload["session"]["state"] == "running",
                );
                if event.payload["activity"]["kind"] == "turn-ended" {
                    ended += 1;
                }
            } else if event.kind == "workspace/summaryChanged" {
                assert_eq!(
                    event.payload["attention"]["running"].as_u64().unwrap(),
                    states.values().filter(|running| **running).count() as u64
                );
                if ended == 2 {
                    assert_eq!(event.payload["attention"]["running"], 0);
                    assert_eq!(running(&core, &context), 0);
                    break;
                }
            }
        }
    }
    core.shutdown().unwrap();
}

#[tokio::test]
async fn initialize_stream_persist_deny_permissions_and_repeat_turns() {
    let storage = TempDir::new().unwrap();
    let database = WorkbenchDatabase::open(storage.path().join("workbench.sqlite3")).unwrap();
    let core = AppCore::new(database);
    let (dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.start_acp_session(&context, adapter("")).unwrap();
    activity(&events, &id, "session-ready");
    let sessions = core.acp_sessions(&context).unwrap();
    assert_eq!(
        sessions[0].remote_session_id.as_deref(),
        Some("remote-session")
    );
    assert_eq!(sessions[0].capabilities["loadSession"], true);
    assert_eq!(sessions[0].permission_policy, "deny-all");
    assert_eq!(running(&core, &context), 0);
    for prompt in ["hello", "permission"] {
        core.prompt_acp_session(&context, &id, prompt.into())
            .unwrap();
        let ended = activity(&events, &id, "turn-ended");
        assert_eq!(
            ended.payload["activity"]["payload"]["stopReason"],
            "end_turn"
        );
        let sequence = ended.payload["activity"]["sequence"].as_u64().unwrap();
        // Receipt of a terminal event guarantees that exact activity is committed.
        let persisted = core.acp_activity(&context, &id, sequence - 1).unwrap();
        assert_eq!(persisted[0].sequence, sequence);
        assert_eq!(persisted[0].kind, "turn-ended");
    }
    let persisted = core.acp_activity(&context, &id, 0).unwrap();
    assert!(
        persisted
            .iter()
            .any(|a| a.payload["content"]["text"] == "hello")
    );
    assert!(
        persisted
            .iter()
            .any(|a| a.payload["content"]["text"] == "permission denied")
    );
    assert_eq!(
        persisted.iter().filter(|a| a.kind == "turn-ended").count(),
        2
    );
    core.shutdown().unwrap();
    drop(core);
    let restored =
        AppCore::new(WorkbenchDatabase::open(storage.path().join("workbench.sqlite3")).unwrap());
    let reopened = restored.open_workspace(dir.path()).await.unwrap();
    let new_context = WorkspaceRequestContext {
        workspace_generation: reopened.summary.workspace_generation,
        ..context.clone()
    };
    assert!(matches!(
        restored.acp_sessions(&context),
        Err(CoreError::StaleWorkspaceGeneration)
    ));
    assert_eq!(
        restored.acp_sessions(&new_context).unwrap()[0].state,
        SessionState::Closed
    );
    assert!(restored.acp_activity(&new_context, &id, 0).unwrap().len() > persisted.len());
    restored.shutdown().unwrap();
}

#[tokio::test]
async fn cancellation_and_workspace_isolation_with_colliding_remote_ids() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_a, a) = workspace(&core).await;
    let (_b, b) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let first = core.start_acp_session(&a, adapter("")).unwrap();
    activity(&events, &first, "session-ready");
    let second = core.start_acp_session(&b, adapter("")).unwrap();
    activity(&events, &second, "session-ready");
    core.prompt_acp_session(&a, &first, "wait".into()).unwrap();
    activity(&events, &first, "session-update");
    core.prompt_acp_session(&b, &second, "wait".into()).unwrap();
    activity(&events, &second, "session-update");
    assert_eq!(running(&core, &a), 1);
    assert_eq!(running(&core, &b), 1);
    assert!(
        core.prompt_acp_session(&a, &first, "duplicate".into())
            .is_err()
    );
    assert!(core.cancel_acp_session(&b, &first).is_err());
    assert!(core.stop_acp_session(&b, &first).is_err());
    assert!(core.acp_activity(&b, &first, 0).unwrap().is_empty());
    core.cancel_acp_session(&a, &first).unwrap();
    let ended = activity(&events, &first, "turn-ended");
    assert_eq!(ended.workspace_id, Some(a.workspace_id));
    assert_eq!(
        ended.payload["activity"]["payload"]["stopReason"],
        "cancelled"
    );
    assert_eq!(running(&core, &a), 0);
    assert_eq!(running(&core, &b), 1);
    core.close_workspace(&CloseWorkspaceRequest {
        workspace_id: a.workspace_id,
        workspace_generation: a.workspace_generation,
        force: true,
    })
    .unwrap();
    assert_eq!(running(&core, &b), 1);
    core.cancel_acp_session(&b, &second).unwrap();
    activity(&events, &second, "turn-ended");
    core.shutdown().unwrap();
}

#[tokio::test]
async fn disconnect_malformed_scope_and_size_fail_without_leaking_running_counts() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    for prompt in [
        "disconnect",
        "foreign",
        "oversize",
        "wrong-id",
        "invalid-json",
    ] {
        let id = core.start_acp_session(&context, adapter("")).unwrap();
        activity(&events, &id, "session-ready");
        core.prompt_acp_session(&context, &id, prompt.into())
            .unwrap();
        let failed = activity(&events, &id, "session-ended");
        assert_eq!(failed.payload["session"]["state"], "failed");
        assert_eq!(running(&core, &context), 0);
        assert!(
            !core
                .acp_activity(&context, &id, 0)
                .unwrap()
                .iter()
                .any(|a| a.payload["content"]["text"] == "must not persist")
        );
    }
    for mode in ["version", "idle-disconnect"] {
        let id = core.start_acp_session(&context, adapter(mode)).unwrap();
        let failed = activity(&events, &id, "session-ended");
        assert_eq!(failed.payload["session"]["state"], "failed");
        assert_eq!(running(&core, &context), 0);
    }
    core.shutdown().unwrap();
}

#[tokio::test]
async fn ignored_cancellation_has_a_deadline_and_stops_host() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let id = core
        .start_acp_session(&context, adapter("ignore-cancel"))
        .unwrap();
    activity(&events, &id, "session-ready");
    core.prompt_acp_session(&context, &id, "wait".into())
        .unwrap();
    activity(&events, &id, "session-update");
    core.cancel_acp_session(&context, &id).unwrap();
    let failed = activity(&events, &id, "session-ended");
    assert!(
        failed.payload["activity"]["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("cancel deadline")
    );
    assert_eq!(running(&core, &context), 0);
    core.shutdown().unwrap();
}

#[tokio::test]
async fn shutdown_and_close_interrupt_initialization_and_fence_reopen() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let id = core
        .start_acp_session(&context, adapter("init-hang"))
        .unwrap();
    activity(&events, &id, "session-starting");
    let started = Instant::now();
    core.close_workspace(&CloseWorkspaceRequest {
        workspace_id: context.workspace_id,
        workspace_generation: context.workspace_generation,
        force: true,
    })
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    let reopened = core.open_workspace(dir.path()).await.unwrap();
    assert_ne!(
        reopened.summary.workspace_generation,
        context.workspace_generation
    );
    assert!(matches!(
        core.start_acp_session(&context, adapter("")),
        Err(CoreError::StaleWorkspaceGeneration)
    ));
    let context = WorkspaceRequestContext {
        workspace_generation: reopened.summary.workspace_generation,
        ..context
    };
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].state,
        SessionState::Closed
    );
    let id = core
        .start_acp_session(&context, adapter("init-hang"))
        .unwrap();
    activity(&events, &id, "session-starting");
    core.shutdown().unwrap();
    assert!(core.start_acp_session(&context, adapter("")).is_err());
}

#[tokio::test]
async fn explicit_stop_and_bounded_prompt_admission() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (_dir, context) = workspace(&core).await;
    let (_, events) = core.acp_events().subscribe(256);
    let id = core
        .start_acp_session(&context, adapter("minimal"))
        .unwrap();
    activity(&events, &id, "session-ready");
    assert_eq!(
        core.acp_sessions(&context).unwrap()[0].capabilities,
        serde_json::json!({})
    );
    assert!(
        core.prompt_acp_session(&context, &id, "x".repeat(256 * 1024))
            .is_err()
    );
    core.stop_acp_session(&context, &id).unwrap();
    let stopped = activity(&events, &id, "session-ended");
    assert_eq!(stopped.payload["session"]["state"], "closed");
    assert!(
        core.prompt_acp_session(&context, &id, "hello".into())
            .is_err()
    );
    core.shutdown().unwrap();
}

#[tokio::test]
async fn slow_subscriber_cannot_block_cancellation_or_close() {
    let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
    let (dir, context) = workspace(&core).await;
    let (_, slow) = core.acp_events().subscribe(1);
    let (_, events) = core.acp_events().subscribe(256);
    let id = core.start_acp_session(&context, adapter("")).unwrap();
    activity(&events, &id, "session-ready");
    core.prompt_acp_session(&context, &id, "wait".into())
        .unwrap();
    // Cancellation can race with queued prompt delivery without being lost.
    core.cancel_acp_session(&context, &id).unwrap();
    let cancelled = activity(&events, &id, "turn-ended");
    assert_eq!(
        cancelled.payload["activity"]["payload"]["stopReason"],
        "cancelled"
    );
    core.prompt_acp_session(&context, &id, "wait".into())
        .unwrap();
    activity(&events, &id, "session-update");
    core.close_workspace(&CloseWorkspaceRequest {
        workspace_id: context.workspace_id,
        workspace_generation: context.workspace_generation,
        force: true,
    })
    .unwrap();
    let stopped = activity(&events, &id, "session-ended");
    assert_eq!(stopped.payload["session"]["state"], "closed");
    // Overflow is explicit, not a silent loss: the old subscription disconnects.
    slow.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(matches!(
        slow.recv_timeout(Duration::from_secs(1)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
    let reopened = core.open_workspace(dir.path()).await.unwrap();
    let context = WorkspaceRequestContext {
        workspace_generation: reopened.summary.workspace_generation,
        ..context
    };
    assert_eq!(running(&core, &context), 0);
    let persisted = core.acp_activity(&context, &id, 0).unwrap();
    assert!(
        persisted
            .iter()
            .any(|a| a.sequence == stopped.payload["activity"]["sequence"].as_u64().unwrap())
    );
    core.shutdown().unwrap();
}
