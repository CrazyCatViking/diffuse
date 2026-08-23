mod app_core;
mod database;
mod error;
mod event;
mod repository;
mod workspace;

pub use app_core::{AppCore, WorkbenchSnapshot};
pub use database::{DEFAULT_DATABASE_FILE_NAME, WorkbenchDatabase, default_database_path};
pub use error::{CoreError, CoreResult};
pub use event::{EventHub, EventReplay, WorkbenchEvent};
pub use repository::{BranchInfo, DiffTargetDefaults, OpenRepositoryResult, VersionInfo};
pub use workspace::{
    WorkspaceGeneration, WorkspaceId, WorkspaceRequestContext, WorkspaceSnapshot, WorkspaceState,
    WorkspaceSummary,
};

pub const APP_NAME: &str = "diffuse";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_info() -> VersionInfo {
    VersionInfo {
        name: APP_NAME.to_owned(),
        version: VERSION.to_owned(),
    }
}
