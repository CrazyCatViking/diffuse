mod app_core;
mod database;
pub mod diff;
mod error;
mod event;
pub mod lsp;
mod repository;
pub mod review;
pub mod search;
pub mod syntax;
pub mod watcher;
mod workspace;

pub use app_core::{AppCore, WorkbenchSnapshot};
pub use database::{DEFAULT_DATABASE_FILE_NAME, WorkbenchDatabase, default_database_path};
pub use diff::{
    DiffContextMode, DiffIntelligence, DiffRenderModel, DiffRenderOptions, DiffRow, DiffRowKind,
    DiffViewMode, SyntaxSpan, SyntaxStatus,
};
pub use error::{CoreError, CoreResult};
pub use event::{EventHub, EventReplay, WorkbenchEvent};
pub use repository::{
    BranchInfo, ChangedFile, DiffTarget, DiffTargetDefaults, FileStatus, OpenRepositoryResult,
    VersionInfo,
};
pub use workspace::{
    WorkspaceGeneration, WorkspaceId, WorkspaceRequestContext, WorkspaceServiceHealth,
    WorkspaceServiceStatus, WorkspaceSnapshot, WorkspaceState, WorkspaceSummary,
};

pub const APP_NAME: &str = "diffuse";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_info() -> VersionInfo {
    VersionInfo {
        name: APP_NAME.to_owned(),
        version: VERSION.to_owned(),
    }
}
