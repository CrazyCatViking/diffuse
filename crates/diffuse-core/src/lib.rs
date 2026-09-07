mod app_core;
pub mod attention;
mod database;
pub mod diff;
mod error;
mod event;
mod legacy_import;
pub mod lsp;
mod repository;
pub mod review;
pub mod search;
pub mod syntax;
pub mod watcher;
mod workspace;

pub use app_core::{
    AppCore, AppCoreLifecycleState, AppCoreOptions, DismissRestoreFailureResult, RestoreDiagnostic,
    WorkbenchSnapshot,
};
pub use attention::{
    AnswerInputRequest, AttentionCasRequest, AttentionItem, AttentionKind, AttentionMutationResult,
    AttentionStatus, CreateAttentionRequest, CreateInputRequest, InputCasRequest,
    InputMutationResult, InputRequest, InputRequestKind, InputRequestStatus, InputResponse,
    MutationOutcome, SaveWorkspaceUiStateRequest, WorkspaceAttentionState,
    WorkspaceAttentionSummary, WorkspaceNavigationTarget, WorkspaceUiStateMutationResult,
    WorkspaceUiStateRecord,
};
pub use database::{
    DEFAULT_DATABASE_FILE_NAME, LegacyImportedArtifact, LegacyReviewImportReport,
    WorkbenchDatabase, default_database_path,
};
pub use diff::{
    DiffContextMode, DiffIntelligence, DiffRenderModel, DiffRenderOptions, DiffRow, DiffRowKind,
    DiffViewMode, SyntaxSpan, SyntaxStatus,
};
pub use error::{CoreError, CoreResult};
pub use event::{EventHub, EventReplay, EventSubscription, WorkbenchEvent};
pub use repository::{
    BranchInfo, ChangedFile, DiffTarget, DiffTargetDefaults, FileStatus, OpenRepositoryResult,
    VersionInfo,
};
pub use workspace::{
    CloseWorkspaceRequest, WorkspaceGeneration, WorkspaceId, WorkspaceRequestContext,
    WorkspaceServiceHealth, WorkspaceServiceStatus, WorkspaceSnapshot, WorkspaceState,
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
