use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CoreError, CoreResult, WorkspaceGeneration, WorkspaceId};

pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const MAX_ID_BYTES: usize = 512;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CHOICE_BYTES: usize = 8 * 1024;
const MAX_CHOICES: usize = 128;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_JSON_DEPTH: usize = 32;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidParams(message.into())
}

fn validate_id(value: &str, field: &str) -> CoreResult<()> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(invalid(format!(
            "{field} must contain between 1 and {MAX_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

pub(crate) fn validate_entity_revision(revision: u64, field: &str) -> CoreResult<()> {
    if revision == 0 || revision > MAX_SAFE_REVISION {
        return Err(invalid(format!(
            "{field} must be between 1 and JavaScript's maximum safe integer"
        )));
    }
    Ok(())
}

fn validate_ui_expected_revision(revision: u64) -> CoreResult<()> {
    if revision > MAX_SAFE_REVISION {
        return Err(invalid(
            "expectedRevision exceeds JavaScript's safe integer range",
        ));
    }
    Ok(())
}

fn validate_json(value: &Value, field: &str) -> CoreResult<()> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| invalid(format!("{field} is not serializable: {error}")))?;
    if encoded.len() > MAX_JSON_BYTES {
        return Err(invalid(format!("{field} exceeds {MAX_JSON_BYTES} bytes")));
    }

    fn depth(value: &Value, current: usize) -> usize {
        match value {
            Value::Array(values) => values
                .iter()
                .map(|value| depth(value, current + 1))
                .max()
                .unwrap_or(current),
            Value::Object(values) => values
                .values()
                .map(|value| depth(value, current + 1))
                .max()
                .unwrap_or(current),
            _ => current,
        }
    }
    if depth(value, 1) > MAX_JSON_DEPTH {
        return Err(invalid(format!("{field} exceeds {MAX_JSON_DEPTH} levels")));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionKind {
    Input,
    Error,
    Completion,
}

impl AttentionKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::Error => "error",
            Self::Completion => "completion",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "input" => Some(Self::Input),
            "error" => Some(Self::Error),
            "completion" => Some(Self::Completion),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionStatus {
    Unread,
    Acknowledged,
    Resolved,
    Expired,
    Superseded,
}

impl AttentionStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Unread => "unread",
            Self::Acknowledged => "acknowledged",
            Self::Resolved => "resolved",
            Self::Expired => "expired",
            Self::Superseded => "superseded",
        }
    }

    pub(crate) const fn is_terminal(self) -> bool {
        matches!(self, Self::Resolved | Self::Expired | Self::Superseded)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceNavigationTarget {
    Input {
        input_request_id: String,
    },
    Review {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        review_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
    },
    Agent {
        agent_session_id: String,
    },
    Settings {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        section: Option<String>,
    },
    Workspace,
}

impl WorkspaceNavigationTarget {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        match self {
            Self::Input { input_request_id } => validate_id(input_request_id, "inputRequestId"),
            Self::Review {
                file_id,
                review_session_id,
                thread_id,
            } => {
                for (value, field) in [
                    (file_id, "fileId"),
                    (review_session_id, "reviewSessionId"),
                    (thread_id, "threadId"),
                ] {
                    if let Some(value) = value {
                        validate_id(value, field)?;
                    }
                }
                Ok(())
            }
            Self::Agent { agent_session_id } => validate_id(agent_session_id, "agentSessionId"),
            Self::Settings { section } => {
                if let Some(section) = section {
                    validate_id(section, "section")?;
                }
                Ok(())
            }
            Self::Workspace => Ok(()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    pub workspace_id: WorkspaceId,
    pub source_id: String,
    pub kind: AttentionKind,
    pub revision: u64,
    pub status: AttentionStatus,
    pub target: WorkspaceNavigationTarget,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceAttentionState {
    InputRequired,
    Error,
    Unread,
    Running,
    #[default]
    Idle,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAttentionSummary {
    pub state: WorkspaceAttentionState,
    pub input_required: u64,
    pub errors: u64,
    pub unread: u64,
    pub running: u64,
    pub total: u64,
}

impl WorkspaceAttentionSummary {
    pub fn aggregate<'a>(summaries: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut result = Self::default();
        for summary in summaries {
            result.input_required = result.input_required.saturating_add(summary.input_required);
            result.errors = result.errors.saturating_add(summary.errors);
            result.unread = result.unread.saturating_add(summary.unread);
            result.running = result.running.saturating_add(summary.running);
            result.total = result.total.saturating_add(summary.total);
        }
        result.state = result.highest_state();
        result
    }

    pub(crate) const fn highest_state(&self) -> WorkspaceAttentionState {
        if self.input_required > 0 {
            WorkspaceAttentionState::InputRequired
        } else if self.errors > 0 {
            WorkspaceAttentionState::Error
        } else if self.unread > 0 {
            WorkspaceAttentionState::Unread
        } else if self.running > 0 {
            WorkspaceAttentionState::Running
        } else {
            WorkspaceAttentionState::Idle
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputRequestKind {
    Permission,
    Question,
    Authentication,
    Conflict,
}

impl InputRequestKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Authentication => "authentication",
            Self::Conflict => "conflict",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "permission" => Some(Self::Permission),
            "question" => Some(Self::Question),
            "authentication" => Some(Self::Authentication),
            "conflict" => Some(Self::Conflict),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputRequestStatus {
    Pending,
    ResponseSubmitted,
    Accepted,
    Rejected,
    Expired,
    Cancelled,
    Superseded,
}

impl InputRequestStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::ResponseSubmitted => "response-submitted",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }

    pub(crate) const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Accepted | Self::Rejected | Self::Expired | Self::Cancelled | Self::Superseded
        )
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "response-submitted" => Some(Self::ResponseSubmitted),
            "accepted" => Some(Self::Accepted),
            "rejected" => Some(Self::Rejected),
            "expired" => Some(Self::Expired),
            "cancelled" => Some(Self::Cancelled),
            "superseded" => Some(Self::Superseded),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    pub id: String,
    pub workspace_id: WorkspaceId,
    pub revision: u64,
    pub kind: InputRequestKind,
    pub status: InputRequestStatus,
    pub prompt: String,
    pub choices: Vec<String>,
    pub cancellation_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<InputResponse>,
    pub attention_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputResponse {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationOutcome {
    Applied,
    Unchanged,
    Stale,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionMutationResult {
    pub outcome: MutationOutcome,
    pub item: AttentionItem,
    pub summary: WorkspaceAttentionSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputMutationResult {
    pub outcome: MutationOutcome,
    pub input: InputRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<AttentionItem>,
    pub summary: WorkspaceAttentionSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUiStateRecord {
    pub revision: u64,
    pub state: Value,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUiStateMutationResult {
    pub outcome: MutationOutcome,
    pub record: WorkspaceUiStateRecord,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceUiStateRequest {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub expected_revision: u64,
    pub state: Value,
}

impl SaveWorkspaceUiStateRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        validate_ui_expected_revision(self.expected_revision)?;
        validate_json(&self.state, "state")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAttentionRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub source_id: String,
    pub kind: AttentionKind,
    pub revision: u64,
    #[serde(default)]
    pub status: Option<AttentionStatus>,
    pub target: WorkspaceNavigationTarget,
}

impl CreateAttentionRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        if let Some(id) = &self.id {
            validate_id(id, "id")?;
        }
        validate_id(&self.source_id, "sourceId")?;
        validate_entity_revision(self.revision, "revision")?;
        if self.status == Some(AttentionStatus::Acknowledged) {
            return Err(invalid("acknowledged is a local attention lifecycle state"));
        }
        self.target.validate()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCasRequest {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    #[serde(alias = "id")]
    pub attention_id: String,
    #[serde(alias = "revision")]
    pub expected_revision: u64,
}

impl AttentionCasRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        validate_id(&self.attention_id, "attentionId")?;
        validate_entity_revision(self.expected_revision, "expectedRevision")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInputRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    pub revision: u64,
    pub kind: InputRequestKind,
    pub prompt: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub cancellation_supported: bool,
    #[serde(default)]
    pub attention_id: Option<String>,
    #[serde(default)]
    pub target: Option<WorkspaceNavigationTarget>,
}

impl CreateInputRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        if let Some(id) = &self.id {
            validate_id(id, "id")?;
        }
        if let Some(id) = &self.attention_id {
            validate_id(id, "attentionId")?;
        }
        validate_entity_revision(self.revision, "revision")?;
        if self.prompt.is_empty() || self.prompt.len() > MAX_PROMPT_BYTES {
            return Err(invalid(format!(
                "prompt must contain between 1 and {MAX_PROMPT_BYTES} bytes"
            )));
        }
        if self.choices.len() > MAX_CHOICES {
            return Err(invalid(format!("choices exceeds {MAX_CHOICES} entries")));
        }
        for choice in &self.choices {
            if choice.is_empty() || choice.len() > MAX_CHOICE_BYTES {
                return Err(invalid(format!(
                    "each choice must contain between 1 and {MAX_CHOICE_BYTES} bytes"
                )));
            }
        }
        let request_bytes = self
            .choices
            .iter()
            .fold(self.prompt.len(), |total, choice| {
                total.saturating_add(choice.len()).saturating_add(4)
            });
        if request_bytes > MAX_JSON_BYTES {
            return Err(invalid(format!(
                "input request content exceeds {MAX_JSON_BYTES} bytes"
            )));
        }
        if let Some(target) = &self.target {
            target.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerInputRequest {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    #[serde(alias = "id", alias = "inputRequestId")]
    pub input_id: String,
    #[serde(alias = "revision")]
    pub expected_revision: u64,
    pub response: InputResponse,
    #[serde(default)]
    pub redact_response: bool,
}

impl AnswerInputRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        validate_id(&self.input_id, "inputId")?;
        validate_entity_revision(self.expected_revision, "expectedRevision")?;
        if self.response.value.len() > MAX_RESPONSE_BYTES {
            return Err(invalid(format!(
                "response.value exceeds {MAX_RESPONSE_BYTES} bytes"
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputCasRequest {
    pub workspace_id: WorkspaceId,
    pub workspace_generation: WorkspaceGeneration,
    #[serde(alias = "id", alias = "inputRequestId")]
    pub input_id: String,
    #[serde(alias = "revision")]
    pub expected_revision: u64,
}

impl InputCasRequest {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        validate_id(&self.input_id, "inputId")?;
        validate_entity_revision(self.expected_revision, "expectedRevision")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rejects_unsafe_revisions_and_oversized_identifiers() {
        let request = AttentionCasRequest {
            workspace_id: WorkspaceId::new(),
            workspace_generation: WorkspaceGeneration::new(),
            attention_id: "a".repeat(MAX_ID_BYTES + 1),
            expected_revision: MAX_SAFE_REVISION + 1,
        };

        assert!(matches!(
            request.validate(),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn zero_is_reserved_for_initial_ui_state_cas() {
        let workspace_id = WorkspaceId::new();
        let workspace_generation = WorkspaceGeneration::new();
        assert!(
            SaveWorkspaceUiStateRequest {
                workspace_id,
                workspace_generation,
                expected_revision: 0,
                state: json!({}),
            }
            .validate()
            .is_ok()
        );
        assert!(matches!(
            CreateAttentionRequest {
                id: None,
                workspace_id,
                workspace_generation,
                source_id: "source".to_owned(),
                kind: AttentionKind::Completion,
                revision: 0,
                status: None,
                target: WorkspaceNavigationTarget::Workspace,
            }
            .validate(),
            Err(CoreError::InvalidParams(_))
        ));
        assert!(matches!(
            AttentionCasRequest {
                workspace_id,
                workspace_generation,
                attention_id: "attention".to_owned(),
                expected_revision: 0,
            }
            .validate(),
            Err(CoreError::InvalidParams(_))
        ));
        assert!(matches!(
            CreateInputRequest {
                id: None,
                workspace_id,
                workspace_generation,
                revision: 0,
                kind: InputRequestKind::Question,
                prompt: "prompt".to_owned(),
                choices: Vec::new(),
                cancellation_supported: false,
                attention_id: None,
                target: None,
            }
            .validate(),
            Err(CoreError::InvalidParams(_))
        ));
        assert!(matches!(
            InputCasRequest {
                workspace_id,
                workspace_generation,
                input_id: "input".to_owned(),
                expected_revision: 0,
            }
            .validate(),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn rejects_deep_or_non_object_ui_state_before_persistence() {
        let mut state = json!(null);
        for _ in 0..MAX_JSON_DEPTH {
            state = json!({ "nested": state });
        }
        let request = SaveWorkspaceUiStateRequest {
            workspace_id: WorkspaceId::new(),
            workspace_generation: WorkspaceGeneration::new(),
            expected_revision: 0,
            state,
        };

        assert!(matches!(
            request.validate(),
            Err(CoreError::InvalidParams(_))
        ));
    }
}
