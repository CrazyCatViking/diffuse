use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use crate::database::WorkbenchDatabase;
use crate::repository::Repository;
use crate::workspace::{WorkspaceRegistry, WorkspaceRuntime};
use crate::{
    BranchInfo, CoreError, CoreResult, DiffTargetDefaults, EventHub, WorkspaceGeneration,
    WorkspaceId, WorkspaceRequestContext, WorkspaceSnapshot, WorkspaceState, WorkspaceSummary,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
    pub workspaces: Vec<WorkspaceSummary>,
    pub active_workspace_id: Option<WorkspaceId>,
    pub sequence: u64,
}

struct AppCoreInner {
    registry: WorkspaceRegistry,
    database: WorkbenchDatabase,
    events: EventHub,
    active_workspace_id: RwLock<Option<WorkspaceId>>,
    state_gate: StdMutex<()>,
    open_commit: AsyncMutex<()>,
}

#[derive(Clone)]
pub struct AppCore {
    inner: Arc<AppCoreInner>,
}

impl AppCore {
    pub fn new(database: WorkbenchDatabase) -> Self {
        Self {
            inner: Arc::new(AppCoreInner {
                registry: WorkspaceRegistry::default(),
                database,
                events: EventHub::default(),
                active_workspace_id: RwLock::new(None),
                state_gate: StdMutex::new(()),
                open_commit: AsyncMutex::new(()),
            }),
        }
    }

    pub fn events(&self) -> &EventHub {
        &self.inner.events
    }

    pub fn workbench_snapshot(&self) -> WorkbenchSnapshot {
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        let mut workspaces = self.inner.registry.summaries();
        workspaces.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        WorkbenchSnapshot {
            workspaces,
            active_workspace_id: *self
                .inner
                .active_workspace_id
                .read()
                .expect("active workspace lock poisoned"),
            sequence: self.inner.events.current_sequence(),
        }
    }

    pub async fn open_workspace(&self, path: impl AsRef<Path>) -> CoreResult<WorkspaceSnapshot> {
        let path = path.as_ref().to_owned();
        let repository = tokio::task::spawn_blocking(move || Repository::open(&path))
            .await
            .map_err(|error| CoreError::TaskFailed(error.to_string()))??;
        let canonical_root = repository.canonical_key();
        let _commit = self.inner.open_commit.lock().await;

        let state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        let existing = self.inner.registry.by_root(&canonical_root);
        if let Some(runtime) = existing {
            drop(state);
            self.activate_workspace(runtime.id, runtime.generation)?;
            return Ok(runtime.snapshot());
        }

        let result = repository.result();
        let display_name = repository
            .root()
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&result.root)
            .to_owned();
        let generation = WorkspaceGeneration::new();
        let id = self.inner.database.open_workspace(
            &canonical_root,
            &result.root,
            &display_name,
            generation,
        )?;
        let runtime = Arc::new(WorkspaceRuntime::new(
            id,
            generation,
            canonical_root,
            display_name,
            repository,
        ));
        self.inner.registry.insert(runtime.clone());
        let snapshot = runtime.snapshot();
        self.inner.events.publish(
            "workspace/added",
            Some((id, generation)),
            serde_json::to_value(&snapshot.summary).expect("workspace summary is serializable"),
        );
        drop(state);
        self.activate_workspace(id, generation)?;
        Ok(snapshot)
    }

    pub fn activate_workspace(
        &self,
        workspace_id: WorkspaceId,
        generation: WorkspaceGeneration,
    ) -> CoreResult<()> {
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        self.inner.registry.get(workspace_id, generation)?;
        self.inner.database.activate_workspace(workspace_id)?;
        *self
            .inner
            .active_workspace_id
            .write()
            .expect("active workspace lock poisoned") = Some(workspace_id);
        self.inner.events.publish(
            "workspace/activated",
            Some((workspace_id, generation)),
            json!({ "workspaceId": workspace_id }),
        );
        Ok(())
    }

    pub fn get_workspace_snapshot(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<WorkspaceSnapshot> {
        Ok(self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?
            .snapshot())
    }

    pub async fn get_diff_target_defaults(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<DiffTargetDefaults> {
        let repository = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?
            .repository
            .clone();
        let result = tokio::task::spawn_blocking(move || repository.diff_target_defaults())
            .await
            .map_err(|error| CoreError::TaskFailed(error.to_string()))??;
        self.inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        Ok(result)
    }

    pub async fn list_branches(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<Vec<BranchInfo>> {
        let repository = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?
            .repository
            .clone();
        let result = tokio::task::spawn_blocking(move || repository.list_branches())
            .await
            .map_err(|error| CoreError::TaskFailed(error.to_string()))??;
        self.inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        Ok(result)
    }

    pub fn close_workspace(&self, context: &WorkspaceRequestContext) -> CoreResult<()> {
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        runtime.set_state(WorkspaceState::Closing);
        self.inner.database.close_workspace(context.workspace_id)?;
        let runtime = self
            .inner
            .registry
            .remove(context.workspace_id, context.workspace_generation)?;
        let mut active = self
            .inner
            .active_workspace_id
            .write()
            .expect("active workspace lock poisoned");
        if *active == Some(context.workspace_id) {
            *active = None;
        }
        drop(active);
        self.inner.events.publish(
            "workspace/removed",
            Some((context.workspace_id, context.workspace_generation)),
            serde_json::to_value(runtime.summary()).expect("workspace summary is serializable"),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;

    fn repository() -> TempDir {
        let temp = TempDir::new().expect("temporary repository");
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(temp.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "Diffuse Test")
                .env("GIT_AUTHOR_EMAIL", "diffuse@example.test")
                .env("GIT_COMMITTER_NAME", "Diffuse Test")
                .env("GIT_COMMITTER_EMAIL", "diffuse@example.test")
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "--initial-branch=main"]);
        fs::write(temp.path().join("README.md"), "fixture\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "initial"]);
        temp
    }

    fn context(snapshot: &WorkspaceSnapshot, request_id: &str) -> WorkspaceRequestContext {
        WorkspaceRequestContext {
            workspace_id: snapshot.summary.workspace_id,
            workspace_generation: snapshot.summary.workspace_generation,
            request_id: request_id.to_owned(),
        }
    }

    #[tokio::test]
    async fn one_core_manages_independent_workspaces_and_rejects_stale_generations() {
        let first_repo = repository();
        let second_repo = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let first = core.open_workspace(first_repo.path()).await.unwrap();
        let second = core.open_workspace(second_repo.path()).await.unwrap();
        assert_ne!(first.summary.workspace_id, second.summary.workspace_id);
        assert_eq!(core.workbench_snapshot().workspaces.len(), 2);

        let stale = context(&first, "close-first");
        core.close_workspace(&stale).unwrap();
        let reopened = core.open_workspace(first_repo.path()).await.unwrap();
        assert_eq!(first.summary.workspace_id, reopened.summary.workspace_id);
        assert_ne!(
            first.summary.workspace_generation,
            reopened.summary.workspace_generation
        );
        assert!(matches!(
            core.get_workspace_snapshot(&stale),
            Err(CoreError::StaleWorkspaceGeneration)
        ));
    }

    #[tokio::test]
    async fn concurrent_duplicate_opens_share_one_runtime() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let (first, second) = tokio::join!(
            core.open_workspace(repository.path()),
            core.open_workspace(repository.path())
        );
        assert_eq!(
            first.unwrap().summary.workspace_id,
            second.unwrap().summary.workspace_id
        );
        assert_eq!(core.workbench_snapshot().workspaces.len(), 1);
    }
}
