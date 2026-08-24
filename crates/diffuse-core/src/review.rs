use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const REVIEW_CHANGED_EVENT: &str = "review/changed";
pub const REVIEWS_RELATIVE_PATH: &str = ".diffuse/reviews";

const CONFIG_FILE: &str = "config.json";
const ACTIVE_SESSION_FILE: &str = "active-session";
const SESSIONS_DIRECTORY: &str = "sessions";
const SESSION_FILE: &str = "review.json";
const PROGRESS_FILE: &str = "progress.json";
const REVIEWED_FILES_FILE: &str = "reviewed-files.json";
const MAX_PATH_SEGMENT_BYTES: usize = 200;
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_SESSION_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROGRESS_BYTES: usize = 1024 * 1024;
const MAX_REVIEWED_FILES_BYTES: usize = 16 * 1024 * 1024;
const MAX_COLLECTION_ITEM_BYTES: usize = 1024 * 1024;
const MAX_THREAD_BYTES: usize = 2 * 1024 * 1024;
const INTERRUPTED_MESSAGE: &str =
    "Review run was interrupted before Diffuse could attach a provider";

pub type ReviewResult<T> = Result<T, ReviewError>;

#[derive(Debug, Error)]
pub enum ReviewError {
    #[error("InvalidPathSegment: {0}")]
    InvalidPathSegment(String),
    #[error("InvalidReviewComment: {0}")]
    InvalidComment(&'static str),
    #[error("ReviewFileTooLarge: {path} exceeds {limit} bytes")]
    FileTooLarge { path: PathBuf, limit: usize },
    #[error("SystemClockBeforeUnixEpoch")]
    ClockBeforeUnixEpoch,
    #[error("IoError: {0}")]
    Io(#[from] io::Error),
    #[error("InvalidReviewJson: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<String>,
    pub include_staged: bool,
    pub include_unstaged: bool,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewParticipantAgent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewParticipantKind {
    Human,
    Ai,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewParticipant {
    pub id: String,
    pub kind: ReviewParticipantKind,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<ReviewParticipantAgent>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSessionStatus {
    Active,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub id: String,
    pub repository_root: String,
    pub target: ReviewDiffTarget,
    pub head_at_creation: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: ReviewSessionStatus,
    pub participants: Vec<ReviewParticipant>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewProgressStatus {
    Idle,
    Planning,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProgress {
    pub status: ReviewProgressStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_files: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_files: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFile {
    pub file_id: String,
    pub reviewed_at: String,
    pub reviewed_by: String,
    pub signature: String,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFilesState {
    #[serde(default)]
    pub files: BTreeMap<String, ReviewedFile>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFilesUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<BTreeMap<String, ReviewedFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_file_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConfig {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub max_parallel_agents: u32,
    pub prompt_instructions: String,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

impl Default for ReviewConfig {
    fn default() -> Self {
        Self {
            provider: "opencode".to_owned(),
            model: None,
            agent: None,
            max_parallel_agents: 1,
            prompt_instructions: "Prefer high-signal correctness, security, data-loss, race, and test-coverage findings. Do not comment on non-actionable observations.".to_owned(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewAgentStatus {
    Starting,
    Running,
    Idle,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAgentState {
    pub id: String,
    pub provider: String,
    pub status: ReviewAgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_thought_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewRunStatus {
    Starting,
    Planning,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl ReviewRunStatus {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Planning | Self::Running | Self::Cancelling
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRun {
    pub id: String,
    pub session_id: String,
    pub provider: String,
    pub status: ReviewRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_session_id: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSide {
    Old,
    New,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchor {
    pub side: ReviewSide,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunk_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_text: Option<String>,
    pub diff_target_fingerprint: String,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMessage {
    pub id: String,
    pub author_id: String,
    pub body: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewThreadStatus {
    Open,
    Resolved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewCategory {
    Bug,
    Security,
    Performance,
    Maintainability,
    Test,
    Style,
    Question,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewConfidence {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSourceKind {
    Human,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    pub kind: ReviewSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_run_id: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub session_id: String,
    pub file_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub anchor: ReviewAnchor,
    pub status: ReviewThreadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<ReviewSeverity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<ReviewCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<ReviewConfidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ReviewSource>,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ReviewMessage>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewChatRole {
    User,
    Assistant,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChatContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<ReviewAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_ids: Option<Vec<String>>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: ReviewChatRole,
    pub body: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ReviewChatContext>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentPayload {
    pub file_path: String,
    pub side: ReviewSide,
    pub start_line: u32,
    pub end_line: u32,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<ReviewSeverity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<ReviewCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<ReviewConfidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChanged {
    pub root: String,
    pub session_id: String,
    pub change: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewOperation<T> {
    pub result: T,
    pub event: Option<ReviewChanged>,
}

impl<T> ReviewOperation<T> {
    fn changed(result: T, event: ReviewChanged) -> Self {
        Self {
            result,
            event: Some(event),
        }
    }

    fn unchanged(result: T) -> Self {
        Self {
            result,
            event: None,
        }
    }

    pub fn into_parts(self) -> (T, Option<ReviewChanged>) {
        (self.result, self.event)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverStaleRunsResult {
    pub recovered: u32,
}

#[derive(Clone)]
pub struct ReviewStore {
    workspace_root: PathBuf,
    reviews_root: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl ReviewStore {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let workspace_root = workspace_root.into();
        let reviews_root = workspace_root.join(REVIEWS_RELATIVE_PATH);
        Self {
            workspace_root,
            reviews_root,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn reviews_root(&self) -> &Path {
        &self.reviews_root
    }

    pub fn get_config(&self) -> ReviewResult<ReviewConfig> {
        fs::create_dir_all(&self.reviews_root)?;
        self.read_optional(&self.reviews_root.join(CONFIG_FILE), MAX_CONFIG_BYTES)?
            .map_or_else(|| Ok(ReviewConfig::default()), |bytes| from_json(&bytes))
    }

    pub fn save_config(&self, config: ReviewConfig) -> ReviewResult<ReviewOperation<ReviewConfig>> {
        let _guard = self.lock_writes();
        fs::create_dir_all(&self.reviews_root)?;
        self.write_json_atomic(&self.reviews_root.join(CONFIG_FILE), &config)?;
        Ok(ReviewOperation::changed(
            config,
            self.change("", "config.updated"),
        ))
    }

    pub fn get_active_session(&self) -> ReviewResult<Option<ReviewSession>> {
        let Some(bytes) = self.read_optional(&self.reviews_root.join(ACTIVE_SESSION_FILE), 4096)?
        else {
            return Ok(None);
        };
        let raw = String::from_utf8(bytes).map_err(|error| {
            ReviewError::InvalidPathSegment(String::from_utf8_lossy(error.as_bytes()).into_owned())
        })?;
        let session_id = raw.trim_matches(['\r', '\n', '\t', ' ']);
        if session_id.is_empty() {
            return Ok(None);
        }
        validate_path_segment(session_id)?;
        let path = self.session_file_path(session_id)?;
        self.read_optional(&path, MAX_SESSION_BYTES)?
            .map(|bytes| from_json(&bytes))
            .transpose()
    }

    pub fn list_sessions(&self) -> ReviewResult<Vec<ReviewSession>> {
        fs::create_dir_all(&self.reviews_root)?;
        let sessions_root = self.reviews_root.join(SESSIONS_DIRECTORY);
        let entries = match fs::read_dir(sessions_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                paths.push(entry.path().join(SESSION_FILE));
            }
        }
        paths.sort();
        let mut sessions = Vec::with_capacity(paths.len());
        for path in paths {
            let Some(bytes) = self.read_optional(&path, MAX_SESSION_BYTES)? else {
                continue;
            };
            sessions.push(from_json(&bytes)?);
        }
        Ok(sessions)
    }

    pub fn create_session(
        &self,
        session: ReviewSession,
    ) -> ReviewResult<ReviewOperation<ReviewSession>> {
        validate_path_segment(&session.id)?;
        let _guard = self.lock_writes();
        self.ensure_session_directory(&session.id)?;
        self.write_json_atomic(&self.session_file_path(&session.id)?, &session)?;
        self.write_atomic(
            &self.reviews_root.join(ACTIVE_SESSION_FILE),
            session.id.as_bytes(),
        )?;
        let event = self.change(&session.id, "session.created");
        Ok(ReviewOperation::changed(session, event))
    }

    pub fn get_progress(&self, session_id: &str) -> ReviewResult<Option<ReviewProgress>> {
        let path = self.session_child_path(session_id, PROGRESS_FILE)?;
        self.read_optional(&path, MAX_PROGRESS_BYTES)?
            .map(|bytes| from_json(&bytes))
            .transpose()
    }

    pub fn save_progress(
        &self,
        session_id: &str,
        progress: ReviewProgress,
    ) -> ReviewResult<ReviewOperation<ReviewProgress>> {
        let _guard = self.lock_writes();
        self.ensure_session_directory(session_id)?;
        self.write_json_atomic(
            &self.session_child_path(session_id, PROGRESS_FILE)?,
            &progress,
        )?;
        Ok(ReviewOperation::changed(
            progress,
            self.change(session_id, "progress.updated"),
        ))
    }

    pub fn read_reviewed_files(
        &self,
        session_id: &str,
    ) -> ReviewResult<Option<ReviewedFilesState>> {
        let path = self.session_child_path(session_id, REVIEWED_FILES_FILE)?;
        self.read_optional(&path, MAX_REVIEWED_FILES_BYTES)?
            .map(|bytes| from_json(&bytes))
            .transpose()
    }

    pub fn get_reviewed_files(&self, session_id: &str) -> ReviewResult<ReviewedFilesState> {
        Ok(self.read_reviewed_files(session_id)?.unwrap_or_default())
    }

    pub fn save_reviewed_files(
        &self,
        session_id: &str,
        reviewed_files: ReviewedFilesState,
    ) -> ReviewResult<ReviewOperation<ReviewedFilesState>> {
        let _guard = self.lock_writes();
        self.ensure_session_directory(session_id)?;
        self.write_json_atomic(
            &self.session_child_path(session_id, REVIEWED_FILES_FILE)?,
            &reviewed_files,
        )?;
        Ok(ReviewOperation::changed(
            reviewed_files,
            self.change(session_id, "reviewed-files.updated"),
        ))
    }

    pub fn update_reviewed_files(
        &self,
        session_id: &str,
        update: ReviewedFilesUpdate,
    ) -> ReviewResult<ReviewOperation<ReviewedFilesState>> {
        validate_path_segment(session_id)?;
        let _guard = self.lock_writes();
        let path = self.session_child_path(session_id, REVIEWED_FILES_FILE)?;
        let mut state: ReviewedFilesState = self
            .read_optional(&path, MAX_REVIEWED_FILES_BYTES)?
            .map(|bytes| from_json(&bytes))
            .transpose()?
            .unwrap_or_default();
        if let Some(files) = update.files {
            state.files.extend(files);
        }
        if let Some(remove_file_ids) = update.remove_file_ids {
            for file_id in remove_file_ids {
                state.files.remove(&file_id);
            }
        }
        self.ensure_session_directory(session_id)?;
        self.write_json_atomic(&path, &state)?;
        Ok(ReviewOperation::changed(
            state,
            self.change(session_id, "reviewed-files.updated"),
        ))
    }

    pub fn list_agent_states(&self, session_id: &str) -> ReviewResult<Vec<ReviewAgentState>> {
        self.list_session_json_files(session_id, Path::new("agents"), MAX_COLLECTION_ITEM_BYTES)
    }

    pub fn get_agent_states(&self, session_id: &str) -> ReviewResult<Vec<ReviewAgentState>> {
        self.list_agent_states(session_id)
    }

    pub fn save_agent_state(
        &self,
        session_id: &str,
        agent: ReviewAgentState,
    ) -> ReviewResult<ReviewOperation<ReviewAgentState>> {
        validate_path_segment(&agent.id)?;
        let _guard = self.lock_writes();
        let directory = self.ensure_session_subdirectory(session_id, Path::new("agents"))?;
        self.write_json_atomic(&directory.join(format!("{}.json", agent.id)), &agent)?;
        Ok(ReviewOperation::changed(
            agent,
            self.change(session_id, "agent.updated"),
        ))
    }

    pub fn list_runs(&self, session_id: &str) -> ReviewResult<Vec<ReviewRun>> {
        self.list_session_json_files(session_id, Path::new("runs"), MAX_COLLECTION_ITEM_BYTES)
    }

    pub fn get_runs(&self, session_id: &str) -> ReviewResult<Vec<ReviewRun>> {
        self.list_runs(session_id)
    }

    pub fn save_run(
        &self,
        session_id: &str,
        run: ReviewRun,
    ) -> ReviewResult<ReviewOperation<ReviewRun>> {
        validate_path_segment(&run.id)?;
        let _guard = self.lock_writes();
        self.write_run_locked(session_id, &run)?;
        Ok(ReviewOperation::changed(
            run,
            self.change(session_id, "run.updated"),
        ))
    }

    pub fn create_run(
        &self,
        session_id: &str,
        run: ReviewRun,
    ) -> ReviewResult<ReviewOperation<ReviewRun>> {
        self.save_run(session_id, run)
    }

    pub fn update_run(
        &self,
        session_id: &str,
        run: ReviewRun,
    ) -> ReviewResult<ReviewOperation<ReviewRun>> {
        self.save_run(session_id, run)
    }

    pub fn finish_run(
        &self,
        session_id: &str,
        run: ReviewRun,
    ) -> ReviewResult<ReviewOperation<ReviewRun>> {
        self.save_run(session_id, run)
    }

    pub fn recover_stale_runs(
        &self,
        session_id: &str,
    ) -> ReviewResult<ReviewOperation<RecoverStaleRunsResult>> {
        self.recover_stale_runs_at(session_id, unix_time_millis()?)
    }

    pub fn recover_stale_runs_at(
        &self,
        session_id: &str,
        now_millis: u128,
    ) -> ReviewResult<ReviewOperation<RecoverStaleRunsResult>> {
        validate_path_segment(session_id)?;
        let _guard = self.lock_writes();
        let mut runs: Vec<ReviewRun> = self.list_session_json_files_locked(
            session_id,
            Path::new("runs"),
            MAX_COLLECTION_ITEM_BYTES,
        )?;
        let timestamp = now_millis.to_string();
        let mut recovered = 0_u32;
        for run in &mut runs {
            if !run.status.is_active() {
                continue;
            }
            validate_path_segment(&run.id)?;
            run.status = ReviewRunStatus::Failed;
            run.current_phase = Some("interrupted".to_owned());
            run.message = Some(INTERRUPTED_MESSAGE.to_owned());
            run.updated_at = timestamp.clone();
            run.completed_at = Some(timestamp.clone());
            self.write_run_locked(session_id, run)?;
            recovered = recovered.saturating_add(1);
        }
        let result = RecoverStaleRunsResult { recovered };
        if recovered == 0 {
            Ok(ReviewOperation::unchanged(result))
        } else {
            Ok(ReviewOperation::changed(
                result,
                self.change(session_id, "runs.recovered"),
            ))
        }
    }

    pub fn list_threads(&self, session_id: &str) -> ReviewResult<Vec<ReviewThread>> {
        self.list_session_json_files(session_id, Path::new("threads"), MAX_THREAD_BYTES)
    }

    pub fn get_threads(&self, session_id: &str) -> ReviewResult<Vec<ReviewThread>> {
        self.list_threads(session_id)
    }

    pub fn save_thread(
        &self,
        session_id: &str,
        thread: ReviewThread,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        self.write_thread(session_id, thread, "thread.updated")
    }

    pub fn add_comment(
        &self,
        session_id: &str,
        comment: ReviewThread,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        self.write_thread(session_id, comment, "thread.created")
    }

    pub fn add_comment_payload(
        &self,
        session_id: &str,
        run_id: &str,
        comment: ReviewCommentPayload,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        self.add_comment_payload_at(session_id, run_id, comment, unix_time_millis()?)
    }

    pub fn add_comment_payload_at(
        &self,
        session_id: &str,
        run_id: &str,
        mut comment: ReviewCommentPayload,
        now_millis: u128,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        validate_path_segment(session_id)?;
        validate_path_segment(run_id)?;
        validate_comment_payload(&comment)?;
        comment.body = comment
            .body
            .trim_matches(['\r', '\n', '\t', ' '])
            .to_owned();
        let body_len = comment.body.len();
        let timestamp = now_millis.to_string();
        let thread_id_base = format!(
            "thread-{now_millis}-{}-{}-{body_len}",
            comment.start_line, comment.end_line
        );
        let message_id_base = format!(
            "msg-{now_millis}-{}-{}-{body_len}",
            comment.start_line, comment.end_line
        );
        let (old_path, new_path) = match comment.side {
            ReviewSide::Old => (Some(comment.file_path.clone()), None),
            ReviewSide::New => (None, Some(comment.file_path.clone())),
        };
        let thread = ReviewThread {
            id: thread_id_base.clone(),
            session_id: session_id.to_owned(),
            file_id: comment.file_path,
            old_path,
            new_path,
            anchor: ReviewAnchor {
                side: comment.side,
                start_line: comment.start_line,
                end_line: comment.end_line,
                start_column: None,
                end_column: None,
                selected_text: comment.selected_text.filter(|text| !text.is_empty()),
                hunk_header: None,
                line_text: None,
                diff_target_fingerprint: "agent".to_owned(),
                extra: BTreeMap::new(),
            },
            status: ReviewThreadStatus::Open,
            severity: comment.severity,
            category: comment.category,
            confidence: comment.confidence,
            source: Some(ReviewSource {
                kind: ReviewSourceKind::Agent,
                provider: Some("opencode".to_owned()),
                agent_run_id: Some(run_id.to_owned()),
                extra: BTreeMap::new(),
            }),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            messages: vec![ReviewMessage {
                id: message_id_base.clone(),
                author_id: run_id.to_owned(),
                body: comment.body,
                created_at: timestamp,
                updated_at: None,
                extra: BTreeMap::new(),
            }],
            extra: comment.extra,
        };
        self.write_new_compact_thread(session_id, thread, &thread_id_base, &message_id_base)
    }

    pub fn list_chat_messages(&self, session_id: &str) -> ReviewResult<Vec<ReviewChatMessage>> {
        self.list_session_json_files(
            session_id,
            Path::new("chat").join("messages").as_path(),
            MAX_COLLECTION_ITEM_BYTES,
        )
    }

    pub fn get_chat_messages(&self, session_id: &str) -> ReviewResult<Vec<ReviewChatMessage>> {
        self.list_chat_messages(session_id)
    }

    pub fn save_chat_message(
        &self,
        session_id: &str,
        message: ReviewChatMessage,
    ) -> ReviewResult<ReviewOperation<ReviewChatMessage>> {
        validate_path_segment(&message.id)?;
        let _guard = self.lock_writes();
        let relative = Path::new("chat").join("messages");
        let directory = self.ensure_session_subdirectory(session_id, &relative)?;
        self.write_json_atomic(&directory.join(format!("{}.json", message.id)), &message)?;
        Ok(ReviewOperation::changed(
            message,
            self.change(session_id, "chat.updated"),
        ))
    }

    fn write_thread(
        &self,
        session_id: &str,
        thread: ReviewThread,
        change: &str,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        validate_path_segment(&thread.id)?;
        let _guard = self.lock_writes();
        let directory = self.ensure_session_subdirectory(session_id, Path::new("threads"))?;
        self.write_json_atomic(&directory.join(format!("{}.json", thread.id)), &thread)?;
        Ok(ReviewOperation::changed(
            thread,
            self.change(session_id, change),
        ))
    }

    fn write_new_compact_thread(
        &self,
        session_id: &str,
        mut thread: ReviewThread,
        thread_id_base: &str,
        message_id_base: &str,
    ) -> ReviewResult<ReviewOperation<ReviewThread>> {
        let _guard = self.lock_writes();
        let directory = self.ensure_session_subdirectory(session_id, Path::new("threads"))?;
        let mut collision = 0_u64;
        loop {
            let suffix = if collision == 0 {
                String::new()
            } else {
                format!("-{collision}")
            };
            thread.id = format!("{thread_id_base}{suffix}");
            thread.messages[0].id = format!("{message_id_base}{suffix}");
            validate_path_segment(&thread.id)?;
            validate_path_segment(&thread.messages[0].id)?;
            let path = directory.join(format!("{}.json", thread.id));
            if self.write_json_new_atomic(&path, &thread)? {
                return Ok(ReviewOperation::changed(
                    thread,
                    self.change(session_id, "thread.created"),
                ));
            }
            collision = collision.checked_add(1).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "compact comment IDs exhausted",
                )
            })?;
        }
    }

    fn write_run_locked(&self, session_id: &str, run: &ReviewRun) -> ReviewResult<()> {
        validate_path_segment(&run.id)?;
        let directory = self.ensure_session_subdirectory(session_id, Path::new("runs"))?;
        self.write_json_atomic(&directory.join(format!("{}.json", run.id)), run)
    }

    fn list_session_json_files<T: for<'de> Deserialize<'de>>(
        &self,
        session_id: &str,
        relative_directory: &Path,
        limit: usize,
    ) -> ReviewResult<Vec<T>> {
        validate_path_segment(session_id)?;
        self.list_session_json_files_locked(session_id, relative_directory, limit)
    }

    fn list_session_json_files_locked<T: for<'de> Deserialize<'de>>(
        &self,
        session_id: &str,
        relative_directory: &Path,
        limit: usize,
    ) -> ReviewResult<Vec<T>> {
        let directory = self.ensure_session_subdirectory(session_id, relative_directory)?;
        let mut paths = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(".json"))
            {
                paths.push(entry.path());
            }
        }
        paths.sort();
        paths
            .into_iter()
            .map(|path| {
                let bytes = self.read_required(&path, limit)?;
                from_json(&bytes)
            })
            .collect()
    }

    fn ensure_session_directory(&self, session_id: &str) -> ReviewResult<PathBuf> {
        let directory = self.session_directory_path(session_id)?;
        fs::create_dir_all(&directory)?;
        Ok(directory)
    }

    fn ensure_session_subdirectory(
        &self,
        session_id: &str,
        relative_directory: &Path,
    ) -> ReviewResult<PathBuf> {
        let directory = self
            .ensure_session_directory(session_id)?
            .join(relative_directory);
        fs::create_dir_all(&directory)?;
        Ok(directory)
    }

    fn session_directory_path(&self, session_id: &str) -> ReviewResult<PathBuf> {
        validate_path_segment(session_id)?;
        Ok(self.reviews_root.join(SESSIONS_DIRECTORY).join(session_id))
    }

    fn session_file_path(&self, session_id: &str) -> ReviewResult<PathBuf> {
        Ok(self.session_directory_path(session_id)?.join(SESSION_FILE))
    }

    fn session_child_path(&self, session_id: &str, child: &str) -> ReviewResult<PathBuf> {
        Ok(self.session_directory_path(session_id)?.join(child))
    }

    fn read_optional(&self, path: &Path, limit: usize) -> ReviewResult<Option<Vec<u8>>> {
        match File::open(path) {
            Ok(file) => self.read_file_limited(file, path, limit).map(Some),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn read_required(&self, path: &Path, limit: usize) -> ReviewResult<Vec<u8>> {
        let file = File::open(path)?;
        self.read_file_limited(file, path, limit)
    }

    fn read_file_limited(&self, file: File, path: &Path, limit: usize) -> ReviewResult<Vec<u8>> {
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(ReviewError::FileTooLarge {
                path: path.to_owned(),
                limit,
            });
        }
        Ok(bytes)
    }

    fn write_json_atomic<T: Serialize + ?Sized>(&self, path: &Path, value: &T) -> ReviewResult<()> {
        self.write_atomic(path, &serde_json::to_vec(value)?)
    }

    fn write_json_new_atomic<T: Serialize + ?Sized>(
        &self,
        path: &Path,
        value: &T,
    ) -> ReviewResult<bool> {
        let contents = serde_json::to_vec(value)?;
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "review path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        let (temp_path, mut file) = create_unique_temp_file(parent)?;
        if let Err(error) = file.write_all(&contents).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(error.into());
        }
        drop(file);
        let result = match fs::hard_link(&temp_path, path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.into()),
        };
        let _ = fs::remove_file(temp_path);
        result
    }

    fn write_atomic(&self, path: &Path, contents: &[u8]) -> ReviewResult<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "review path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        let temp_path = atomic_temp_path(path);
        let result = (|| -> io::Result<()> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temp_path)?;
            file.write_all(contents)?;
            file.sync_all()?;
            drop(file);
            replace_file(&temp_path, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        result.map_err(Into::into)
    }

    fn change(&self, session_id: &str, change: &str) -> ReviewChanged {
        ReviewChanged {
            root: self.workspace_root.to_string_lossy().into_owned(),
            session_id: session_id.to_owned(),
            change: change.to_owned(),
        }
    }

    fn lock_writes(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub fn validate_path_segment(segment: &str) -> ReviewResult<()> {
    let valid = !segment.is_empty()
        && segment.len() <= MAX_PATH_SEGMENT_BYTES
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(ReviewError::InvalidPathSegment(segment.to_owned()))
    }
}

fn validate_comment_payload(comment: &ReviewCommentPayload) -> ReviewResult<()> {
    if Path::new(&comment.file_path).is_absolute() || comment.file_path.contains("..") {
        return Err(ReviewError::InvalidComment(
            "filePath must be a relative path without '..'",
        ));
    }
    if comment.start_line == 0 || comment.end_line < comment.start_line {
        return Err(ReviewError::InvalidComment("line range is invalid"));
    }
    if comment
        .body
        .trim_matches(['\r', '\n', '\t', ' '])
        .is_empty()
    {
        return Err(ReviewError::InvalidComment("body must not be empty"));
    }
    Ok(())
}

fn from_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> ReviewResult<T> {
    Ok(serde_json::from_slice(bytes)?)
}

static COMMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn create_unique_temp_file(parent: &Path) -> io::Result<(PathBuf, File)> {
    loop {
        let counter = COMMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".compact-comment-{}-{counter}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn atomic_temp_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(".tmp");
    PathBuf::from(value)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unix_time_millis() -> ReviewResult<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|_| ReviewError::ClockBeforeUnixEpoch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const CREATED_AT: &str = "2026-06-15T12:00:00.000Z";

    fn store() -> (TempDir, ReviewStore) {
        let temp = TempDir::new().unwrap();
        let store = ReviewStore::new(temp.path());
        (temp, store)
    }

    fn session(id: &str, root: &Path) -> ReviewSession {
        ReviewSession {
            id: id.to_owned(),
            repository_root: root.to_string_lossy().into_owned(),
            target: ReviewDiffTarget {
                base: Some("main".to_owned()),
                compare: None,
                include_staged: true,
                include_unstaged: true,
                extra: BTreeMap::new(),
            },
            head_at_creation: "abc123".to_owned(),
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
            title: Some("Local review".to_owned()),
            status: ReviewSessionStatus::Active,
            participants: Vec::new(),
            extra: BTreeMap::new(),
        }
    }

    fn progress() -> ReviewProgress {
        ReviewProgress {
            status: ReviewProgressStatus::Running,
            total_files: Some(12),
            reviewed_files: Some(4),
            active_files: Some(vec!["src/auth.ts".to_owned()]),
            pending_files: None,
            completed_files: None,
            message: Some("Reviewing authentication flow".to_owned()),
            last_activity_at: Some(CREATED_AT.to_owned()),
            extra: BTreeMap::new(),
        }
    }

    fn reviewed_file(id: &str, signature: &str) -> ReviewedFile {
        ReviewedFile {
            file_id: id.to_owned(),
            reviewed_at: CREATED_AT.to_owned(),
            reviewed_by: "local-human".to_owned(),
            signature: signature.to_owned(),
            extra: BTreeMap::new(),
        }
    }

    fn run(id: &str, status: ReviewRunStatus) -> ReviewRun {
        ReviewRun {
            id: id.to_owned(),
            session_id: "session-1".to_owned(),
            provider: "opencode".to_owned(),
            status,
            current_phase: Some("running".to_owned()),
            message: Some("working".to_owned()),
            opencode_session_id: Some("ses_1".to_owned()),
            started_at: "100".to_owned(),
            updated_at: "101".to_owned(),
            completed_at: None,
            extra: BTreeMap::new(),
        }
    }

    fn thread(id: &str) -> ReviewThread {
        ReviewThread {
            id: id.to_owned(),
            session_id: "session-1".to_owned(),
            file_id: "src/auth.ts".to_owned(),
            old_path: None,
            new_path: Some("src/auth.ts".to_owned()),
            anchor: ReviewAnchor {
                side: ReviewSide::New,
                start_line: 42,
                end_line: 42,
                start_column: Some(2),
                end_column: Some(18),
                selected_text: Some("validateToken(token)".to_owned()),
                hunk_header: None,
                line_text: None,
                diff_target_fingerprint: "target".to_owned(),
                extra: BTreeMap::new(),
            },
            status: ReviewThreadStatus::Open,
            severity: Some(ReviewSeverity::High),
            category: Some(ReviewCategory::Security),
            confidence: Some(ReviewConfidence::High),
            source: Some(ReviewSource {
                kind: ReviewSourceKind::Agent,
                provider: Some("opencode".to_owned()),
                agent_run_id: Some("run-1".to_owned()),
                extra: BTreeMap::new(),
            }),
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
            messages: vec![ReviewMessage {
                id: "message-1".to_owned(),
                author_id: "run-1".to_owned(),
                body: "Finding".to_owned(),
                created_at: CREATED_AT.to_owned(),
                updated_at: None,
                extra: BTreeMap::new(),
            }],
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn validates_exact_v1_path_segment_rules() {
        validate_path_segment("session-2026_06_23.1").unwrap();
        validate_path_segment(&"a".repeat(200)).unwrap();
        for invalid in [
            "",
            ".",
            "..",
            "../escape",
            "nested/id",
            "nested\\id",
            "contains space",
            "café",
        ] {
            assert!(matches!(
                validate_path_segment(invalid),
                Err(ReviewError::InvalidPathSegment(_))
            ));
        }
        assert!(validate_path_segment(&"a".repeat(201)).is_err());
    }

    #[test]
    fn config_default_and_round_trip_match_v1_contract() {
        let (_temp, store) = store();
        assert_eq!(store.get_config().unwrap(), ReviewConfig::default());
        assert!(!store.reviews_root().join(CONFIG_FILE).exists());

        let config = ReviewConfig {
            provider: "opencode".to_owned(),
            model: Some("provider/model".to_owned()),
            agent: Some("reviewer".to_owned()),
            max_parallel_agents: 3,
            prompt_instructions: "Focus on correctness".to_owned(),
            extra: BTreeMap::new(),
        };
        let saved = store.save_config(config.clone()).unwrap();
        assert_eq!(saved.result, config);
        assert_eq!(saved.event.unwrap().session_id, "");
        assert_eq!(store.get_config().unwrap(), config);
        assert!(!store.reviews_root().join("config.json.tmp").exists());
    }

    #[test]
    fn sessions_use_canonical_layout_and_missing_active_target_is_none() {
        let (temp, store) = store();
        assert_eq!(store.get_active_session().unwrap(), None);
        assert!(store.list_sessions().unwrap().is_empty());
        let first = session("session-1", temp.path());
        let second = session("session-2", temp.path());
        store.create_session(first.clone()).unwrap();
        store.create_session(second.clone()).unwrap();

        assert_eq!(store.get_active_session().unwrap(), Some(second.clone()));
        assert_eq!(store.list_sessions().unwrap(), vec![first, second]);
        assert!(
            store
                .reviews_root()
                .join("sessions/session-1/review.json")
                .is_file()
        );

        fs::write(store.reviews_root().join(ACTIVE_SESSION_FILE), "missing\n").unwrap();
        assert_eq!(store.get_active_session().unwrap(), None);
    }

    #[test]
    fn progress_round_trips_and_missing_progress_is_none() {
        let (_temp, store) = store();
        assert_eq!(store.get_progress("session-1").unwrap(), None);
        let value = progress();
        let saved = store.save_progress("session-1", value.clone()).unwrap();
        assert_eq!(saved.result, value);
        assert_eq!(saved.event.unwrap().change, "progress.updated");
        assert_eq!(store.get_progress("session-1").unwrap(), Some(value));
    }

    #[test]
    fn reviewed_file_updates_merge_remove_and_preserve_v1_extensions() {
        let (_temp, store) = store();
        assert_eq!(
            store.get_reviewed_files("session-1").unwrap(),
            ReviewedFilesState::default()
        );
        let mut initial = ReviewedFilesState::default();
        initial
            .files
            .insert("src/a.ts".to_owned(), reviewed_file("src/a.ts", "sig-a"));
        let mut retained = reviewed_file("src/retained.ts", "sig-retained");
        retained
            .extra
            .insert("fileExtension".to_owned(), Value::from("kept"));
        initial.files.insert("src/retained.ts".to_owned(), retained);
        initial
            .extra
            .insert("externalVersion".to_owned(), Value::from(7));
        store.save_reviewed_files("session-1", initial).unwrap();

        let mut additions = BTreeMap::new();
        additions.insert("src/b.ts".to_owned(), reviewed_file("src/b.ts", "sig-b"));
        let updated = store
            .update_reviewed_files(
                "session-1",
                ReviewedFilesUpdate {
                    files: Some(additions),
                    remove_file_ids: Some(vec!["src/a.ts".to_owned()]),
                },
            )
            .unwrap()
            .result;
        assert_eq!(updated.files.len(), 2);
        assert!(updated.files.contains_key("src/b.ts"));
        assert_eq!(
            updated.files["src/retained.ts"].extra["fileExtension"],
            "kept"
        );
        assert_eq!(updated.extra["externalVersion"], 7);
    }

    #[test]
    fn agents_runs_threads_and_chat_round_trip_in_v1_directories() {
        let (_temp, store) = store();
        let agent = ReviewAgentState {
            id: "agent-1".to_owned(),
            provider: "opencode".to_owned(),
            status: ReviewAgentStatus::Running,
            current_phase: Some("reviewing-file".to_owned()),
            current_file: Some("src/auth.ts".to_owned()),
            last_thought_summary: Some("Checking auth".to_owned()),
            reviewed_files: Some(vec!["src/api.ts".to_owned()]),
            started_at: Some("100".to_owned()),
            updated_at: Some("101".to_owned()),
            extra: BTreeMap::new(),
        };
        let run = run("run-1", ReviewRunStatus::Running);
        let thread = thread("thread-1");
        let chat = ReviewChatMessage {
            id: "chat-1".to_owned(),
            session_id: "session-1".to_owned(),
            role: ReviewChatRole::User,
            body: "Is this safe?".to_owned(),
            created_at: CREATED_AT.to_owned(),
            provider: None,
            run_id: None,
            context: Some(ReviewChatContext {
                file_id: Some("src/auth.ts".to_owned()),
                selection: None,
                thread_ids: Some(vec!["thread-1".to_owned()]),
                extra: BTreeMap::new(),
            }),
            extra: BTreeMap::new(),
        };

        store.save_agent_state("session-1", agent.clone()).unwrap();
        store.create_run("session-1", run.clone()).unwrap();
        store.add_comment("session-1", thread.clone()).unwrap();
        store.save_chat_message("session-1", chat.clone()).unwrap();
        assert_eq!(store.list_agent_states("session-1").unwrap(), vec![agent]);
        assert_eq!(store.list_runs("session-1").unwrap(), vec![run]);
        assert_eq!(store.list_threads("session-1").unwrap(), vec![thread]);
        assert_eq!(store.list_chat_messages("session-1").unwrap(), vec![chat]);
    }

    #[test]
    fn run_rpc_aliases_use_the_zig_run_updated_event() {
        let (_temp, store) = store();
        let value = run("run-1", ReviewRunStatus::Starting);
        for operation in [
            store.create_run("session-1", value.clone()).unwrap(),
            store.update_run("session-1", value.clone()).unwrap(),
            store.finish_run("session-1", value.clone()).unwrap(),
        ] {
            assert_eq!(operation.event.unwrap().change, "run.updated");
        }
    }

    #[test]
    fn stale_recovery_updates_only_active_runs_and_preserves_extensions() {
        let (_temp, store) = store();
        let statuses = [
            ReviewRunStatus::Starting,
            ReviewRunStatus::Planning,
            ReviewRunStatus::Running,
            ReviewRunStatus::Cancelling,
            ReviewRunStatus::Completed,
            ReviewRunStatus::Failed,
            ReviewRunStatus::Cancelled,
        ];
        for (index, status) in statuses.into_iter().enumerate() {
            let mut value = run(&format!("run-{index}"), status);
            value.extra.insert("external".to_owned(), Value::Bool(true));
            store.save_run("session-1", value).unwrap();
        }

        let recovered = store.recover_stale_runs_at("session-1", 1234).unwrap();
        assert_eq!(recovered.result.recovered, 4);
        assert_eq!(recovered.event.unwrap().change, "runs.recovered");
        let runs = store.list_runs("session-1").unwrap();
        for value in &runs[..4] {
            assert_eq!(value.status, ReviewRunStatus::Failed);
            assert_eq!(value.current_phase.as_deref(), Some("interrupted"));
            assert_eq!(value.message.as_deref(), Some(INTERRUPTED_MESSAGE));
            assert_eq!(value.updated_at, "1234");
            assert_eq!(value.completed_at.as_deref(), Some("1234"));
            assert_eq!(value.extra["external"], true);
        }
        let second = store.recover_stale_runs_at("session-1", 5678).unwrap();
        assert_eq!(second.result.recovered, 0);
        assert_eq!(second.event, None);
    }

    #[test]
    fn compact_comment_expands_to_the_zig_thread_shape() {
        let (_temp, store) = store();
        let operation = store
            .add_comment_payload_at(
                "session-1",
                "run-1",
                ReviewCommentPayload {
                    file_path: "src/auth.ts".to_owned(),
                    side: ReviewSide::New,
                    start_line: 42,
                    end_line: 43,
                    body: "  Finding body\n".to_owned(),
                    severity: Some(ReviewSeverity::High),
                    category: Some(ReviewCategory::Security),
                    confidence: Some(ReviewConfidence::High),
                    selected_text: Some("validateToken(token)".to_owned()),
                    extra: BTreeMap::new(),
                },
                1000,
            )
            .unwrap();
        let value = operation.result;
        assert_eq!(value.id, "thread-1000-42-43-12");
        assert_eq!(value.new_path.as_deref(), Some("src/auth.ts"));
        assert_eq!(value.old_path, None);
        assert_eq!(value.anchor.diff_target_fingerprint, "agent");
        assert_eq!(value.created_at, "1000");
        assert_eq!(value.messages[0].id, "msg-1000-42-43-12");
        assert_eq!(value.messages[0].body, "Finding body");
        assert_eq!(operation.event.unwrap().change, "thread.created");
        assert_eq!(store.list_threads("session-1").unwrap(), vec![value]);
    }

    #[test]
    fn compact_comment_rejects_zig_invalid_inputs_before_writing() {
        let (_temp, store) = store();
        let payload = |file_path: &str, start_line, end_line, body: &str| ReviewCommentPayload {
            file_path: file_path.to_owned(),
            side: ReviewSide::Old,
            start_line,
            end_line,
            body: body.to_owned(),
            severity: None,
            category: None,
            confidence: None,
            selected_text: None,
            extra: BTreeMap::new(),
        };
        for value in [
            payload("../secret", 1, 1, "body"),
            payload("src/a.ts", 0, 1, "body"),
            payload("src/a.ts", 2, 1, "body"),
            payload("src/a.ts", 1, 1, " \r\n\t"),
        ] {
            assert!(
                store
                    .add_comment_payload_at("session-1", "run-1", value, 1000)
                    .is_err()
            );
        }
        assert!(store.list_threads("session-1").unwrap().is_empty());
    }

    #[test]
    fn session_config_progress_and_agent_extensions_survive_updates() {
        let (_temp, store) = store();
        fs::create_dir_all(store.reviews_root()).unwrap();

        let config_path = store.reviews_root().join(CONFIG_FILE);
        fs::write(
            &config_path,
            serde_json::to_vec(&serde_json::json!({
                "provider": "external",
                "maxParallelAgents": 2,
                "promptInstructions": "external",
                "configExtension": { "version": 2 }
            }))
            .unwrap(),
        )
        .unwrap();
        let mut config = store.get_config().unwrap();
        config.provider = "updated".to_owned();
        store.save_config(config).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert_eq!(saved["configExtension"]["version"], 2);

        let session_path = store.reviews_root().join("sessions/session-1/review.json");
        fs::create_dir_all(session_path.parent().unwrap()).unwrap();
        fs::write(
            &session_path,
            serde_json::to_vec(&serde_json::json!({
                "id": "session-1",
                "repositoryRoot": "/repo",
                "target": {
                    "base": "main",
                    "compare": null,
                    "includeStaged": true,
                    "includeUnstaged": true,
                    "targetExtension": "kept"
                },
                "headAtCreation": "abc123",
                "createdAt": CREATED_AT,
                "updatedAt": CREATED_AT,
                "status": "active",
                "participants": [{
                    "id": "agent-1",
                    "kind": "ai",
                    "displayName": "Agent",
                    "participantExtension": 1,
                    "agent": {
                        "provider": "external",
                        "agentExtension": true
                    }
                }],
                "sessionExtension": [1, 2, 3]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(store.reviews_root().join(ACTIVE_SESSION_FILE), "session-1").unwrap();
        let mut session = store.get_active_session().unwrap().unwrap();
        session.title = Some("Updated".to_owned());
        store.create_session(session).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(session_path).unwrap()).unwrap();
        assert_eq!(saved["sessionExtension"], serde_json::json!([1, 2, 3]));
        assert_eq!(saved["target"]["targetExtension"], "kept");
        assert_eq!(saved["participants"][0]["participantExtension"], 1);
        assert_eq!(saved["participants"][0]["agent"]["agentExtension"], true);

        let progress_path = store
            .reviews_root()
            .join("sessions/session-1/progress.json");
        fs::write(
            &progress_path,
            br#"{"status":"running","progressExtension":{"owner":"external"}}"#,
        )
        .unwrap();
        let mut progress = store.get_progress("session-1").unwrap().unwrap();
        progress.message = Some("Updated".to_owned());
        store.save_progress("session-1", progress).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(progress_path).unwrap()).unwrap();
        assert_eq!(saved["progressExtension"]["owner"], "external");

        let agent_path = store
            .reviews_root()
            .join("sessions/session-1/agents/agent-1.json");
        fs::create_dir_all(agent_path.parent().unwrap()).unwrap();
        fs::write(
            &agent_path,
            br#"{"id":"agent-1","provider":"external","status":"running","agentStateExtension":9}"#,
        )
        .unwrap();
        let mut agent = store.list_agent_states("session-1").unwrap().remove(0);
        agent.status = ReviewAgentStatus::Idle;
        store.save_agent_state("session-1", agent).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(agent_path).unwrap()).unwrap();
        assert_eq!(saved["agentStateExtension"], 9);
    }

    #[test]
    fn thread_chat_and_compact_payload_extensions_survive_updates() {
        let (_temp, store) = store();
        let thread_path = store
            .reviews_root()
            .join("sessions/session-1/threads/thread-external.json");
        fs::create_dir_all(thread_path.parent().unwrap()).unwrap();
        fs::write(
            &thread_path,
            serde_json::to_vec(&serde_json::json!({
                "id": "thread-external",
                "sessionId": "session-1",
                "fileId": "src/a.ts",
                "newPath": "src/a.ts",
                "anchor": {
                    "side": "new",
                    "startLine": 1,
                    "endLine": 1,
                    "diffTargetFingerprint": "external",
                    "anchorExtension": "kept"
                },
                "status": "open",
                "source": {
                    "kind": "agent",
                    "provider": "external",
                    "sourceExtension": 4
                },
                "createdAt": "100",
                "updatedAt": "100",
                "messages": [{
                    "id": "message-external",
                    "authorId": "agent-1",
                    "body": "Finding",
                    "createdAt": "100",
                    "messageExtension": false
                }],
                "threadExtension": { "key": "value" }
            }))
            .unwrap(),
        )
        .unwrap();
        let mut thread = store.list_threads("session-1").unwrap().remove(0);
        thread.status = ReviewThreadStatus::Resolved;
        store.save_thread("session-1", thread).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(thread_path).unwrap()).unwrap();
        assert_eq!(saved["threadExtension"]["key"], "value");
        assert_eq!(saved["anchor"]["anchorExtension"], "kept");
        assert_eq!(saved["source"]["sourceExtension"], 4);
        assert_eq!(saved["messages"][0]["messageExtension"], false);

        let chat_path = store
            .reviews_root()
            .join("sessions/session-1/chat/messages/chat-external.json");
        fs::create_dir_all(chat_path.parent().unwrap()).unwrap();
        fs::write(
            &chat_path,
            serde_json::to_vec(&serde_json::json!({
                "id": "chat-external",
                "sessionId": "session-1",
                "role": "user",
                "body": "Question",
                "createdAt": "100",
                "context": {
                    "fileId": "src/a.ts",
                    "selection": {
                        "side": "new",
                        "startLine": 1,
                        "endLine": 1,
                        "diffTargetFingerprint": "external",
                        "selectionExtension": 5
                    },
                    "contextExtension": true
                },
                "chatExtension": "kept"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut chat = store.list_chat_messages("session-1").unwrap().remove(0);
        chat.body = "Updated".to_owned();
        store.save_chat_message("session-1", chat).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(chat_path).unwrap()).unwrap();
        assert_eq!(saved["chatExtension"], "kept");
        assert_eq!(saved["context"]["contextExtension"], true);
        assert_eq!(saved["context"]["selection"]["selectionExtension"], 5);

        let payload: ReviewCommentPayload = serde_json::from_value(serde_json::json!({
            "filePath": "src/new.ts",
            "side": "new",
            "startLine": 3,
            "endLine": 3,
            "body": "Compact finding",
            "payloadExtension": { "external": true }
        }))
        .unwrap();
        let compact = store
            .add_comment_payload_at("session-1", "run-1", payload, 500)
            .unwrap()
            .result;
        assert_eq!(compact.extra["payloadExtension"]["external"], true);
    }

    #[test]
    fn concurrent_compact_comments_get_unique_path_safe_ids_without_overwrite() {
        let (temp, store) = store();
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let handles = (0..12)
            .map(|index| {
                let root = temp.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let store = ReviewStore::new(root);
                    barrier.wait();
                    store
                        .add_comment_payload_at(
                            "session-1",
                            "run-1",
                            ReviewCommentPayload {
                                file_path: "src/a.ts".to_owned(),
                                side: ReviewSide::New,
                                start_line: 7,
                                end_line: 7,
                                body: format!("finding-{index:02}"),
                                severity: None,
                                category: None,
                                confidence: None,
                                selected_text: None,
                                extra: BTreeMap::new(),
                            },
                            1_000,
                        )
                        .unwrap()
                        .result
                })
            })
            .collect::<Vec<_>>();
        let mut ids = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().id)
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 12);
        assert!(ids.iter().all(|id| validate_path_segment(id).is_ok()));

        let threads = store.list_threads("session-1").unwrap();
        assert_eq!(threads.len(), 12);
        let mut bodies = threads
            .iter()
            .map(|thread| thread.messages[0].body.clone())
            .collect::<Vec<_>>();
        bodies.sort();
        bodies.dedup();
        assert_eq!(bodies.len(), 12);
    }

    #[test]
    fn reads_external_v1_json_without_rewriting_it() {
        let (_temp, store) = store();
        let path = store
            .reviews_root()
            .join("sessions/session-1/threads/external.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = br#"{
          "id":"external","sessionId":"session-1","fileId":"src/a.ts",
          "oldPath":null,"newPath":"src/a.ts",
          "anchor":{"side":"new","startLine":1,"endLine":1,"diffTargetFingerprint":"agent"},
          "status":"open","createdAt":"100","updatedAt":"100",
          "messages":[{"id":"m","authorId":"agent","body":"body","createdAt":"100"}]
        }"#;
        fs::write(&path, original).unwrap();
        let threads = store.list_threads("session-1").unwrap();
        assert_eq!(threads[0].old_path, None);
        assert_eq!(threads[0].new_path.as_deref(), Some("src/a.ts"));
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn invalid_ids_cannot_escape_the_review_root() {
        let (temp, store) = store();
        let error = store.save_progress("../outside", progress()).unwrap_err();
        assert!(matches!(error, ReviewError::InvalidPathSegment(_)));
        assert!(!temp.path().join("outside").exists());
    }

    #[test]
    fn bounded_reads_reject_oversized_v1_files() {
        let (_temp, store) = store();
        let path = store.reviews_root().join(CONFIG_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        assert!(matches!(
            store.get_config(),
            Err(ReviewError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn cloned_stores_serialize_read_modify_write_updates() {
        let (_temp, store) = store();
        let mut initial = ReviewedFilesState::default();
        initial
            .files
            .insert("base".to_owned(), reviewed_file("base", "0"));
        store.save_reviewed_files("session-1", initial).unwrap();

        let handles = (1..=8)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let id = format!("file-{index}");
                    let mut files = BTreeMap::new();
                    files.insert(id.clone(), reviewed_file(&id, &index.to_string()));
                    store
                        .update_reviewed_files(
                            "session-1",
                            ReviewedFilesUpdate {
                                files: Some(files),
                                remove_file_ids: None,
                            },
                        )
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            store.get_reviewed_files("session-1").unwrap().files.len(),
            9
        );
    }
}
