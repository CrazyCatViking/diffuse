use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, RwLock};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use crate::database::WorkbenchDatabase;
use crate::diff::{self, DiffRenderOptions};
use crate::lsp::{self, DocumentProvider, SourceDocument};
use crate::repository::{ChangedFile, DiffTarget, FileStatus, Repository};
use crate::review::{
    ReviewAgentState, ReviewChatMessage, ReviewCommentPayload, ReviewConfig, ReviewError,
    ReviewOperation, ReviewProgress, ReviewRun, ReviewSession, ReviewThread, ReviewedFilesState,
    ReviewedFilesUpdate,
};
use crate::search::{
    self, ChangedFilesProvider, ReviewCommentsProvider, SearchError, SearchEvent, SearchEventSink,
    SearchFilterKind, SearchMode, SearchRequest, SourceTextProvider,
};
use crate::syntax::{
    self, SyntaxDocumentProvider, SyntaxManager, SyntaxManagerOptions, SyntaxSourceDocument,
};
use crate::workspace::{WorkspaceRegistry, WorkspaceRuntime};
use crate::{
    BranchInfo, CoreError, CoreResult, DiffTargetDefaults, EventHub, WorkspaceGeneration,
    WorkspaceId, WorkspaceRequestContext, WorkspaceSnapshot, WorkspaceSummary,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
    pub workspaces: Vec<WorkspaceSummary>,
    pub active_workspace_id: Option<WorkspaceId>,
    #[serde(default)]
    pub active_workspace: Option<WorkspaceSnapshot>,
    pub sequence: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppCoreLifecycleState {
    #[default]
    Running,
    ShuttingDown,
    Stopped,
}

#[derive(Clone, Debug)]
pub struct AppCoreOptions {
    pub syntax: SyntaxManagerOptions,
}

impl Default for AppCoreOptions {
    fn default() -> Self {
        Self {
            syntax: SyntaxManagerOptions::from_environment(),
        }
    }
}

struct AppCoreInner {
    registry: WorkspaceRegistry,
    database: WorkbenchDatabase,
    events: Arc<EventHub>,
    syntax: Arc<SyntaxManager>,
    active_workspace_id: RwLock<Option<WorkspaceId>>,
    lifecycle_state: RwLock<AppCoreLifecycleState>,
    state_gate: StdMutex<()>,
    lifecycle_events: StdMutex<()>,
    open_commit: AsyncMutex<()>,
    shutdown_gate: StdMutex<()>,
}

#[derive(Clone)]
pub struct AppCore {
    inner: Arc<AppCoreInner>,
}

#[derive(Deserialize)]
struct TargetParams {
    target: DiffTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRenderParams {
    file_id: String,
    options: DiffRenderOptions,
    target: DiffTarget,
}

#[derive(Deserialize)]
struct ReviewConfigParams {
    config: ReviewConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize)]
struct CreateSessionParams {
    session: ReviewSession,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressParams {
    session_id: String,
    progress: ReviewProgress,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedFilesParams {
    session_id: String,
    reviewed_files: ReviewedFilesState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedFilesUpdateParams {
    session_id: String,
    update: ReviewedFilesUpdate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentParams {
    session_id: String,
    agent: ReviewAgentState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    session_id: String,
    run: ReviewRun,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageParams {
    session_id: String,
    message: ReviewChatMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentPayloadParams {
    session_id: String,
    run_id: String,
    comment: ReviewCommentPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentParams {
    session_id: String,
    comment: ReviewThread,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadParams {
    session_id: String,
    thread: ReviewThread,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    search_id: Option<String>,
    session_id: String,
    query: String,
    mode: SearchMode,
    filters: Vec<SearchFilterKind>,
    target: DiffTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelSearchParams {
    search_id: String,
}

impl AppCore {
    pub fn new(database: WorkbenchDatabase) -> Self {
        Self::with_options(database, AppCoreOptions::default())
            .expect("default syntax roots are safe managed paths")
    }

    pub fn with_options(database: WorkbenchDatabase, options: AppCoreOptions) -> CoreResult<Self> {
        let syntax = SyntaxManager::new(options.syntax)
            .map_err(|error| CoreError::Syntax(error.to_string()))?;
        Ok(Self {
            inner: Arc::new(AppCoreInner {
                registry: WorkspaceRegistry::default(),
                database,
                events: Arc::new(EventHub::default()),
                syntax: Arc::new(syntax),
                active_workspace_id: RwLock::new(None),
                lifecycle_state: RwLock::new(AppCoreLifecycleState::Running),
                state_gate: StdMutex::new(()),
                lifecycle_events: StdMutex::new(()),
                open_commit: AsyncMutex::new(()),
                shutdown_gate: StdMutex::new(()),
            }),
        })
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
        let active_workspace_id = *self
            .inner
            .active_workspace_id
            .read()
            .expect("active workspace lock poisoned");
        let active_workspace = active_workspace_id
            .and_then(|workspace_id| self.inner.registry.by_id(workspace_id))
            .map(|runtime| runtime.snapshot());
        WorkbenchSnapshot {
            workspaces,
            active_workspace_id,
            active_workspace,
            sequence: self.inner.events.current_sequence(),
        }
    }

    pub fn lifecycle_state(&self) -> AppCoreLifecycleState {
        *self
            .inner
            .lifecycle_state
            .read()
            .expect("app core lifecycle lock poisoned")
    }

    pub async fn open_workspace(&self, path: impl AsRef<Path>) -> CoreResult<WorkspaceSnapshot> {
        let path = path.as_ref().to_owned();
        let repository = tokio::task::spawn_blocking(move || Repository::open(&path))
            .await
            .map_err(|error| CoreError::TaskFailed(error.to_string()))??;
        let canonical_root = repository.canonical_key();
        let _commit = self.inner.open_commit.lock().await;

        let existing = self.inner.registry.by_root(&canonical_root);
        if let Some(runtime) = existing {
            return self.activate_workspace(runtime.id, runtime.generation);
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
        let mut runtime =
            WorkspaceRuntime::new(id, generation, canonical_root, display_name, repository);
        if let Err(error) = runtime.start_watcher(self.inner.events.clone()) {
            let _ = self.inner.database.close_workspace(id);
            return Err(error);
        }
        let runtime = Arc::new(runtime);
        let lifecycle_event = self
            .inner
            .lifecycle_events
            .lock()
            .expect("app core lifecycle event lock poisoned");
        let state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        if self.lifecycle_state() != AppCoreLifecycleState::Running {
            drop(state);
            runtime.stop_watcher();
            self.inner.database.close_workspace(id)?;
            return Err(CoreError::AppCoreShuttingDown);
        }
        self.inner.registry.insert(runtime.clone());
        let snapshot = runtime.snapshot();
        drop(state);
        self.inner.events.publish(
            "workspace/added",
            Some((id, generation)),
            serde_json::to_value(&snapshot.summary).expect("workspace summary is serializable"),
        );
        drop(lifecycle_event);
        self.activate_workspace(id, generation)
    }

    pub fn activate_workspace(
        &self,
        workspace_id: WorkspaceId,
        generation: WorkspaceGeneration,
    ) -> CoreResult<WorkspaceSnapshot> {
        let runtime = self.inner.registry.get(workspace_id, generation)?;
        let _permit = runtime.acquire_operation()?;
        let _lifecycle_event = self
            .inner
            .lifecycle_events
            .lock()
            .expect("app core lifecycle event lock poisoned");
        let state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        if self.lifecycle_state() != AppCoreLifecycleState::Running {
            return Err(CoreError::AppCoreShuttingDown);
        }
        let runtime = self.inner.registry.get(workspace_id, generation)?;
        self.inner.database.activate_workspace(workspace_id)?;
        *self
            .inner
            .active_workspace_id
            .write()
            .expect("active workspace lock poisoned") = Some(workspace_id);
        let snapshot = runtime.snapshot();
        drop(state);
        self.inner.events.publish(
            "workspace/activated",
            Some((workspace_id, generation)),
            serde_json::to_value(&snapshot).expect("workspace snapshot is serializable"),
        );
        Ok(snapshot)
    }

    pub fn deactivate_workspace(&self) -> CoreResult<()> {
        let _lifecycle_event = self
            .inner
            .lifecycle_events
            .lock()
            .expect("app core lifecycle event lock poisoned");
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        self.inner.database.deactivate_workspace()?;
        *self
            .inner
            .active_workspace_id
            .write()
            .expect("active workspace lock poisoned") = None;
        Ok(())
    }

    pub fn get_workspace_snapshot(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<WorkspaceSnapshot> {
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        let _permit = runtime.acquire_operation()?;
        Ok(runtime.snapshot())
    }

    pub async fn get_diff_target_defaults(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<DiffTargetDefaults> {
        self.run_workspace_blocking(context, |runtime| runtime.repository.diff_target_defaults())
            .await
    }

    pub async fn list_branches(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<Vec<BranchInfo>> {
        self.run_workspace_blocking(context, |runtime| runtime.repository.list_branches())
            .await
    }

    pub async fn list_changed_files(
        &self,
        context: &WorkspaceRequestContext,
        target: DiffTarget,
    ) -> CoreResult<Vec<ChangedFile>> {
        self.run_workspace_blocking(context, move |runtime| {
            runtime.repository.list_changed_files(&target)
        })
        .await
    }

    pub async fn get_diff_render_model(
        &self,
        context: &WorkspaceRequestContext,
        file_id: String,
        options: DiffRenderOptions,
        target: DiffTarget,
    ) -> CoreResult<diff::DiffRenderModel> {
        let syntax = self.inner.syntax.clone();
        self.run_workspace_blocking(context, move |runtime| {
            let path = changed_file_path(&runtime, &file_id, diff::SyntaxSide::New, &target)?;
            let mut model = diff::get_diff_render_model(
                &runtime.repository,
                &file_id,
                &path,
                options,
                &target,
            )?;
            let status = syntax
                .detect_status(Path::new(&path))
                .map_err(|error| CoreError::Syntax(error.to_string()))?;
            model.syntax = diff::SyntaxStatus {
                language: status.language,
                grammar_installed: status.grammar_installed,
                grammar_path: status.grammar_path,
                highlights_query_path: status.highlights_query_path,
                highlights_installed: status.highlights_installed,
                missing_reason: status.missing_reason,
            };
            Ok(model)
        })
        .await
    }

    pub async fn dispatch_workspace(
        &self,
        context: &WorkspaceRequestContext,
        method: &str,
        params: Option<Value>,
    ) -> CoreResult<Value> {
        match method {
            "getDiffTargetDefaults" => serialize(self.get_diff_target_defaults(context).await?),
            "listBranches" => serialize(self.list_branches(context).await?),
            "listChangedFiles" => {
                let params: TargetParams = parse_params(params)?;
                serialize(self.list_changed_files(context, params.target).await?)
            }
            "getDiffRenderModel" => {
                let params: DiffRenderParams = parse_params(params)?;
                serialize(
                    self.get_diff_render_model(
                        context,
                        params.file_id,
                        params.options,
                        params.target,
                    )
                    .await?,
                )
            }
            "getSyntaxSpans" => {
                let params: syntax::GetSyntaxSpansParams = parse_params(params)?;
                let manager = self.inner.syntax.clone();
                self.run_workspace_value(context, move |runtime| {
                    let documents = RuntimeDocuments { runtime };
                    manager
                        .get_syntax_spans(&params, &documents, None)
                        .map_err(|error| CoreError::Syntax(error.to_string()))
                })
                .await
            }
            "getLspConfigInfo" => {
                let params: lsp::GetLspConfigInfoParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .lsp
                        .get_lsp_config_info_for_repository(runtime.repository.root(), &params)
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "getLspInstallInfo" => {
                let params: lsp::GetLspInstallInfoParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .lsp
                        .get_lsp_install_info(&params)
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "installLspServer" => {
                let params: lsp::InstallLspServerParams = parse_params(params)?;
                let events = self.inner.events.clone();
                let core = self.clone();
                let workspace = (context.workspace_id, context.workspace_generation);
                self.run_workspace_value(context, move |runtime| {
                    let server_id = params.server_id.clone();
                    runtime
                        .lsp
                        .install_lsp_server(&params, None, |step| {
                            if core.workspace_is_current(workspace) {
                                events.publish(
                                    "lsp/installProgress",
                                    Some(workspace),
                                    json!({ "serverId": server_id, "step": step }),
                                );
                            }
                        })
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "restartLspServer" => {
                let params: lsp::RestartLspServerParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .lsp
                        .restart_lsp_server_for_repository(runtime.repository.root(), &params)
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "getLspStatus" => {
                let params: lsp::GetLspStatusParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    let documents = RuntimeDocuments {
                        runtime: runtime.clone(),
                    };
                    runtime
                        .lsp
                        .get_lsp_status_for_repository(
                            runtime.repository.root(),
                            &params,
                            &documents,
                        )
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "getLspHover" => {
                let params: lsp::GetLspHoverParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    let documents = RuntimeDocuments {
                        runtime: runtime.clone(),
                    };
                    runtime
                        .lsp
                        .get_lsp_hover(&params, &documents, None)
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "getLspDiagnostics" => {
                let params: lsp::GetLspDiagnosticsParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    let documents = RuntimeDocuments {
                        runtime: runtime.clone(),
                    };
                    runtime
                        .lsp
                        .get_lsp_diagnostics(&params, &documents, None)
                        .map_err(|error| CoreError::Lsp(error.to_string()))
                })
                .await
            }
            "getReviewConfig" => {
                self.run_workspace_value(context, |runtime| {
                    runtime.reviews.get_config().map_err(CoreError::from)
                })
                .await
            }
            "saveReviewConfig" => {
                let params: ReviewConfigParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime.reviews.save_config(params.config)
                })
                .await
            }
            "getActiveReviewSession" => {
                self.run_workspace_value(context, |runtime| {
                    runtime
                        .reviews
                        .get_active_session()
                        .map_err(CoreError::from)
                })
                .await
            }
            "listReviewSessions" => {
                self.run_workspace_value(context, |runtime| {
                    runtime.reviews.list_sessions().map_err(CoreError::from)
                })
                .await
            }
            "createReviewSession" => {
                let params: CreateSessionParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime.reviews.create_session(params.session)
                })
                .await
            }
            "getReviewProgress" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_progress(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "saveReviewProgress" => {
                let params: ProgressParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .save_progress(&params.session_id, params.progress)
                })
                .await
            }
            "getReviewedFiles" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_reviewed_files(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "saveReviewedFiles" => {
                let params: ReviewedFilesParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .save_reviewed_files(&params.session_id, params.reviewed_files)
                })
                .await
            }
            "updateReviewedFiles" => {
                let params: ReviewedFilesUpdateParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .update_reviewed_files(&params.session_id, params.update)
                })
                .await
            }
            "getReviewAgentStates" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_agent_states(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "saveReviewAgentState" => {
                let params: AgentParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .save_agent_state(&params.session_id, params.agent)
                })
                .await
            }
            "getReviewRuns" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_runs(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "recoverStaleReviewRuns" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime.reviews.recover_stale_runs(&params.session_id)
                })
                .await
            }
            "saveReviewRun" | "createReviewRun" | "updateReviewRun" | "finishReviewRun" => {
                let params: RunParams = parse_params(params)?;
                let method = method.to_owned();
                self.run_review_operation(context, move |runtime| match method.as_str() {
                    "saveReviewRun" => runtime.reviews.save_run(&params.session_id, params.run),
                    "createReviewRun" => runtime.reviews.create_run(&params.session_id, params.run),
                    "updateReviewRun" => runtime.reviews.update_run(&params.session_id, params.run),
                    _ => runtime.reviews.finish_run(&params.session_id, params.run),
                })
                .await
            }
            "getReviewThreads" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_threads(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "getReviewChatMessages" => {
                let params: SessionIdParams = parse_params(params)?;
                self.run_workspace_value(context, move |runtime| {
                    runtime
                        .reviews
                        .get_chat_messages(&params.session_id)
                        .map_err(CoreError::from)
                })
                .await
            }
            "saveReviewChatMessage" => {
                let params: ChatMessageParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .save_chat_message(&params.session_id, params.message)
                })
                .await
            }
            "addReviewCommentPayload" => {
                let params: CommentPayloadParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime.reviews.add_comment_payload(
                        &params.session_id,
                        &params.run_id,
                        params.comment,
                    )
                })
                .await
            }
            "addReviewComment" => {
                let params: CommentParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .add_comment(&params.session_id, params.comment)
                })
                .await
            }
            "saveReviewThread" => {
                let params: ThreadParams = parse_params(params)?;
                self.run_review_operation(context, move |runtime| {
                    runtime
                        .reviews
                        .save_thread(&params.session_id, params.thread)
                })
                .await
            }
            "listTreeSitterGrammars" => {
                let params: syntax::ListTreeSitterGrammarsParams = parse_params(params)?;
                let manager = self.inner.syntax.clone();
                self.run_workspace_value(context, move |_| {
                    manager
                        .list_tree_sitter_grammars(&params)
                        .map_err(|error| CoreError::Syntax(error.to_string()))
                })
                .await
            }
            "syncTreeSitterRegistry" => {
                let params: syntax::SyncTreeSitterRegistryParams = parse_params(params)?;
                let manager = self.inner.syntax.clone();
                self.run_workspace_value(context, move |_| {
                    manager
                        .sync_tree_sitter_registry(&params, None)
                        .map_err(|error| CoreError::Syntax(error.to_string()))
                })
                .await
            }
            "installTreeSitterGrammar" => {
                let params: syntax::InstallTreeSitterGrammarParams = parse_params(params)?;
                let manager = self.inner.syntax.clone();
                let events = self.inner.events.clone();
                let core = self.clone();
                let workspace = (context.workspace_id, context.workspace_generation);
                self.run_workspace_value(context, move |_| {
                    let language = params.language.clone();
                    manager
                        .install_tree_sitter_grammar(&params, None, |step| {
                            if core.workspace_is_current(workspace) {
                                events.publish(
                                    "treeSitter/installProgress",
                                    Some(workspace),
                                    json!({ "language": language, "step": step }),
                                );
                            }
                        })
                        .map_err(|error| CoreError::Syntax(error.to_string()))
                })
                .await
            }
            "uninstallTreeSitterGrammar" => {
                let params: syntax::UninstallTreeSitterGrammarParams = parse_params(params)?;
                let manager = self.inner.syntax.clone();
                self.run_workspace_value(context, move |_| {
                    manager
                        .uninstall_tree_sitter_grammar(&params)
                        .map_err(|error| CoreError::Syntax(error.to_string()))
                })
                .await
            }
            "startSearch" => {
                let params: SearchParams = parse_params(params)?;
                self.start_search(context, params).await
            }
            "cancelSearch" => {
                let params: CancelSearchParams = parse_params(params)?;
                self.cancel_search(context, &params.search_id)
            }
            _ => Err(CoreError::MethodNotFound),
        }
    }

    fn cancel_search(
        &self,
        context: &WorkspaceRequestContext,
        search_id: &str,
    ) -> CoreResult<Value> {
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        let _permit = runtime.acquire_operation()?;
        let cancelled = runtime.search.cancel(search_id);
        Ok(json!({ "cancelled": cancelled }))
    }

    async fn start_search(
        &self,
        context: &WorkspaceRequestContext,
        params: SearchParams,
    ) -> CoreResult<Value> {
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        let permit = runtime.acquire_operation()?;
        let search_id = params
            .search_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let coordinator = runtime.search.clone();
        let reservation = coordinator
            .reserve(&search_id)
            .map_err(|error| CoreError::Search(error.to_string()))?;

        let request = SearchRequest {
            search_id: search_id.clone(),
            session_id: params.session_id,
            query: params.query,
            mode: params.mode,
            filters: params.filters,
        };
        let source = RepositorySearchSource {
            runtime: runtime.clone(),
            target: params.target,
        };
        let core = self.clone();
        let search_context = context.clone();
        let sink = Arc::new(SearchEventForwarder {
            core,
            context: search_context,
        });
        tokio::task::spawn_blocking(move || {
            let _ = coordinator.run_reserved(request, reservation, &source, sink.as_ref());
            drop(permit);
        });
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        self.inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        Ok(json!({ "searchId": search_id }))
    }

    async fn run_workspace_value<T, F>(
        &self,
        context: &WorkspaceRequestContext,
        operation: F,
    ) -> CoreResult<Value>
    where
        T: Serialize + Send + 'static,
        F: FnOnce(Arc<WorkspaceRuntime>) -> CoreResult<T> + Send + 'static,
    {
        serialize(self.run_workspace_blocking(context, operation).await?)
    }

    async fn run_review_operation<T, F>(
        &self,
        context: &WorkspaceRequestContext,
        operation: F,
    ) -> CoreResult<Value>
    where
        T: Serialize + Send + 'static,
        F: FnOnce(Arc<WorkspaceRuntime>) -> crate::review::ReviewResult<ReviewOperation<T>>
            + Send
            + 'static,
    {
        let operation = self
            .run_workspace_blocking(context, move |runtime| {
                operation(runtime).map_err(CoreError::from)
            })
            .await?;
        let (result, event) = operation.into_parts();
        if let Some(event) = event {
            let runtime = self
                .inner
                .registry
                .get(context.workspace_id, context.workspace_generation);
            if let Ok(runtime) = runtime {
                if let Ok(_permit) = runtime.acquire_operation() {
                    self.inner.events.publish(
                        "review/changed",
                        Some((context.workspace_id, context.workspace_generation)),
                        serde_json::to_value(event)
                            .map_err(|error| CoreError::Serialization(error.to_string()))?,
                    );
                }
            }
        }
        serialize(result)
    }

    async fn run_workspace_blocking<T, F>(
        &self,
        context: &WorkspaceRequestContext,
        operation: F,
    ) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(Arc<WorkspaceRuntime>) -> CoreResult<T> + Send + 'static,
    {
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        let permit = runtime.acquire_operation()?;
        tokio::task::spawn_blocking(move || {
            let result = operation(runtime);
            drop(permit);
            result
        })
        .await
        .map_err(|error| CoreError::TaskFailed(error.to_string()))?
    }

    fn workspace_is_current(&self, workspace: (WorkspaceId, WorkspaceGeneration)) -> bool {
        self.inner.registry.get(workspace.0, workspace.1).is_ok()
    }

    pub fn close_workspace(&self, context: &WorkspaceRequestContext) -> CoreResult<()> {
        let state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        runtime.begin_close()?;
        drop(state);

        self.finish_workspace_close(runtime, context, true)
    }

    fn finish_workspace_close(
        &self,
        runtime: Arc<WorkspaceRuntime>,
        context: &WorkspaceRequestContext,
        restore_on_failure: bool,
    ) -> CoreResult<()> {
        let _close = runtime.acquire_close_gate();
        if self
            .inner
            .registry
            .by_id(context.workspace_id)
            .is_none_or(|current| current.generation != context.workspace_generation)
        {
            return Ok(());
        }

        runtime.search.cancel_all();
        runtime.wait_until_idle();
        runtime.search.wait_for_all();

        if let Err(error) = runtime.lsp.shutdown_repository(runtime.repository.root()) {
            self.restore_workspace_after_close_failure(&runtime, restore_on_failure);
            return Err(CoreError::Lsp(error.to_string()));
        }
        if let Err(error) = self.inner.database.close_workspace(context.workspace_id) {
            self.restore_workspace_after_close_failure(&runtime, restore_on_failure);
            return Err(error);
        }

        let _lifecycle_event = self
            .inner
            .lifecycle_events
            .lock()
            .expect("app core lifecycle event lock poisoned");
        let state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
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
        drop(state);
        runtime.stop_watcher();
        self.inner.events.publish(
            "workspace/removed",
            Some((context.workspace_id, context.workspace_generation)),
            serde_json::to_value(runtime.summary()).expect("workspace summary is serializable"),
        );
        Ok(())
    }
    fn restore_workspace_after_close_failure(
        &self,
        runtime: &WorkspaceRuntime,
        restore_on_failure: bool,
    ) {
        if restore_on_failure && self.lifecycle_state() == AppCoreLifecycleState::Running {
            runtime.restore_ready();
        }
    }

    pub fn begin_shutdown(&self) {
        let _state = self
            .inner
            .state_gate
            .lock()
            .expect("app core state lock poisoned");
        let mut lifecycle = self
            .inner
            .lifecycle_state
            .write()
            .expect("app core lifecycle lock poisoned");
        if *lifecycle == AppCoreLifecycleState::Stopped {
            return;
        }
        *lifecycle = AppCoreLifecycleState::ShuttingDown;
        let runtimes = self.inner.registry.runtimes();
        for runtime in &runtimes {
            let _ = runtime.begin_close();
            runtime.search.cancel_all();
        }
        if runtimes.is_empty() {
            *lifecycle = AppCoreLifecycleState::Stopped;
        }
    }

    pub fn shutdown(&self) -> CoreResult<()> {
        let _shutdown = self
            .inner
            .shutdown_gate
            .lock()
            .expect("app core shutdown lock poisoned");
        self.begin_shutdown();
        let runtimes = self.inner.registry.runtimes();
        let mut failures = Vec::new();
        for runtime in runtimes {
            let context = WorkspaceRequestContext {
                workspace_id: runtime.id,
                workspace_generation: runtime.generation,
                request_id: "shutdown".to_owned(),
            };
            if let Err(error) = self.finish_workspace_close(runtime, &context, false) {
                failures.push(error.to_string());
            }
        }
        if self.inner.registry.is_empty() {
            *self
                .inner
                .lifecycle_state
                .write()
                .expect("app core lifecycle lock poisoned") = AppCoreLifecycleState::Stopped;
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(CoreError::TaskFailed(failures.join("; ")))
        }
    }

    pub fn is_workspace_watcher_running(
        &self,
        context: &WorkspaceRequestContext,
    ) -> CoreResult<bool> {
        let runtime = self
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)?;
        let _permit = runtime.acquire_operation()?;
        Ok(runtime.watcher_running())
    }
}

struct RuntimeDocuments {
    runtime: Arc<WorkspaceRuntime>,
}

impl DocumentProvider for RuntimeDocuments {
    fn resolve_document(
        &self,
        file_id: &str,
        side: lsp::SyntaxSide,
        target: &lsp::DiffTarget,
    ) -> lsp::LspResult<SourceDocument> {
        let target = repository_target_from_lsp(target);
        let side = match side {
            lsp::SyntaxSide::Old => diff::SyntaxSide::Old,
            lsp::SyntaxSide::New => diff::SyntaxSide::New,
        };
        let path = changed_file_path(&self.runtime, file_id, side, &target)
            .map_err(|_| lsp::LspError::InvalidSourcePath)?;
        let source = diff::source_for_side(&self.runtime.repository, &path, side, &target)
            .map_err(|error| lsp::LspError::Server(error.to_string()))?;
        Ok(SourceDocument {
            repository_root: self.runtime.repository.root().to_owned(),
            path: PathBuf::from(path),
            source,
        })
    }
}

impl SyntaxDocumentProvider for RuntimeDocuments {
    fn resolve_syntax_document(
        &self,
        params: &syntax::GetSyntaxSpansParams,
    ) -> syntax::SyntaxResult<SyntaxSourceDocument> {
        let target = repository_target_from_syntax(&params.target);
        let side = match params.side {
            syntax::SyntaxSide::Old => diff::SyntaxSide::Old,
            syntax::SyntaxSide::New => diff::SyntaxSide::New,
        };
        let path = changed_file_path(&self.runtime, &params.file_id, side, &target)
            .map_err(|_| syntax::SyntaxError::UnsafePath(params.file_id.clone()))?;
        let source = diff::source_for_side(&self.runtime.repository, &path, side, &target)
            .map_err(|error| syntax::SyntaxError::ParserFailed(error.to_string()))?;
        Ok(SyntaxSourceDocument {
            path: PathBuf::from(path),
            source,
        })
    }
}

struct RepositorySearchSource {
    runtime: Arc<WorkspaceRuntime>,
    target: DiffTarget,
}

impl ChangedFilesProvider for RepositorySearchSource {
    fn changed_files(&self) -> Result<Vec<search::ChangedFile>, SearchError> {
        self.runtime
            .repository
            .list_changed_files(&self.target)
            .map(|files| files.into_iter().map(search_file).collect())
            .map_err(SearchError::provider)
    }
}

impl SourceTextProvider for RepositorySearchSource {
    fn source_text(
        &self,
        file: &search::ChangedFile,
        side: search::SyntaxSide,
    ) -> Result<Option<Vec<u8>>, SearchError> {
        let path = file.source_path(side);
        validate_relative_path(path).map_err(SearchError::provider)?;
        let side = match side {
            search::SyntaxSide::Old => diff::SyntaxSide::Old,
            search::SyntaxSide::New => diff::SyntaxSide::New,
        };
        diff::source_for_side(&self.runtime.repository, path, side, &self.target)
            .map(|source| Some(source.into_bytes()))
            .map_err(SearchError::provider)
    }
}

impl ReviewCommentsProvider for RepositorySearchSource {
    fn review_snapshot(&self, session_id: &str) -> Result<search::ReviewSnapshot, SearchError> {
        let reviewed = self
            .runtime
            .reviews
            .get_reviewed_files(session_id)
            .map_err(search_review_error)?;
        let threads = self
            .runtime
            .reviews
            .get_threads(session_id)
            .map_err(search_review_error)?;
        let comments = threads
            .into_iter()
            .map(|thread| {
                let anchor = serde_json::to_value(&thread.anchor).map_err(SearchError::provider)?;
                let thread_value = serde_json::to_value(&thread).map_err(SearchError::provider)?;
                Ok(search::ReviewComment {
                    id: thread.id.clone(),
                    file_id: thread.file_id.clone(),
                    status: match thread.status {
                        crate::review::ReviewThreadStatus::Open => {
                            search::ReviewCommentStatus::Open
                        }
                        crate::review::ReviewThreadStatus::Resolved => {
                            search::ReviewCommentStatus::Resolved
                        }
                    },
                    anchor,
                    body: thread
                        .messages
                        .iter()
                        .map(|message| message.body.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    thread: thread_value,
                })
            })
            .collect::<Result<Vec<_>, SearchError>>()?;
        Ok(search::ReviewSnapshot {
            reviewed_file_ids: reviewed.files.into_keys().collect(),
            comments,
        })
    }
}

fn search_review_error(error: ReviewError) -> SearchError {
    match error {
        ReviewError::Json(_) => SearchError::Protocol("SyntaxError".to_owned()),
        error => SearchError::provider(error),
    }
}

struct SearchEventForwarder {
    core: AppCore,
    context: WorkspaceRequestContext,
}

impl SearchEventForwarder {
    fn workspace_is_current(&self) -> bool {
        self.core
            .workspace_is_current((self.context.workspace_id, self.context.workspace_generation))
    }
}

impl SearchEventSink for SearchEventForwarder {
    fn send(&self, event: SearchEvent) -> Result<(), SearchError> {
        if !self.workspace_is_current() {
            return Err(SearchError::provider(CoreError::StaleWorkspaceGeneration));
        }
        let (kind, payload) = match event {
            SearchEvent::Started(payload) => ("search/started", serialize_search(payload)?),
            SearchEvent::Results(payload) => ("search/results", serialize_search(payload)?),
            SearchEvent::Progress(payload) => ("search/progress", serialize_search(payload)?),
            SearchEvent::Done(payload) => ("search/done", serialize_search(payload)?),
            SearchEvent::Cancelled(payload) => ("search/cancelled", serialize_search(payload)?),
            SearchEvent::Error(payload) => ("search/error", serialize_search(payload)?),
        };
        self.core.inner.events.publish(
            kind,
            Some((self.context.workspace_id, self.context.workspace_generation)),
            payload,
        );
        Ok(())
    }
}

fn parse_params<T: DeserializeOwned>(params: Option<Value>) -> CoreResult<T> {
    serde_json::from_value(params.unwrap_or_else(|| json!({})))
        .map_err(|error| CoreError::InvalidParams(error.to_string()))
}

fn serialize<T: Serialize>(value: T) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Serialization(error.to_string()))
}

fn serialize_search<T: Serialize>(value: T) -> Result<Value, SearchError> {
    serde_json::to_value(value).map_err(SearchError::provider)
}

fn changed_file_path(
    runtime: &WorkspaceRuntime,
    file_id: &str,
    side: diff::SyntaxSide,
    target: &DiffTarget,
) -> CoreResult<String> {
    validate_relative_path(file_id)?;
    let file = runtime
        .repository
        .list_changed_files(target)?
        .into_iter()
        .find(|file| file.id == file_id)
        .ok_or(CoreError::WorkspaceFileNotFound)?;
    let path = match side {
        diff::SyntaxSide::Old => file.old_path.as_deref().unwrap_or(&file.id),
        diff::SyntaxSide::New => file.new_path.as_deref().unwrap_or(&file.id),
    };
    validate_relative_path(path)?;
    Ok(path.to_owned())
}

fn validate_relative_path(path: &str) -> CoreResult<()> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(CoreError::WorkspaceFileNotFound);
    }
    Ok(())
}

fn repository_target_from_lsp(target: &lsp::DiffTarget) -> DiffTarget {
    DiffTarget {
        base: target.base.clone(),
        compare: target.compare.clone(),
        include_staged: target.include_staged,
        include_unstaged: target.include_unstaged,
    }
}

fn repository_target_from_syntax(target: &syntax::DiffTarget) -> DiffTarget {
    DiffTarget {
        base: target.base.clone(),
        compare: target.compare.clone(),
        include_staged: target.include_staged,
        include_unstaged: target.include_unstaged,
    }
}

fn search_file(file: ChangedFile) -> search::ChangedFile {
    search::ChangedFile {
        id: file.id,
        old_path: file.old_path,
        new_path: file.new_path,
        status: match file.status {
            FileStatus::Added => search::ChangedFileStatus::Added,
            FileStatus::Modified => search::ChangedFileStatus::Modified,
            FileStatus::Deleted => search::ChangedFileStatus::Deleted,
            FileStatus::Renamed => search::ChangedFileStatus::Renamed,
        },
        additions: file.additions,
        deletions: file.deletions,
        signature: file.signature,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use std::sync::{Barrier, Condvar, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use super::*;

    fn git_ok(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Diffuse Test")
            .env("GIT_AUTHOR_EMAIL", "diffuse@example.test")
            .env("GIT_COMMITTER_NAME", "Diffuse Test")
            .env("GIT_COMMITTER_EMAIL", "diffuse@example.test")
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn repository() -> TempDir {
        let temp = TempDir::new().expect("temporary repository");
        git_ok(temp.path(), &["init", "--initial-branch=main"]);
        fs::write(temp.path().join("README.md"), "fixture\n").unwrap();
        git_ok(temp.path(), &["add", "."]);
        git_ok(temp.path(), &["commit", "-m", "initial"]);
        temp
    }

    fn context(snapshot: &WorkspaceSnapshot, request_id: &str) -> WorkspaceRequestContext {
        WorkspaceRequestContext {
            workspace_id: snapshot.summary.workspace_id,
            workspace_generation: snapshot.summary.workspace_generation,
            request_id: request_id.to_owned(),
        }
    }

    struct GatedSearchSource {
        entered: mpsc::Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl ChangedFilesProvider for GatedSearchSource {
        fn changed_files(&self) -> Result<Vec<search::ChangedFile>, SearchError> {
            Ok(vec![search::ChangedFile {
                id: "README.md".to_owned(),
                old_path: None,
                new_path: Some("README.md".to_owned()),
                status: search::ChangedFileStatus::Modified,
                additions: 1,
                deletions: 0,
                signature: "fixture".to_owned(),
            }])
        }
    }

    impl SourceTextProvider for GatedSearchSource {
        fn source_text(
            &self,
            _file: &search::ChangedFile,
            _side: search::SyntaxSide,
        ) -> Result<Option<Vec<u8>>, SearchError> {
            self.entered.send(()).expect("report blocked search");
            let (released, wake) = &*self.release;
            let mut released = released.lock().expect("search gate lock poisoned");
            while !*released {
                released = wake.wait(released).expect("search gate lock poisoned");
            }
            Ok(Some(b"shared search\n".to_vec()))
        }
    }

    impl ReviewCommentsProvider for GatedSearchSource {
        fn review_snapshot(
            &self,
            _session_id: &str,
        ) -> Result<search::ReviewSnapshot, SearchError> {
            Ok(search::ReviewSnapshot::default())
        }
    }

    fn start_gated_search(
        core: &AppCore,
        context: &WorkspaceRequestContext,
        source: GatedSearchSource,
    ) -> thread::JoinHandle<Result<search::SearchStats, SearchError>> {
        let runtime = core
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)
            .expect("workspace runtime");
        let permit = runtime.acquire_operation().expect("workspace operation");
        let coordinator = runtime.search.clone();
        let reservation = coordinator.reserve("shared-id").expect("reserve search");
        let request = SearchRequest {
            search_id: "shared-id".to_owned(),
            session_id: String::new(),
            query: "shared".to_owned(),
            mode: SearchMode::Content,
            filters: Vec::new(),
        };
        let sink = SearchEventForwarder {
            core: core.clone(),
            context: context.clone(),
        };
        thread::spawn(move || {
            let result = coordinator.run_reserved(request, reservation, &source, &sink);
            drop(permit);
            result
        })
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
    async fn workbench_snapshot_and_activation_event_include_the_active_workspace() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let before = core.events().current_sequence();
        let opened = core.open_workspace(repository.path()).await.unwrap();

        let snapshot = core.workbench_snapshot();
        assert_eq!(
            snapshot.active_workspace_id,
            Some(opened.summary.workspace_id)
        );
        assert_eq!(snapshot.active_workspace, Some(opened.clone()));
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(
            value["activeWorkspaceId"],
            opened.summary.workspace_id.to_string()
        );
        assert_eq!(
            value["activeWorkspace"]["summary"]["workspaceGeneration"],
            opened.summary.workspace_generation.to_string()
        );

        let activated = core
            .events()
            .replay_after(before)
            .events
            .into_iter()
            .find(|event| event.kind == "workspace/activated")
            .expect("workspace activation event");
        assert_eq!(
            activated.payload,
            serde_json::to_value(&opened).expect("serialize workspace snapshot")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lifecycle_event_backpressure_does_not_hold_the_state_gate() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let (_, subscription) = core.events().subscribe(1);
        let open_core = core.clone();
        let root = repository.path().to_owned();
        let open = tokio::spawn(async move { open_core.open_workspace(root).await });
        let deadline = Instant::now() + Duration::from_secs(2);
        while core.events().current_sequence() < 2 {
            assert!(Instant::now() < deadline, "activation event did not block");
            tokio::task::yield_now().await;
        }
        let snapshot_core = core.clone();
        let (snapshot_ready, snapshot) = mpsc::channel();
        let snapshot_worker = thread::spawn(move || {
            snapshot_ready
                .send(snapshot_core.workbench_snapshot())
                .unwrap();
        });
        let during_backpressure = snapshot
            .recv_timeout(Duration::from_millis(100))
            .expect("state gate remained available during event backpressure");
        assert_eq!(during_backpressure.workspaces.len(), 1);

        let added = subscription.recv_timeout(Duration::from_secs(1)).unwrap();
        let activated = subscription.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(added.kind, "workspace/added");
        assert_eq!(activated.kind, "workspace/activated");
        open.await.unwrap().unwrap();
        snapshot_worker.join().unwrap();
        subscription.close();
        loop {
            match subscription.recv_timeout(Duration::from_millis(100)) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("closed lifecycle event subscription did not disconnect")
                }
            }
        }
        core.shutdown().unwrap();
    }

    #[tokio::test]
    async fn deactivation_clears_the_active_workspace_without_closing_it() {
        let repository = repository();
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let core = AppCore::new(database.clone());
        let opened = core.open_workspace(repository.path()).await.unwrap();

        core.deactivate_workspace().unwrap();

        let snapshot = core.workbench_snapshot();
        assert_eq!(snapshot.active_workspace_id, None);
        assert_eq!(snapshot.active_workspace, None);
        assert_eq!(snapshot.workspaces.len(), 1);
        assert_eq!(database.active_workspace_id().unwrap(), None);
        core.get_workspace_snapshot(&context(&opened, "still-open"))
            .unwrap();
    }

    #[test]
    fn app_core_accepts_explicit_syntax_options() {
        let core = AppCore::with_options(
            WorkbenchDatabase::open_in_memory().unwrap(),
            AppCoreOptions {
                syntax: SyntaxManagerOptions::from_environment_with_parser_backend(
                    syntax::ParserBackend::Unavailable,
                ),
            },
        )
        .unwrap();

        assert_eq!(core.lifecycle_state(), AppCoreLifecycleState::Running);
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

    #[tokio::test]
    async fn dispatches_changed_files_diff_and_review_contracts() {
        let repository = repository();
        fs::write(repository.path().join("README.md"), "changed fixture\n").unwrap();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "dispatch");
        let target = json!({
            "base": "HEAD",
            "includeStaged": true,
            "includeUnstaged": true
        });

        let files = core
            .dispatch_workspace(
                &context,
                "listChangedFiles",
                Some(json!({ "target": target.clone() })),
            )
            .await
            .unwrap();
        assert_eq!(files[0]["id"], "README.md");
        assert_eq!(files[0]["status"], "modified");

        let model = core
            .dispatch_workspace(
                &context,
                "getDiffRenderModel",
                Some(json!({
                    "fileId": "README.md",
                    "options": { "mode": "inline", "context": "diff" },
                    "target": target
                })),
            )
            .await
            .unwrap();
        assert_eq!(model["fileId"], "README.md");
        assert_eq!(model["mode"], "inline");
        assert!(
            model["rows"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );

        let before = core.events().current_sequence();
        let session = json!({
            "id": "session-1",
            "repositoryRoot": snapshot.repository.root,
            "target": {
                "base": "HEAD",
                "includeStaged": true,
                "includeUnstaged": true
            },
            "headAtCreation": snapshot.repository.head,
            "createdAt": "100",
            "updatedAt": "100",
            "status": "active",
            "participants": []
        });
        let created = core
            .dispatch_workspace(
                &context,
                "createReviewSession",
                Some(json!({ "session": session })),
            )
            .await
            .unwrap();
        assert_eq!(created["id"], "session-1");
        let active = core
            .dispatch_workspace(&context, "getActiveReviewSession", None)
            .await
            .unwrap();
        assert_eq!(active["id"], "session-1");
        assert!(
            core.events()
                .replay_after(before)
                .events
                .iter()
                .any(|event| {
                    event.kind == "review/changed"
                        && event.workspace_id == Some(context.workspace_id)
                        && event.payload["change"] == "session.created"
                })
        );
        assert!(matches!(
            core.dispatch_workspace(&context, "notAContractMethod", None)
                .await,
            Err(CoreError::MethodNotFound)
        ));
    }

    #[tokio::test]
    async fn dispatch_search_can_be_cancelled_and_emits_workspace_events() {
        let repository = repository();
        for index in 0..40 {
            fs::write(
                repository.path().join(format!("fixture-{index}.txt")),
                format!("search fixture {index}\n"),
            )
            .unwrap();
        }
        git_ok(repository.path(), &["add", "."]);
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "search");
        let before = core.events().current_sequence();
        let started = core
            .dispatch_workspace(
                &context,
                "startSearch",
                Some(json!({
                    "searchId": "cancel-me",
                    "sessionId": "",
                    "query": "fixture",
                    "mode": "content",
                    "filters": [],
                    "target": {
                        "base": "HEAD",
                        "includeStaged": true,
                        "includeUnstaged": true
                    }
                })),
            )
            .await
            .unwrap();
        assert_eq!(started, json!({ "searchId": "cancel-me" }));
        let cancelled = core
            .dispatch_workspace(
                &context,
                "cancelSearch",
                Some(json!({ "searchId": "cancel-me" })),
            )
            .await
            .unwrap();
        assert_eq!(cancelled, json!({ "cancelled": true }));

        for _ in 0..100 {
            if core
                .events()
                .replay_after(before)
                .events
                .iter()
                .any(|event| {
                    event.kind == "search/cancelled"
                        && event.workspace_id == Some(context.workspace_id)
                })
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("search/cancelled event was not published");
    }

    #[tokio::test]
    async fn watcher_starts_for_workspace_and_stops_on_close() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "watcher");
        assert!(core.is_workspace_watcher_running(&context).unwrap());

        let before_change = core.events().current_sequence();
        fs::write(repository.path().join("README.md"), "watcher change\n").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert!(
            core.events()
                .replay_after(before_change)
                .events
                .iter()
                .any(|event| event.kind == "repository/changed"
                    && event.workspace_id == Some(context.workspace_id))
        );

        core.close_workspace(&context).unwrap();
        let after_close = core.events().current_sequence();
        fs::write(repository.path().join("README.md"), "after close\n").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        assert!(
            core.events()
                .replay_after(after_close)
                .events
                .iter()
                .all(|event| event.workspace_id != Some(context.workspace_id))
        );
    }

    #[tokio::test]
    async fn close_waits_for_active_durable_work() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "close-barrier");
        let runtime = core
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)
            .unwrap();
        let permit = runtime.acquire_operation().unwrap();
        let durable_path = repository.path().join("durable-write.txt");
        let worker_path = durable_path.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            fs::write(worker_path, "completed before close\n").unwrap();
            drop(permit);
        });

        let started = Instant::now();
        core.close_workspace(&context).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(50));
        worker.join().unwrap();
        assert_eq!(
            fs::read_to_string(&durable_path).unwrap(),
            "completed before close\n"
        );
        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(
            fs::read_to_string(durable_path).unwrap(),
            "completed before close\n"
        );
    }

    #[tokio::test]
    async fn admitted_durable_operation_succeeds_while_close_waits_and_rejects_new_work() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "completion-race");
        let runtime = core
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)
            .unwrap();
        let release_gate = Arc::new(Barrier::new(2));
        let (entered, operation_entered) = tokio::sync::oneshot::channel();
        let worker_core = core.clone();
        let worker_context = context.clone();
        let worker_release_gate = release_gate.clone();
        let durable_path = repository.path().join("admitted-durable-write.txt");
        let worker_durable_path = durable_path.clone();
        let operation = tokio::spawn(async move {
            worker_core
                .run_workspace_blocking(&worker_context, move |_| {
                    entered.send(()).expect("report operation started");
                    worker_release_gate.wait();
                    fs::write(worker_durable_path, "committed\n")?;
                    Ok("saved")
                })
                .await
        });
        operation_entered.await.unwrap();

        let (closed, close_completed) = mpsc::channel();
        let close_core = core.clone();
        let close_context = context.clone();
        let close_worker = thread::spawn(move || {
            closed
                .send(close_core.close_workspace(&close_context))
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while runtime.acquire_operation().is_ok() {
            assert!(Instant::now() < deadline, "close did not begin");
            thread::sleep(Duration::from_millis(1));
        }
        assert!(matches!(
            core.get_workspace_snapshot(&context),
            Err(CoreError::WorkspaceClosing)
        ));
        assert!(matches!(
            close_completed.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        release_gate.wait();

        assert_eq!(operation.await.unwrap().unwrap(), "saved");
        assert_eq!(fs::read_to_string(durable_path).unwrap(), "committed\n");
        close_completed
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        close_worker.join().unwrap();
    }

    #[tokio::test]
    async fn cancelling_same_search_id_is_isolated_and_stale_work_is_rejected_after_reopen() {
        let first_repository = repository();
        let second_repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let first = core.open_workspace(first_repository.path()).await.unwrap();
        let second = core.open_workspace(second_repository.path()).await.unwrap();
        let first_context = context(&first, "first-search");
        let second_context = context(&second, "second-search");
        let first_runtime = core
            .inner
            .registry
            .get(
                first_context.workspace_id,
                first_context.workspace_generation,
            )
            .unwrap();
        let second_runtime = core
            .inner
            .registry
            .get(
                second_context.workspace_id,
                second_context.workspace_generation,
            )
            .unwrap();
        assert!(!Arc::ptr_eq(&first_runtime.search, &second_runtime.search));
        assert!(!Arc::ptr_eq(&first_runtime.lsp, &second_runtime.lsp));

        let before = core.events().current_sequence();
        let (entered, blocked) = mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let first_worker = start_gated_search(
            &core,
            &first_context,
            GatedSearchSource {
                entered: entered.clone(),
                release: release.clone(),
            },
        );
        let second_worker = start_gated_search(
            &core,
            &second_context,
            GatedSearchSource {
                entered,
                release: release.clone(),
            },
        );
        blocked.recv_timeout(Duration::from_secs(2)).unwrap();
        blocked.recv_timeout(Duration::from_secs(2)).unwrap();

        let cancelled = core
            .dispatch_workspace(
                &first_context,
                "cancelSearch",
                Some(json!({ "searchId": "shared-id" })),
            )
            .await
            .unwrap();
        assert_eq!(cancelled, json!({ "cancelled": true }));
        assert!(second_runtime.search.is_active("shared-id"));

        *release.0.lock().expect("search gate lock poisoned") = true;
        release.1.notify_all();
        first_worker.join().unwrap().unwrap();
        second_worker.join().unwrap().unwrap();

        let events = core.events().replay_after(before).events;
        assert!(events.iter().any(|event| {
            event.kind == "search/cancelled"
                && event.workspace_id == Some(first_context.workspace_id)
                && event.workspace_generation == Some(first_context.workspace_generation)
        }));
        assert!(events.iter().any(|event| {
            event.kind == "search/done"
                && event.workspace_id == Some(second_context.workspace_id)
                && event.workspace_generation == Some(second_context.workspace_generation)
        }));
        assert!(events.iter().all(|event| {
            event.kind != "search/cancelled"
                || event.workspace_id != Some(second_context.workspace_id)
        }));

        let stale_forwarder = SearchEventForwarder {
            core: core.clone(),
            context: first_context.clone(),
        };
        core.close_workspace(&first_context).unwrap();
        let reopened = core.open_workspace(first_repository.path()).await.unwrap();
        assert_eq!(first.summary.workspace_id, reopened.summary.workspace_id);
        assert_ne!(
            first.summary.workspace_generation,
            reopened.summary.workspace_generation
        );
        let after_reopen = core.events().current_sequence();
        assert!(matches!(
            stale_forwarder.send(SearchEvent::Started(search::SearchStarted {
                search_id: "shared-id".to_owned(),
            })),
            Err(SearchError::Provider(_))
        ));
        assert!(
            core.events()
                .replay_after(after_reopen)
                .events
                .iter()
                .all(|event| event.kind != "search/started"
                    || event.workspace_generation != Some(first_context.workspace_generation))
        );

        core.shutdown().unwrap();
    }

    #[tokio::test]
    async fn shutdown_closes_every_runtime() {
        let first_repository = repository();
        let second_repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let first = core.open_workspace(first_repository.path()).await.unwrap();
        let second = core.open_workspace(second_repository.path()).await.unwrap();

        core.shutdown().unwrap();

        assert!(core.workbench_snapshot().workspaces.is_empty());
        assert!(matches!(
            core.get_workspace_snapshot(&context(&first, "closed-first")),
            Err(CoreError::WorkspaceNotFound)
        ));
        assert!(matches!(
            core.get_workspace_snapshot(&context(&second, "closed-second")),
            Err(CoreError::WorkspaceNotFound)
        ));
        assert_eq!(core.lifecycle_state(), AppCoreLifecycleState::Stopped);
    }

    #[tokio::test]
    async fn begin_shutdown_rejects_new_work_without_waiting_for_operations() {
        let repository = repository();
        let core = AppCore::new(WorkbenchDatabase::open_in_memory().unwrap());
        let snapshot = core.open_workspace(repository.path()).await.unwrap();
        let context = context(&snapshot, "shutdown-started");
        let runtime = core
            .inner
            .registry
            .get(context.workspace_id, context.workspace_generation)
            .unwrap();
        let permit = runtime.acquire_operation().unwrap();

        core.begin_shutdown();

        assert_eq!(core.lifecycle_state(), AppCoreLifecycleState::ShuttingDown);
        assert!(matches!(
            core.get_workspace_snapshot(&context),
            Err(CoreError::WorkspaceClosing)
        ));
        drop(permit);
        core.shutdown().unwrap();
        assert_eq!(core.lifecycle_state(), AppCoreLifecycleState::Stopped);
    }

    #[test]
    fn invalid_review_inputs_map_to_invalid_params() {
        assert!(matches!(
            CoreError::from(ReviewError::InvalidPathSegment("../escape".to_owned())),
            CoreError::InvalidParams(_)
        ));
        assert!(matches!(
            CoreError::from(ReviewError::InvalidComment("body must not be empty")),
            CoreError::InvalidParams(_)
        ));
        assert!(matches!(
            CoreError::from(ReviewError::ClockBeforeUnixEpoch),
            CoreError::Review(_)
        ));
    }
}
