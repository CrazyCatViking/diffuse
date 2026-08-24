use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("GitCommandFailed")]
    GitCommandFailed,
    #[error("RepositoryNotOpen")]
    RepositoryNotOpen,
    #[error("WorkspaceNotFound")]
    WorkspaceNotFound,
    #[error("StaleWorkspaceGeneration")]
    StaleWorkspaceGeneration,
    #[error("WorkspaceClosing")]
    WorkspaceClosing,
    #[error("AppCoreShuttingDown")]
    AppCoreShuttingDown,
    #[error("WorkspaceFileNotFound")]
    WorkspaceFileNotFound,
    #[error("InvalidParams: {0}")]
    InvalidParams(String),
    #[error("MethodNotFound")]
    MethodNotFound,
    #[error("SerializationError: {0}")]
    Serialization(String),
    #[error("ReviewError: {0}")]
    Review(String),
    #[error("SearchError: {0}")]
    Search(String),
    #[error("LspError: {0}")]
    Lsp(String),
    #[error("SyntaxError: {0}")]
    Syntax(String),
    #[error("DatabaseError: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("DatabaseCorrupt: {0}")]
    DatabaseCorrupt(String),
    #[error("UnsupportedDatabaseVersion: {0}")]
    UnsupportedDatabaseVersion(i64),
    #[error("IoError: {0}")]
    Io(#[from] std::io::Error),
    #[error("TaskFailed: {0}")]
    TaskFailed(String),
}

impl CoreError {
    pub fn protocol_name(&self) -> &'static str {
        match self {
            Self::GitCommandFailed => "GitCommandFailed",
            Self::RepositoryNotOpen => "RepositoryNotOpen",
            Self::WorkspaceNotFound => "WorkspaceNotFound",
            Self::StaleWorkspaceGeneration => "StaleWorkspaceGeneration",
            Self::WorkspaceClosing => "WorkspaceClosing",
            Self::AppCoreShuttingDown => "AppCoreShuttingDown",
            Self::WorkspaceFileNotFound => "WorkspaceFileNotFound",
            Self::InvalidParams(_) => "InvalidParams",
            Self::MethodNotFound => "MethodNotFound",
            Self::Serialization(_) => "SerializationError",
            Self::Review(_) => "ReviewError",
            Self::Search(_) => "SearchError",
            Self::Lsp(_) => "LspError",
            Self::Syntax(_) => "SyntaxError",
            Self::Database(_) => "DatabaseError",
            Self::DatabaseCorrupt(_) => "DatabaseError",
            Self::UnsupportedDatabaseVersion(_) => "UnsupportedDatabaseVersion",
            Self::Io(_) => "IoError",
            Self::TaskFailed(_) => "TaskFailed",
        }
    }
}

impl From<crate::review::ReviewError> for CoreError {
    fn from(error: crate::review::ReviewError) -> Self {
        match error {
            crate::review::ReviewError::InvalidPathSegment(_)
            | crate::review::ReviewError::InvalidComment(_) => {
                Self::InvalidParams(error.to_string())
            }
            error => Self::Review(error.to_string()),
        }
    }
}
