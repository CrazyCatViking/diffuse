use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::lsp::LspManager;
use crate::repository::Repository;
use crate::review::ReviewStore;
use crate::search::SearchCoordinator;
use crate::watcher::{RepositoryWatchEvent, RepositoryWatcher, RepositoryWatcherConfig};
use crate::{CoreError, CoreResult, EventHub, OpenRepositoryResult};

macro_rules! uuid_id {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub fn parse(value: &str) -> Result<Self, uuid::Error> {
                Uuid::parse_str(value).map(Self)
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

uuid_id!(WorkspaceId);
uuid_id!(WorkspaceGeneration);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRequestContext {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceState {
    Opening,
    Ready,
    Degraded,
    Closing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub root: String,
    pub display_name: String,
    pub state: WorkspaceState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub summary: WorkspaceSummary,
    pub repository: OpenRepositoryResult,
}

pub(crate) struct WorkspaceRuntime {
    pub(crate) id: WorkspaceId,
    pub(crate) generation: WorkspaceGeneration,
    pub(crate) canonical_root: String,
    pub(crate) display_name: String,
    pub(crate) repository: Repository,
    pub(crate) reviews: ReviewStore,
    pub(crate) lsp: Arc<LspManager>,
    pub(crate) search: Arc<SearchCoordinator>,
    lifecycle: Arc<WorkspaceLifecycle>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
}

struct WorkspaceLifecycle {
    state: Mutex<LifecycleState>,
    idle: Condvar,
}

struct LifecycleState {
    workspace_state: WorkspaceState,
    accepting_operations: bool,
    active_operations: usize,
}

pub(crate) struct WorkspaceOperationPermit {
    lifecycle: Arc<WorkspaceLifecycle>,
}

impl Drop for WorkspaceOperationPermit {
    fn drop(&mut self) {
        let mut state = self
            .lifecycle
            .state
            .lock()
            .expect("workspace lifecycle lock poisoned");
        state.active_operations = state
            .active_operations
            .checked_sub(1)
            .expect("workspace operation permit count underflow");
        if state.active_operations == 0 {
            self.lifecycle.idle.notify_all();
        }
    }
}

impl WorkspaceLifecycle {
    fn new() -> Self {
        Self {
            state: Mutex::new(LifecycleState {
                workspace_state: WorkspaceState::Ready,
                accepting_operations: true,
                active_operations: 0,
            }),
            idle: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> CoreResult<WorkspaceOperationPermit> {
        let mut state = self
            .state
            .lock()
            .expect("workspace lifecycle lock poisoned");
        if !state.accepting_operations {
            return Err(CoreError::WorkspaceClosing);
        }
        state.active_operations = state.active_operations.saturating_add(1);
        Ok(WorkspaceOperationPermit {
            lifecycle: self.clone(),
        })
    }

    fn begin_close(&self) -> CoreResult<()> {
        let mut state = self
            .state
            .lock()
            .expect("workspace lifecycle lock poisoned");
        if !state.accepting_operations {
            return Err(CoreError::WorkspaceClosing);
        }
        state.accepting_operations = false;
        state.workspace_state = WorkspaceState::Closing;
        Ok(())
    }

    fn restore_ready(&self) {
        let mut state = self
            .state
            .lock()
            .expect("workspace lifecycle lock poisoned");
        state.workspace_state = WorkspaceState::Ready;
        state.accepting_operations = true;
    }

    fn wait_until_idle(&self) {
        let mut state = self
            .state
            .lock()
            .expect("workspace lifecycle lock poisoned");
        while state.active_operations != 0 {
            state = self
                .idle
                .wait(state)
                .expect("workspace lifecycle lock poisoned while waiting");
        }
    }

    fn workspace_state(&self) -> WorkspaceState {
        self.state
            .lock()
            .expect("workspace lifecycle lock poisoned")
            .workspace_state
    }
}

struct WorkspaceWatcher {
    watcher: RepositoryWatcher,
    forwarder: Option<JoinHandle<()>>,
}

impl WorkspaceWatcher {
    fn stop(mut self) {
        self.watcher.stop();
        if let Some(forwarder) = self.forwarder.take() {
            let _ = forwarder.join();
        }
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.watcher.stop();
        if let Some(forwarder) = self.forwarder.take() {
            let _ = forwarder.join();
        }
    }
}

impl WorkspaceRuntime {
    pub(crate) fn new(
        id: WorkspaceId,
        generation: WorkspaceGeneration,
        canonical_root: String,
        display_name: String,
        repository: Repository,
    ) -> Self {
        Self {
            id,
            generation,
            canonical_root,
            display_name,
            reviews: ReviewStore::new(repository.root()),
            lsp: Arc::new(LspManager::default()),
            search: Arc::new(SearchCoordinator::default()),
            repository,
            lifecycle: Arc::new(WorkspaceLifecycle::new()),
            watcher: Mutex::new(None),
        }
    }

    pub(crate) fn start_watcher(&self, events: Arc<EventHub>) -> CoreResult<()> {
        if self
            .watcher
            .lock()
            .expect("workspace watcher lock poisoned")
            .is_some()
        {
            return Ok(());
        }

        let (watcher, receiver) =
            RepositoryWatcher::start(self.repository.root(), RepositoryWatcherConfig::default())?;
        let workspace = (self.id, self.generation);
        let lifecycle = self.lifecycle.clone();
        let forwarder = std::thread::Builder::new()
            .name("diffuse-watcher-events".to_owned())
            .spawn(move || {
                while let Some(event) = receiver.recv() {
                    let Ok(_permit) = lifecycle.acquire() else {
                        continue;
                    };
                    match event {
                        RepositoryWatchEvent::RepositoryChanged { root, paths } => {
                            events.publish(
                                "repository/changed",
                                Some(workspace),
                                json!({ "root": root.to_string_lossy(), "paths": paths }),
                            );
                        }
                        RepositoryWatchEvent::ReviewChanged { root, paths } => {
                            events.publish(
                                "review/changed",
                                Some(workspace),
                                json!({ "root": root.to_string_lossy(), "paths": paths }),
                            );
                        }
                        RepositoryWatchEvent::RescanRequired { root } => {
                            let root = root.to_string_lossy();
                            events.publish(
                                "repository/changed",
                                Some(workspace),
                                json!({ "root": root, "paths": [] }),
                            );
                            events.publish(
                                "review/changed",
                                Some(workspace),
                                json!({ "root": root }),
                            );
                        }
                        RepositoryWatchEvent::Stopped { .. } => break,
                    }
                }
            })?;
        let candidate = WorkspaceWatcher {
            watcher,
            forwarder: Some(forwarder),
        };
        let mut current = self
            .watcher
            .lock()
            .expect("workspace watcher lock poisoned");
        if current.is_none() {
            *current = Some(candidate);
        }
        Ok(())
    }

    pub(crate) fn stop_watcher(&self) {
        let watcher = self
            .watcher
            .lock()
            .expect("workspace watcher lock poisoned")
            .take();
        if let Some(watcher) = watcher {
            watcher.stop();
        }
    }

    pub(crate) fn watcher_running(&self) -> bool {
        self.watcher
            .lock()
            .expect("workspace watcher lock poisoned")
            .is_some()
    }

    pub(crate) fn acquire_operation(&self) -> CoreResult<WorkspaceOperationPermit> {
        self.lifecycle.acquire()
    }

    pub(crate) fn begin_close(&self) -> CoreResult<()> {
        self.lifecycle.begin_close()
    }

    pub(crate) fn restore_ready(&self) {
        self.lifecycle.restore_ready();
    }

    pub(crate) fn wait_until_idle(&self) {
        self.lifecycle.wait_until_idle();
    }

    pub(crate) fn summary(&self) -> WorkspaceSummary {
        WorkspaceSummary {
            workspace_id: self.id,
            workspace_generation: self.generation,
            root: self.repository.result().root,
            display_name: self.display_name.clone(),
            state: self.lifecycle.workspace_state(),
        }
    }

    pub(crate) fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            summary: self.summary(),
            repository: self.repository.result(),
        }
    }
}

#[derive(Default)]
struct RegistryState {
    by_id: HashMap<WorkspaceId, Arc<WorkspaceRuntime>>,
    by_root: HashMap<String, WorkspaceId>,
}

#[derive(Default)]
pub(crate) struct WorkspaceRegistry {
    state: RwLock<RegistryState>,
}

impl WorkspaceRegistry {
    pub(crate) fn by_root(&self, canonical_root: &str) -> Option<Arc<WorkspaceRuntime>> {
        let state = self.state.read().expect("workspace registry lock poisoned");
        state
            .by_root
            .get(canonical_root)
            .and_then(|id| state.by_id.get(id))
            .cloned()
    }

    pub(crate) fn insert(&self, runtime: Arc<WorkspaceRuntime>) {
        let mut state = self
            .state
            .write()
            .expect("workspace registry lock poisoned");
        state
            .by_root
            .insert(runtime.canonical_root.clone(), runtime.id);
        state.by_id.insert(runtime.id, runtime);
    }

    pub(crate) fn get(
        &self,
        id: WorkspaceId,
        generation: WorkspaceGeneration,
    ) -> CoreResult<Arc<WorkspaceRuntime>> {
        let state = self.state.read().expect("workspace registry lock poisoned");
        let runtime = state.by_id.get(&id).ok_or(CoreError::WorkspaceNotFound)?;
        if runtime.generation != generation {
            return Err(CoreError::StaleWorkspaceGeneration);
        }
        if runtime.summary().state == WorkspaceState::Closing {
            return Err(CoreError::WorkspaceClosing);
        }
        Ok(runtime.clone())
    }

    pub(crate) fn remove(
        &self,
        id: WorkspaceId,
        generation: WorkspaceGeneration,
    ) -> CoreResult<Arc<WorkspaceRuntime>> {
        let mut state = self
            .state
            .write()
            .expect("workspace registry lock poisoned");
        let runtime = state.by_id.get(&id).ok_or(CoreError::WorkspaceNotFound)?;
        if runtime.generation != generation {
            return Err(CoreError::StaleWorkspaceGeneration);
        }
        let canonical_root = runtime.canonical_root.clone();
        let runtime = state
            .by_id
            .remove(&id)
            .expect("workspace disappeared while locked");
        state.by_root.remove(&canonical_root);
        Ok(runtime)
    }

    pub(crate) fn summaries(&self) -> Vec<WorkspaceSummary> {
        self.state
            .read()
            .expect("workspace registry lock poisoned")
            .by_id
            .values()
            .map(|runtime| runtime.summary())
            .collect()
    }

    pub(crate) fn runtimes(&self) -> Vec<Arc<WorkspaceRuntime>> {
        self.state
            .read()
            .expect("workspace registry lock poisoned")
            .by_id
            .values()
            .cloned()
            .collect()
    }
}
