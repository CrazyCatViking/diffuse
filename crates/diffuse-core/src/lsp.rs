//! Transport-neutral language-server configuration and lifecycle support.
//!
//! The manager owns persistent stdio LSP processes, but knows nothing about
//! JSON-RPC transports or repositories. Callers resolve protocol file IDs to
//! [`SourceDocument`] values through [`DocumentProvider`].

use std::collections::{HashMap, hash_map::DefaultHasher};
use std::ffi::OsStr;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

const CONFIG_LANGUAGES: &[&str] = &[
    "typescript",
    "javascript",
    "rust",
    "python",
    "go",
    "zig",
    "lua",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyntaxSide {
    Old,
    #[default]
    New,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTarget {
    pub base: Option<String>,
    pub compare: Option<String>,
    #[serde(default)]
    pub include_staged: bool,
    #[serde(default)]
    pub include_unstaged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLspStatusParams {
    pub file_id: String,
    #[serde(default)]
    pub side: SyntaxSide,
    #[serde(default)]
    pub target: DiffTarget,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetLspConfigInfoParams {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLspInstallInfoParams {
    pub server_id: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallLspServerParams {
    pub server_id: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartLspServerParams {
    pub server_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLspHoverParams {
    pub file_id: String,
    pub side: SyntaxSide,
    pub line: u32,
    pub column: u32,
    #[serde(default)]
    pub target: DiffTarget,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLspDiagnosticsParams {
    pub file_id: String,
    pub side: SyntaxSide,
    #[serde(default)]
    pub target: DiffTarget,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub configured: bool,
    pub installed: bool,
    #[serde(default)]
    pub starting: bool,
    #[serde(default)]
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfigInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    pub servers: Vec<LspServerInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub language: String,
    pub server_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub config_source: String,
    pub installed: bool,
    #[serde(default)]
    pub starting: bool,
    #[serde(default)]
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<LspInstallInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInstallInfo {
    pub manager: String,
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
    pub requires_shell: bool,
    pub safe_to_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallLspServerResult {
    pub server_id: String,
    pub command: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartLspServerResult {
    pub server_id: String,
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHover {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostics {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(default)]
    pub diagnostics: Vec<LspDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceDocument {
    pub repository_root: PathBuf,
    pub path: PathBuf,
    pub source: String,
}

/// Resolves transport file IDs and diff-side metadata without coupling the LSP
/// implementation to a repository implementation.
pub trait DocumentProvider {
    fn resolve_document(
        &self,
        file_id: &str,
        side: SyntaxSide,
        target: &DiffTarget,
    ) -> LspResult<SourceDocument>;
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub struct RequestControl {
    pub timeout: Duration,
    pub cancellation: CancellationToken,
}

impl RequestControl {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            cancellation: CancellationToken::default(),
        }
    }
}

impl Default for RequestControl {
    fn default() -> Self {
        Self::new(Duration::from_secs(5))
    }
}

#[derive(Clone, Debug)]
pub struct LspManagerOptions {
    pub config_path: Option<PathBuf>,
    pub max_sessions: usize,
    pub message_queue_capacity: usize,
    pub max_message_size: usize,
    pub initialize_timeout: Duration,
    pub request_timeout: Duration,
    pub diagnostics_settle_timeout: Duration,
    pub install_timeout: Duration,
}

impl LspManagerOptions {
    pub fn from_environment() -> Self {
        Self {
            config_path: default_config_path(),
            ..Self::default()
        }
    }
}

impl Default for LspManagerOptions {
    fn default() -> Self {
        Self {
            config_path: None,
            max_sessions: 8,
            message_queue_capacity: 256,
            max_message_size: 20 * 1024 * 1024,
            initialize_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(5),
            diagnostics_settle_timeout: Duration::from_secs(1),
            install_timeout: Duration::from_secs(5 * 60),
        }
    }
}

#[derive(Debug, Error)]
pub enum LspError {
    #[error("LspIoError: {0}")]
    Io(#[from] std::io::Error),
    #[error("InvalidLspJson: {0}")]
    Json(#[from] serde_json::Error),
    #[error("LspManagerLockPoisoned")]
    LockPoisoned,
    #[error("LspProcessLimitReached")]
    ProcessLimitReached,
    #[error("LspRequestTimedOut")]
    Timeout,
    #[error("LspRequestCancelled")]
    Cancelled,
    #[error("LspProcessExited")]
    ProcessExited,
    #[error("InvalidLspMessage: {0}")]
    InvalidMessage(String),
    #[error("LspServerError: {0}")]
    Server(String),
    #[error("LspDocumentNotAttached")]
    DocumentNotAttached,
    #[error("LspSessionNotStarted")]
    SessionNotStarted,
    #[error("InvalidSourcePath")]
    InvalidSourcePath,
}

pub type LspResult<T> = Result<T, LspError>;

pub struct LspManager {
    options: LspManagerOptions,
    state: Mutex<ManagerState>,
    install_gate: Mutex<()>,
}

#[derive(Default)]
struct ManagerState {
    sessions: Vec<Session>,
}

impl LspManager {
    pub fn new(options: LspManagerOptions) -> Self {
        Self {
            options,
            state: Mutex::new(ManagerState::default()),
            install_gate: Mutex::new(()),
        }
    }

    pub fn get_lsp_config_info(
        &self,
        _params: &GetLspConfigInfoParams,
    ) -> LspResult<LspConfigInfo> {
        self.lsp_config_info(None)
    }

    pub fn get_lsp_config_info_for_repository(
        &self,
        repository_root: &Path,
        _params: &GetLspConfigInfoParams,
    ) -> LspResult<LspConfigInfo> {
        self.lsp_config_info(Some(repository_root))
    }

    fn lsp_config_info(&self, repository_root: Option<&Path>) -> LspResult<LspConfigInfo> {
        let configs = self.resolved_configs();
        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let mut servers = Vec::with_capacity(configs.len());
        for config in configs {
            let session = state.sessions.iter_mut().find(|session| {
                repository_root.is_none_or(|root| session.repository_root == root)
                    && session.language == config.language
                    && session.server_id == config.id
            });
            let (running, last_error) = match session {
                Some(session) => (session.is_running(), session.last_error.clone()),
                None => (false, None),
            };
            servers.push(LspServerInfo {
                language: config.language.clone(),
                server_id: config.id.clone(),
                command: config.command.clone(),
                args: config.args.clone(),
                config_source: config.source.clone(),
                installed: command_exists(&config.command),
                starting: false,
                running,
                last_error,
                install: Some(install_info_for(&config.id, &config.command)),
            });
        }
        Ok(LspConfigInfo {
            config_path: self
                .options
                .config_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            servers,
        })
    }

    pub fn get_lsp_install_info(
        &self,
        params: &GetLspInstallInfoParams,
    ) -> LspResult<LspInstallInfo> {
        Ok(install_info_for(&params.server_id, &params.command))
    }

    pub fn install_lsp_server(
        &self,
        params: &InstallLspServerParams,
        control: Option<&RequestControl>,
        mut progress: impl FnMut(&str),
    ) -> LspResult<InstallLspServerResult> {
        let _gate = self
            .install_gate
            .lock()
            .map_err(|_| LspError::LockPoisoned)?;
        let info = install_info_for(&params.server_id, &params.command);
        if !info.safe_to_run {
            return Ok(InstallLspServerResult {
                server_id: params.server_id.clone(),
                command: params.command.clone(),
                installed: command_exists(&params.command),
                message: Some("This language server install is copy-only for now.".into()),
            });
        }
        if !command_exists(&info.command) {
            return Ok(InstallLspServerResult {
                server_id: params.server_id.clone(),
                command: params.command.clone(),
                installed: false,
                message: Some(format!("Installer command not found: {}", info.command)),
            });
        }

        progress("Starting install");
        progress("Running installer");
        let default_control = RequestControl::new(self.options.install_timeout);
        let success = run_supervised(
            &info.command,
            &info.args,
            control.unwrap_or(&default_control),
        )?;
        if success {
            progress("Verifying command");
        }
        let installed = command_exists(&params.command);
        let message = if !success {
            "Installer exited unsuccessfully."
        } else if installed {
            "Language server installed."
        } else {
            "Installer finished, but the language server command was not found on PATH."
        };
        Ok(InstallLspServerResult {
            server_id: params.server_id.clone(),
            command: params.command.clone(),
            installed,
            message: Some(message.into()),
        })
    }

    pub fn restart_lsp_server(
        &self,
        params: &RestartLspServerParams,
    ) -> LspResult<RestartLspServerResult> {
        self.restart_lsp_server_scoped(None, params)
    }

    pub fn restart_lsp_server_for_repository(
        &self,
        repository_root: &Path,
        params: &RestartLspServerParams,
    ) -> LspResult<RestartLspServerResult> {
        self.restart_lsp_server_scoped(Some(repository_root), params)
    }

    fn restart_lsp_server_scoped(
        &self,
        repository_root: Option<&Path>,
        params: &RestartLspServerParams,
    ) -> LspResult<RestartLspServerResult> {
        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let mut restarted = false;
        let mut index = 0;
        while index < state.sessions.len() {
            if state.sessions[index].server_id == params.server_id
                && repository_root.is_none_or(|root| state.sessions[index].repository_root == root)
            {
                let mut session = state.sessions.swap_remove(index);
                session.stop(Duration::from_secs(1));
                restarted = true;
            } else {
                index += 1;
            }
        }
        Ok(RestartLspServerResult {
            server_id: params.server_id.clone(),
            restarted,
            message: Some(
                if restarted {
                    "Language server session stopped. It will restart on the next request."
                } else {
                    "No running session found."
                }
                .into(),
            ),
        })
    }

    pub fn get_lsp_status(
        &self,
        params: &GetLspStatusParams,
        documents: &impl DocumentProvider,
    ) -> LspResult<LspStatus> {
        let document = documents.resolve_document(&params.file_id, params.side, &params.target)?;
        self.lsp_status(&document)
    }

    pub fn get_lsp_status_for_repository(
        &self,
        repository_root: &Path,
        params: &GetLspStatusParams,
        documents: &impl DocumentProvider,
    ) -> LspResult<LspStatus> {
        let document = documents.resolve_document(&params.file_id, params.side, &params.target)?;
        if document.repository_root != repository_root {
            return Err(LspError::InvalidSourcePath);
        }
        self.lsp_status(&document)
    }

    fn lsp_status(&self, document: &SourceDocument) -> LspResult<LspStatus> {
        let Some(language) = detect_language(&document.path) else {
            return Ok(LspStatus {
                message: Some("No language detected for this file".into()),
                ..LspStatus::default()
            });
        };
        let Some(config) = self.resolve_config(language) else {
            return Ok(LspStatus {
                language: Some(language.into()),
                message: Some("No LSP server configured for this language".into()),
                ..LspStatus::default()
            });
        };
        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let session = state.sessions.iter_mut().find(|session| {
            session.repository_root == document.repository_root
                && session.language == language
                && session.server_id == config.id
        });
        let (running, last_error) = match session {
            Some(session) => (session.is_running(), session.last_error.clone()),
            None => (false, None),
        };
        let installed = command_exists(&config.command);
        Ok(LspStatus {
            language: Some(language.into()),
            server_id: Some(config.id),
            command: Some(config.command),
            configured: true,
            installed,
            starting: false,
            running,
            config_source: Some(config.source),
            last_error,
            message: Some(
                if installed {
                    "LSP server ready"
                } else {
                    "LSP server command was not found on PATH"
                }
                .into(),
            ),
        })
    }

    pub fn get_lsp_hover(
        &self,
        params: &GetLspHoverParams,
        documents: &impl DocumentProvider,
        control: Option<&RequestControl>,
    ) -> LspResult<LspHover> {
        let document = documents.resolve_document(&params.file_id, params.side, &params.target)?;
        let Some(language) = detect_language(&document.path) else {
            return Ok(hover_failure(
                "language-unknown",
                None,
                None,
                "No language detected for this file",
            ));
        };
        let Some(config) = self.resolve_config(language) else {
            return Ok(hover_failure(
                "server-not-configured",
                Some(language),
                None,
                "No LSP server configured for this language",
            ));
        };
        if !command_exists(&config.command) {
            return Ok(hover_failure(
                "server-not-installed",
                Some(language),
                Some(&config.id),
                "LSP server command was not found on PATH",
            ));
        }

        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let Some(session) = state.sessions.iter_mut().find(|session| {
            session.repository_root == document.repository_root
                && session.language == language
                && session.server_id == config.id
        }) else {
            return Ok(hover_failure(
                "hover-unavailable",
                Some(language),
                Some(&config.id),
                "LSP server has not been attached for this file",
            ));
        };
        let default_control = RequestControl::new(self.options.request_timeout);
        match session.hover(
            &document,
            params.line,
            params.column,
            control.unwrap_or(&default_control),
        ) {
            Ok(contents) if !contents.is_empty() => Ok(LspHover {
                status: "ok".into(),
                language: Some(language.into()),
                server_id: Some(config.id),
                contents: Some(contents),
                message: None,
            }),
            Ok(_) => Ok(hover_failure(
                "hover-unavailable",
                Some(language),
                Some(&config.id),
                "No hover information available",
            )),
            Err(LspError::DocumentNotAttached) => Ok(hover_failure(
                "hover-unavailable",
                Some(language),
                Some(&config.id),
                "LSP server has not been attached for this file",
            )),
            Err(error) => {
                session.last_error = Some(error.to_string());
                Ok(hover_failure(
                    "request-failed",
                    Some(language),
                    Some(&config.id),
                    &format!("LSP hover request failed: {error}"),
                ))
            }
        }
    }

    pub fn get_lsp_diagnostics(
        &self,
        params: &GetLspDiagnosticsParams,
        documents: &impl DocumentProvider,
        control: Option<&RequestControl>,
    ) -> LspResult<LspDiagnostics> {
        let document = documents.resolve_document(&params.file_id, params.side, &params.target)?;
        let Some(language) = detect_language(&document.path) else {
            return Ok(diagnostics_failure(
                "language-unknown",
                None,
                None,
                "No language detected for this file",
            ));
        };
        let Some(config) = self.resolve_config(language) else {
            return Ok(diagnostics_failure(
                "server-not-configured",
                Some(language),
                None,
                "No LSP server configured for this language",
            ));
        };
        if !command_exists(&config.command) {
            return Ok(diagnostics_failure(
                "server-not-installed",
                Some(language),
                Some(&config.id),
                "LSP server command was not found on PATH",
            ));
        }

        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let key = (&document.repository_root, language, config.id.as_str());
        let mut existing = state.sessions.iter().position(|session| {
            session.repository_root == *key.0
                && session.language == key.1
                && session.server_id == key.2
        });
        if existing.is_some_and(|index| !state.sessions[index].is_running()) {
            state.sessions.swap_remove(existing.unwrap());
            existing = None;
        }
        if existing.is_none() {
            if state.sessions.len() >= self.options.max_sessions {
                return Err(LspError::ProcessLimitReached);
            }
            let session = match Session::start(&document.repository_root, &config, &self.options) {
                Ok(session) => session,
                Err(error) => {
                    return Ok(diagnostics_failure(
                        "request-failed",
                        Some(language),
                        Some(&config.id),
                        &format!("LSP diagnostics request failed: {error}"),
                    ));
                }
            };
            state.sessions.push(session);
            existing = Some(state.sessions.len() - 1);
        }
        let session = &mut state.sessions[existing.expect("session inserted")];
        let default_control = RequestControl::new(self.options.request_timeout);
        match session.diagnostics(
            &document,
            control.unwrap_or(&default_control),
            self.options.diagnostics_settle_timeout,
        ) {
            Ok(diagnostics) => Ok(LspDiagnostics {
                status: "ok".into(),
                language: Some(language.into()),
                server_id: Some(config.id),
                diagnostics,
                message: None,
            }),
            Err(error) => {
                session.last_error = Some(error.to_string());
                Ok(diagnostics_failure(
                    "request-failed",
                    Some(language),
                    Some(&config.id),
                    &format!("LSP diagnostics request failed: {error}"),
                ))
            }
        }
    }

    pub fn shutdown(&self) -> LspResult<()> {
        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        for session in &mut state.sessions {
            session.stop(Duration::from_secs(1));
        }
        state.sessions.clear();
        Ok(())
    }

    pub fn shutdown_repository(&self, repository_root: &Path) -> LspResult<()> {
        let mut state = self.state.lock().map_err(|_| LspError::LockPoisoned)?;
        let mut index = 0;
        while index < state.sessions.len() {
            if state.sessions[index].repository_root == repository_root {
                let mut session = state.sessions.swap_remove(index);
                session.stop(Duration::from_secs(1));
            } else {
                index += 1;
            }
        }
        Ok(())
    }

    fn resolved_configs(&self) -> Vec<ServerConfig> {
        CONFIG_LANGUAGES
            .iter()
            .filter_map(|language| self.resolve_config(language))
            .collect()
    }

    fn resolve_config(&self, language: &str) -> Option<ServerConfig> {
        if let Some(config) = self.read_user_config(language) {
            return Some(config);
        }
        builtin_config(language)
    }

    fn read_user_config(&self, language: &str) -> Option<ServerConfig> {
        let path = self.options.config_path.as_ref()?;
        let metadata = std::fs::metadata(path).ok()?;
        if metadata.len() > 1024 * 1024 {
            return None;
        }
        let source = std::fs::read(path).ok()?;
        let config: UserConfig = serde_json::from_slice(&source).ok()?;
        let server = config.lsp.get(language)?;
        if server.command.trim().is_empty() {
            return None;
        }
        Some(ServerConfig {
            id: language.into(),
            language: language.into(),
            command: server.command.clone(),
            args: server.args.clone(),
            source: "user".into(),
        })
    }
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new(LspManagerOptions::from_environment())
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            for session in &mut state.sessions {
                session.terminate();
            }
        }
    }
}

#[derive(Clone, Debug)]
struct ServerConfig {
    id: String,
    language: String,
    command: String,
    args: Vec<String>,
    source: String,
}

#[derive(Deserialize)]
struct UserConfig {
    #[serde(default)]
    lsp: HashMap<String, UserServerConfig>,
}

#[derive(Deserialize)]
struct UserServerConfig {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct DocumentState {
    hash: u64,
    version: u32,
}

struct Session {
    repository_root: PathBuf,
    language: String,
    server_id: String,
    child: Child,
    stdin: BufWriter<ChildStdin>,
    messages: Option<Receiver<LspResult<Value>>>,
    reader: Option<JoinHandle<()>>,
    next_id: i64,
    supports_pull_diagnostics: bool,
    running: bool,
    last_error: Option<String>,
    documents: HashMap<String, DocumentState>,
    diagnostics_by_uri: HashMap<String, Vec<LspDiagnostic>>,
}

impl Session {
    fn start(root: &Path, config: &ServerConfig, options: &LspManagerOptions) -> LspResult<Self> {
        if !root.is_dir() {
            return Err(LspError::InvalidSourcePath);
        }
        let mut child = Command::new(&config.command)
            .args(&config.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take().ok_or(LspError::ProcessExited)?;
        let stdout = child.stdout.take().ok_or(LspError::ProcessExited)?;
        let capacity = options.message_queue_capacity.max(1);
        let (sender, receiver) = sync_channel(capacity);
        let max_message_size = options.max_message_size;
        let reader = thread::Builder::new()
            .name(format!("diffuse-lsp-{}", config.id))
            .spawn(move || read_messages(stdout, sender, max_message_size))?;
        let mut session = Self {
            repository_root: root.to_owned(),
            language: config.language.clone(),
            server_id: config.id.clone(),
            child,
            stdin: BufWriter::new(stdin),
            messages: Some(receiver),
            reader: Some(reader),
            next_id: 1,
            supports_pull_diagnostics: false,
            running: false,
            last_error: None,
            documents: HashMap::new(),
            diagnostics_by_uri: HashMap::new(),
        };
        let root_uri = path_uri(root)?;
        let control = RequestControl::new(options.initialize_timeout);
        let response = session.request(
            "initialize",
            json!({
                "processId": Value::Null,
                "rootUri": root_uri,
                "workspaceFolders": [{"uri": root_uri, "name": "diffuse"}],
                "capabilities": {
                    "textDocument": {
                        "synchronization": {"didSave": true},
                        "publishDiagnostics": {},
                        "hover": {"contentFormat": ["markdown", "plaintext"]},
                        "diagnostic": {"dynamicRegistration": false}
                    }
                },
                "initializationOptions": {},
                "trace": "off",
                "clientInfo": {"name": "diffuse", "version": env!("CARGO_PKG_VERSION")}
            }),
            &control,
        )?;
        session.supports_pull_diagnostics = response
            .pointer("/capabilities/diagnosticProvider")
            .is_some();
        session.notify("initialized", json!({}))?;
        session.running = true;
        Ok(session)
    }

    fn hover(
        &mut self,
        document: &SourceDocument,
        line: u32,
        column: u32,
        control: &RequestControl,
    ) -> LspResult<String> {
        let uri = document_uri(document)?;
        if !self.documents.contains_key(&uri) {
            return Err(LspError::DocumentNotAttached);
        }
        self.sync_document(&uri, &document.source)?;
        let result = self.request(
            "textDocument/hover",
            json!({
                "textDocument": {"uri": uri},
                "position": {"line": line.saturating_sub(1), "character": column}
            }),
            control,
        )?;
        Ok(result
            .get("contents")
            .map(hover_contents)
            .unwrap_or_default())
    }

    fn diagnostics(
        &mut self,
        document: &SourceDocument,
        control: &RequestControl,
        settle_timeout: Duration,
    ) -> LspResult<Vec<LspDiagnostic>> {
        let uri = document_uri(document)?;
        self.drain(Duration::ZERO)?;
        self.sync_document(&uri, &document.source)?;
        if self.supports_pull_diagnostics {
            match self.request(
                "textDocument/diagnostic",
                json!({"textDocument": {"uri": uri}}),
                control,
            ) {
                Ok(result) => {
                    if let Some(items) = result.get("items").and_then(Value::as_array) {
                        return Ok(parse_diagnostics(items));
                    }
                }
                // A server may advertise pull diagnostics but reject this
                // document. Preserve the publish-diagnostics fallback.
                Err(LspError::Server(_)) => {}
                Err(error) => return Err(error),
            }
        }
        self.notify(
            "textDocument/didSave",
            json!({"textDocument": {"uri": uri}}),
        )?;
        self.drain(settle_timeout)?;
        Ok(self
            .diagnostics_by_uri
            .get(&uri)
            .cloned()
            .unwrap_or_default())
    }

    fn sync_document(&mut self, uri: &str, source: &str) -> LspResult<()> {
        let hash = source_hash(source);
        if let Some(state) = self.documents.get_mut(uri) {
            if state.hash == hash {
                return Ok(());
            }
            state.version = state.version.saturating_add(1);
            state.hash = hash;
            let version = state.version;
            self.diagnostics_by_uri.remove(uri);
            return self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": version},
                    "contentChanges": [{"text": source}]
                }),
            );
        }
        self.diagnostics_by_uri.remove(uri);
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": self.language,
                    "version": 1,
                    "text": source
                }
            }),
        )?;
        self.documents
            .insert(uri.into(), DocumentState { hash, version: 1 });
        Ok(())
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        control: &RequestControl,
    ) -> LspResult<Value> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| LspError::InvalidMessage("request ID exhausted".into()))?;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        self.wait_for_response(id, control)
    }

    fn wait_for_response(&mut self, id: i64, control: &RequestControl) -> LspResult<Value> {
        let deadline = Instant::now() + control.timeout;
        loop {
            if control.cancellation.is_cancelled() {
                let _ = self.notify("$/cancelRequest", json!({"id": id}));
                return Err(LspError::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                let _ = self.notify("$/cancelRequest", json!({"id": id}));
                return Err(LspError::Timeout);
            }
            let wait = deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(50));
            let received = self
                .messages
                .as_ref()
                .ok_or(LspError::ProcessExited)?
                .recv_timeout(wait);
            match received {
                Ok(Ok(message)) => {
                    if message.get("id").and_then(Value::as_i64) == Some(id) {
                        if let Some(error) = message.get("error") {
                            return Err(LspError::Server(error.to_string()));
                        }
                        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                    }
                    self.handle_message(message)?;
                }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(LspError::ProcessExited),
            }
        }
    }

    fn drain(&mut self, timeout: Duration) -> LspResult<()> {
        let deadline = Instant::now() + timeout;
        for _ in 0..64 {
            let wait = if timeout.is_zero() {
                Duration::ZERO
            } else {
                deadline.saturating_duration_since(Instant::now())
            };
            let received = self
                .messages
                .as_ref()
                .ok_or(LspError::ProcessExited)?
                .recv_timeout(wait);
            match received {
                Ok(Ok(message)) => self.handle_message(message)?,
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => return Ok(()),
                Err(RecvTimeoutError::Disconnected) => return Err(LspError::ProcessExited),
            }
            if !timeout.is_zero() && Instant::now() >= deadline {
                return Ok(());
            }
        }
        Ok(())
    }

    fn handle_message(&mut self, message: Value) -> LspResult<()> {
        if message.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
        {
            if let Some(params) = message.get("params")
                && let (Some(uri), Some(items)) = (
                    params.get("uri").and_then(Value::as_str),
                    params.get("diagnostics").and_then(Value::as_array),
                )
            {
                self.diagnostics_by_uri
                    .insert(uri.into(), parse_diagnostics(items));
            }
        } else if message.get("method").is_some() && message.get("id").is_some() {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            self.send(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": "Method not supported"}
            }))?;
        }
        Ok(())
    }

    fn notify(&mut self, method: &str, params: Value) -> LspResult<()> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    fn send(&mut self, message: &Value) -> LspResult<()> {
        let body = serde_json::to_vec(message)?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        self.stdin.write_all(&body)?;
        self.stdin.flush()?;
        Ok(())
    }

    fn is_running(&mut self) -> bool {
        if !self.running {
            return false;
        }
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                self.running = false;
                self.last_error = Some(format!("Language server exited with {status}"));
                false
            }
            Err(error) => {
                self.running = false;
                self.last_error = Some(error.to_string());
                false
            }
        }
    }

    fn stop(&mut self, timeout: Duration) {
        if self.is_running() {
            let control = RequestControl::new(timeout);
            let _ = self.request("shutdown", Value::Null, &control);
            let _ = self.notify("exit", json!({}));
        }
        self.terminate();
    }

    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.running = false;
        self.messages.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn read_messages(stdout: impl Read, sender: SyncSender<LspResult<Value>>, max_message_size: usize) {
    let mut reader = BufReader::new(stdout);
    loop {
        let result = read_message(&mut reader, max_message_size);
        let terminal = result.is_err();
        if sender.send(result).is_err() || terminal {
            return;
        }
    }
}

fn read_message(reader: &mut impl BufRead, max_message_size: usize) -> LspResult<Value> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    for _ in 0..64 {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        if count == 0 {
            return Err(LspError::ProcessExited);
        }
        header_bytes += count;
        if header_bytes > 8192 {
            return Err(LspError::InvalidMessage("headers exceed 8 KiB".into()));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length
        .filter(|length| *length > 0 && *length <= max_message_size)
        .ok_or_else(|| LspError::InvalidMessage("invalid Content-Length".into()))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

fn run_supervised(command: &str, args: &[String], control: &RequestControl) -> LspResult<bool> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + control.timeout;
    loop {
        if control.cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LspError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LspError::Timeout);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn builtin_config(language: &str) -> Option<ServerConfig> {
    let (id, command, args): (&str, &str, &[&str]) = match language {
        "typescript" | "javascript" => (
            "typescript-language-server",
            "typescript-language-server",
            &["--stdio"],
        ),
        "rust" => ("rust-analyzer", "rust-analyzer", &[]),
        "python" => ("pyright", "pyright-langserver", &["--stdio"]),
        "go" => ("gopls", "gopls", &[]),
        "zig" => ("zls", "zls", &[]),
        "lua" => ("lua-language-server", "lua-language-server", &[]),
        _ => return None,
    };
    Some(ServerConfig {
        id: id.into(),
        language: language.into(),
        command: command.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        source: "builtin".into(),
    })
}

fn install_info_for(server_id: &str, command: &str) -> LspInstallInfo {
    let (manager, installer, args, description, safe, note): (
        &str,
        &str,
        &[&str],
        String,
        bool,
        Option<&str>,
    ) = match server_id {
        "typescript-language-server" => (
            "npm",
            "npm",
            &["install", "-g", "typescript", "typescript-language-server"],
            "Install the TypeScript language server from npm.".into(),
            false,
            Some("npm installs remain copy-only in Diffuse for now."),
        ),
        "rust-analyzer" => (
            "rustup",
            "rustup",
            &["component", "add", "rust-analyzer"],
            "Install rust-analyzer with rustup.".into(),
            true,
            None,
        ),
        "gopls" => (
            "go",
            "go",
            &["install", "golang.org/x/tools/gopls@latest"],
            "Install the Go language server with go install.".into(),
            true,
            None,
        ),
        "pyright" => (
            "npm",
            "npm",
            &["install", "-g", "pyright"],
            "Install Pyright from npm.".into(),
            false,
            Some("npm installs remain copy-only in Diffuse for now."),
        ),
        "zig" | "zls" => (
            "manual",
            "zls",
            &["--version"],
            "Install ZLS, then point ~/.diffuse/lsp.json at the zls executable if it is not on PATH.".into(),
            false,
            Some("If zls is not on PATH, add its full path to ~/.diffuse/lsp.json."),
        ),
        "lua-language-server" => (
            "manual",
            "lua-language-server",
            &["--version"],
            "Install Lua Language Server from your package manager.".into(),
            false,
            Some("If the binary is not on PATH, add its full path to ~/.diffuse/lsp.json."),
        ),
        _ => (
            "manual",
            command,
            &["--version"],
            format!("Install {server_id}, then refresh this list."),
            false,
            Some("If the command is not on PATH, add its full path to ~/.diffuse/lsp.json."),
        ),
    };
    LspInstallInfo {
        manager: manager.into(),
        command: installer.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        description,
        requires_shell: false,
        safe_to_run: safe,
        note: note.map(str::to_owned),
    }
}

pub fn detect_language(path: &Path) -> Option<&'static str> {
    if path.file_name() == Some(OsStr::new("Dockerfile")) {
        return Some("dockerfile");
    }
    match path.extension().and_then(OsStr::to_str) {
        Some("ts" | "tsx") => Some("typescript"),
        Some("js" | "jsx" | "mjs" | "cjs") => Some("javascript"),
        Some("rs") => Some("rust"),
        Some("py") => Some("python"),
        Some("go") => Some("go"),
        Some("zig") => Some("zig"),
        Some("lua") => Some("lua"),
        _ => None,
    }
}

fn command_exists(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command_path.components().count() > 1 {
        return command_path.is_file();
    }
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| executable_candidate(&directory, command))
    })
}

fn executable_candidate(directory: &Path, command: &str) -> bool {
    if directory.join(command).is_file() {
        return true;
    }
    #[cfg(windows)]
    {
        for extension in ["exe", "cmd", "bat"] {
            if directory.join(format!("{command}.{extension}")).is_file() {
                return true;
            }
        }
    }
    false
}

fn default_config_path() -> Option<PathBuf> {
    config_path_for_platform(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        cfg!(windows),
    )
}

fn config_path_for_platform(
    local_app_data: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    home: Option<PathBuf>,
    windows: bool,
) -> Option<PathBuf> {
    if windows {
        if let Some(path) = local_app_data {
            return Some(path.join("Diffuse").join("lsp.json"));
        }
        return user_profile
            .or(home)
            .map(|home| home.join(".diffuse").join("lsp.json"));
    }
    home.map(|home| home.join(".diffuse").join("lsp.json"))
}

fn document_uri(document: &SourceDocument) -> LspResult<String> {
    if document.path.is_absolute()
        || document
            .path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(LspError::InvalidSourcePath);
    }
    path_uri(&document.repository_root.join(&document.path))
}

fn path_uri(path: &Path) -> LspResult<String> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(path_uri_from_text(
        &absolute.to_string_lossy(),
        cfg!(windows),
    ))
}

fn path_uri_from_text(path: &str, windows: bool) -> String {
    let text = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let mut result = if windows
        && text.as_bytes().get(1) == Some(&b':')
        && text.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
    {
        String::from("file:///")
    } else if windows && text.starts_with("//") {
        String::from("file:")
    } else {
        String::from("file://")
    };
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn source_hash(source: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    hasher.finish()
}

fn hover_contents(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(object) => object.get("value").map(hover_contents).unwrap_or_default(),
        Value::Array(items) => items
            .iter()
            .map(hover_contents)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn parse_diagnostics(items: &[Value]) -> Vec<LspDiagnostic> {
    items
        .iter()
        .filter_map(|item| {
            let start = item.pointer("/range/start")?;
            let end = item.pointer("/range/end").unwrap_or(start);
            let line = json_u32(start.get("line")?).saturating_add(1);
            let start_column = json_u32(start.get("character")?);
            let end_column = end.get("character").map(json_u32).unwrap_or(start_column);
            let severity = match item.get("severity").map(json_u32).unwrap_or(3) {
                1 => "error",
                2 => "warning",
                4 => "hint",
                _ => "info",
            };
            Some(LspDiagnostic {
                line,
                start_column,
                end_column,
                severity: severity.into(),
                message: item.get("message")?.as_str()?.into(),
                source: item
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                code: item.get("code").and_then(diagnostic_code),
            })
        })
        .collect()
}

fn json_u32(value: &Value) -> u32 {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0)
}

fn diagnostic_code(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Object(object) => object.get("value").and_then(diagnostic_code),
        _ => None,
    }
}

fn hover_failure(
    status: &str,
    language: Option<&str>,
    server_id: Option<&str>,
    message: &str,
) -> LspHover {
    LspHover {
        status: status.into(),
        language: language.map(str::to_owned),
        server_id: server_id.map(str::to_owned),
        contents: None,
        message: Some(message.into()),
    }
}

fn diagnostics_failure(
    status: &str,
    language: Option<&str>,
    server_id: Option<&str>,
    message: &str,
) -> LspDiagnostics {
    LspDiagnostics {
        status: status.into(),
        language: language.map(str::to_owned),
        server_id: server_id.map(str::to_owned),
        diagnostics: Vec::new(),
        message: Some(message.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn protocol_dtos_use_existing_camel_case_contract() {
        let params = GetLspHoverParams {
            file_id: "src/main.rs".into(),
            side: SyntaxSide::New,
            line: 7,
            column: 3,
            target: DiffTarget::default(),
        };
        let value = serde_json::to_value(params).unwrap();
        assert_eq!(value["fileId"], "src/main.rs");
        assert_eq!(value["side"], "new");
        assert_eq!(value["target"]["includeStaged"], false);
    }

    #[test]
    fn language_detection_matches_zig_phase_three() {
        assert_eq!(detect_language(Path::new("src/a.tsx")), Some("typescript"));
        assert_eq!(detect_language(Path::new("src/a.cjs")), Some("javascript"));
        assert_eq!(detect_language(Path::new("Dockerfile")), Some("dockerfile"));
        assert_eq!(detect_language(Path::new("README.md")), None);
    }

    #[test]
    fn user_configuration_overrides_builtin_configuration() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("lsp.json");
        std::fs::write(
            &path,
            r#"{"lsp":{"zig":{"command":"/opt/zls","args":["--stdio"]}}}"#,
        )
        .unwrap();
        let manager = LspManager::new(LspManagerOptions {
            config_path: Some(path),
            ..LspManagerOptions::default()
        });
        let config = manager.resolve_config("zig").unwrap();
        assert_eq!(config.command, "/opt/zls");
        assert_eq!(config.args, ["--stdio"]);
        assert_eq!(config.source, "user");
    }

    #[test]
    fn configuration_path_uses_platform_app_and_home_directories() {
        let local_app_data = PathBuf::from(r"C:\Users\me\AppData\Local");
        let user_profile = PathBuf::from(r"C:\Users\me");
        assert_eq!(
            config_path_for_platform(
                Some(local_app_data.clone()),
                Some(user_profile.clone()),
                None,
                true,
            ),
            Some(local_app_data.join("Diffuse").join("lsp.json"))
        );
        assert_eq!(
            config_path_for_platform(None, Some(user_profile.clone()), None, true),
            Some(user_profile.join(".diffuse").join("lsp.json"))
        );

        let home = PathBuf::from("/home/me");
        assert_eq!(
            config_path_for_platform(None, None, Some(home.clone()), false),
            Some(home.join(".diffuse").join("lsp.json"))
        );
    }

    #[test]
    fn file_uris_handle_windows_roots_and_percent_encoding() {
        assert_eq!(
            path_uri_from_text(r"C:\Users\Jane Doe\100%#?.rs", true),
            "file:///C:/Users/Jane%20Doe/100%25%23%3F.rs"
        );
        assert_eq!(
            path_uri_from_text(r"\\server\share\a b.rs", true),
            "file://server/share/a%20b.rs"
        );
        assert_eq!(
            path_uri_from_text("/tmp/\u{e9}.rs", false),
            "file:///tmp/%C3%A9.rs"
        );
    }

    struct FixedDocumentProvider {
        repository_root: PathBuf,
    }

    impl DocumentProvider for FixedDocumentProvider {
        fn resolve_document(
            &self,
            file_id: &str,
            _side: SyntaxSide,
            _target: &DiffTarget,
        ) -> LspResult<SourceDocument> {
            Ok(SourceDocument {
                repository_root: self.repository_root.clone(),
                path: PathBuf::from(file_id),
                source: "fn main() {}".into(),
            })
        }
    }

    fn test_session(repository_root: &Path) -> Session {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/D", "/Q", "/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "cat"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        Session {
            repository_root: repository_root.to_owned(),
            language: "rust".into(),
            server_id: "rust-analyzer".into(),
            child,
            stdin: BufWriter::new(stdin),
            messages: None,
            reader: None,
            next_id: 1,
            supports_pull_diagnostics: false,
            running: true,
            last_error: None,
            documents: HashMap::new(),
            diagnostics_by_uri: HashMap::new(),
        }
    }

    #[test]
    fn repository_scoped_lifecycle_and_status_are_isolated() {
        let temp = TempDir::new().unwrap();
        let root_a = temp.path().join("a");
        let root_b = temp.path().join("b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let manager = LspManager::new(LspManagerOptions::default());
        manager
            .state
            .lock()
            .unwrap()
            .sessions
            .push(test_session(&root_b));

        let config_params = GetLspConfigInfoParams::default();
        let config_a = manager
            .get_lsp_config_info_for_repository(&root_a, &config_params)
            .unwrap();
        let config_b = manager
            .get_lsp_config_info_for_repository(&root_b, &config_params)
            .unwrap();
        assert!(
            !config_a
                .servers
                .iter()
                .find(|server| server.server_id == "rust-analyzer")
                .unwrap()
                .running
        );
        assert!(
            config_b
                .servers
                .iter()
                .find(|server| server.server_id == "rust-analyzer")
                .unwrap()
                .running
        );

        let documents = FixedDocumentProvider {
            repository_root: root_b.clone(),
        };
        let status_params = GetLspStatusParams {
            file_id: "src/main.rs".into(),
            side: SyntaxSide::New,
            target: DiffTarget::default(),
        };
        assert!(matches!(
            manager.get_lsp_status_for_repository(&root_a, &status_params, &documents),
            Err(LspError::InvalidSourcePath)
        ));
        assert!(
            manager
                .get_lsp_status_for_repository(&root_b, &status_params, &documents)
                .unwrap()
                .running
        );

        let restart_params = RestartLspServerParams {
            server_id: "rust-analyzer".into(),
        };
        assert!(
            !manager
                .restart_lsp_server_for_repository(&root_a, &restart_params)
                .unwrap()
                .restarted
        );
        assert_eq!(manager.state.lock().unwrap().sessions.len(), 1);

        manager
            .state
            .lock()
            .unwrap()
            .sessions
            .push(test_session(&root_a));
        assert!(
            manager
                .restart_lsp_server_for_repository(&root_a, &restart_params)
                .unwrap()
                .restarted
        );
        {
            let state = manager.state.lock().unwrap();
            assert_eq!(state.sessions.len(), 1);
            assert_eq!(state.sessions[0].repository_root, root_b);
        }

        manager
            .state
            .lock()
            .unwrap()
            .sessions
            .push(test_session(&root_a));
        manager.shutdown_repository(&root_a).unwrap();
        {
            let state = manager.state.lock().unwrap();
            assert_eq!(state.sessions.len(), 1);
            assert_eq!(state.sessions[0].repository_root, root_b);
        }
        manager.shutdown_repository(&root_b).unwrap();
        assert!(manager.state.lock().unwrap().sessions.is_empty());
    }

    #[test]
    fn framed_reader_caps_and_decodes_messages() {
        let body = br#"{"jsonrpc":"2.0","id":9,"result":null}"#;
        let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        framed.extend_from_slice(body);
        let value = read_message(&mut Cursor::new(framed), 1024).unwrap();
        assert_eq!(value["id"], 9);

        let invalid = b"Content-Length: 5000\r\n\r\n";
        assert!(matches!(
            read_message(&mut Cursor::new(invalid), 10),
            Err(LspError::InvalidMessage(_))
        ));
    }

    #[test]
    fn hover_and_diagnostic_values_are_normalized() {
        let hover = hover_contents(&json!([{"language": "rust", "value": "one"}, "two"]));
        assert_eq!(hover, "one\n\ntwo");
        let diagnostics = parse_diagnostics(&[json!({
            "range": {
                "start": {"line": 2, "character": 4},
                "end": {"line": 2, "character": 8}
            },
            "severity": 1,
            "message": "broken",
            "code": 42
        })]);
        assert_eq!(diagnostics[0].line, 3);
        assert_eq!(diagnostics[0].severity, "error");
        assert_eq!(diagnostics[0].code.as_deref(), Some("42"));
    }

    #[test]
    fn cancellation_tokens_are_shareable() {
        let token = CancellationToken::default();
        let other = token.clone();
        assert!(!other.is_cancelled());
        token.cancel();
        assert!(other.is_cancelled());
    }
}
