use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::repository::Repository;
use crate::{CoreError, CoreResult, OpenRepositoryResult};

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
    state: RwLock<WorkspaceState>,
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
            repository,
            state: RwLock::new(WorkspaceState::Ready),
        }
    }

    pub(crate) fn summary(&self) -> WorkspaceSummary {
        WorkspaceSummary {
            workspace_id: self.id,
            workspace_generation: self.generation,
            root: self.repository.result().root,
            display_name: self.display_name.clone(),
            state: *self.state.read().expect("workspace state lock poisoned"),
        }
    }

    pub(crate) fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            summary: self.summary(),
            repository: self.repository.result(),
        }
    }

    pub(crate) fn set_state(&self, state: WorkspaceState) {
        *self.state.write().expect("workspace state lock poisoned") = state;
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
}
