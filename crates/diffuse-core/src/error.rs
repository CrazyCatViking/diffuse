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
    #[error("DatabaseError: {0}")]
    Database(#[from] rusqlite::Error),
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
            Self::Database(_) => "DatabaseError",
            Self::UnsupportedDatabaseVersion(_) => "UnsupportedDatabaseVersion",
            Self::Io(_) => "IoError",
            Self::TaskFailed(_) => "TaskFailed",
        }
    }
}
