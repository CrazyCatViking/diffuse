//! Tree-sitter registry, grammar lifecycle, and isolated syntax-span support.
//!
//! Downloaded parser libraries are data to this module. They are never opened
//! or linked into the Diffuse process. Highlighting is available only through
//! an explicitly configured executable runner, which may load native parser
//! code in its own supervised process (or host a WASM parser itself).

#[path = "syntax_runner.rs"]
mod syntax_runner;

pub use syntax_runner::run_syntax_runner;

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const EMBEDDED_REGISTRY: &str = include_str!("../../../core/src/core/tree_sitter_registry.json");
pub const DEFAULT_REGISTRY_GIT_URL: &str =
    "https://github.com/CrazyCatViking/diffuse-tree-sitter.git";
const MAX_REGISTRY_SIZE: u64 = 20 * 1024 * 1024;
const MAX_SOURCE_SIZE: usize = 20 * 1024 * 1024;
const MAX_QUERY_SIZE: u64 = 1024 * 1024;
const SYNTAX_RUNNER_SUBCOMMAND: &str = "syntax-runner";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyntaxSide {
    Old,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffContextMode {
    #[default]
    Diff,
    Full,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSpanOptions {
    #[serde(default)]
    pub context: DiffContextMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyntaxSpansParams {
    pub file_id: String,
    pub side: SyntaxSide,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(default)]
    pub options: SyntaxSpanOptions,
    #[serde(default)]
    pub target: DiffTarget,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListTreeSitterGrammarsParams {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTreeSitterRegistryParams {
    pub git_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallTreeSitterGrammarParams {
    pub language: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UninstallTreeSitterGrammarParams {
    pub language: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSpan {
    pub start_column: u32,
    pub end_column: u32,
    pub scope: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxLineSpans {
    pub line: u32,
    pub spans: Vec<SyntaxSpan>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub grammar_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grammar_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlights_query_path: Option<String>,
    pub highlights_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTreeSitterGrammarResult {
    pub language: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grammar_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlights_query_path: Option<String>,
    pub highlights_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallTreeSitterGrammarResult {
    pub language: String,
    pub uninstalled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTreeSitterRegistryResult {
    pub path: String,
    pub synced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSitterGrammar {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grammar_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlights_query_path: Option<String>,
    pub highlights_installed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxSourceDocument {
    pub path: PathBuf,
    pub source: String,
}

/// Resolves diff target and side information outside the syntax manager.
pub trait SyntaxDocumentProvider {
    fn resolve_syntax_document(
        &self,
        params: &GetSyntaxSpansParams,
    ) -> SyntaxResult<SyntaxSourceDocument>;
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
pub struct OperationControl {
    pub timeout: Duration,
    pub cancellation: CancellationToken,
}

impl OperationControl {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            cancellation: CancellationToken::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParserBackend {
    /// Preserve the RPC contract by returning a named method error instead of
    /// unsafely loading an installed native parser into this process.
    Unavailable,
    /// A fixed, direct executable invocation. No shell is involved. The runner
    /// receives one JSON request on stdin and returns spans as JSON on stdout.
    IsolatedExecutable {
        command: PathBuf,
        args: Vec<OsString>,
    },
}

#[derive(Clone, Debug)]
pub struct SyntaxManagerOptions {
    pub grammar_root: PathBuf,
    pub registry_root: Option<PathBuf>,
    pub registry_git_url: Option<String>,
    pub parser_backend: ParserBackend,
    pub command_timeout: Duration,
    pub parser_timeout: Duration,
    pub max_command_output: usize,
    pub max_parser_output: usize,
}

impl SyntaxManagerOptions {
    pub fn from_environment() -> Self {
        Self::from_environment_with_parser_backend(parser_backend_from_environment())
    }

    pub fn from_environment_with_parser_backend(parser_backend: ParserBackend) -> Self {
        let grammar_root = std::env::var_os("DIFFUSE_GRAMMARS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_grammar_root);
        let registry_root = std::env::var_os("DIFFUSE_TREE_SITTER_REGISTRY_DIR").map(PathBuf::from);
        let registry_git_url = std::env::var("DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL")
            .ok()
            .or_else(|| Some(DEFAULT_REGISTRY_GIT_URL.into()));
        Self {
            grammar_root,
            registry_root,
            registry_git_url,
            parser_backend,
            command_timeout: Duration::from_secs(5 * 60),
            parser_timeout: Duration::from_secs(10),
            max_command_output: 1024 * 1024,
            max_parser_output: 20 * 1024 * 1024,
        }
    }
}

fn default_grammar_root() -> PathBuf {
    if cfg!(windows)
        && let Some(path) = std::env::var_os("LOCALAPPDATA")
    {
        return PathBuf::from(path).join("Diffuse").join("grammars");
    }
    if cfg!(target_os = "macos")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Diffuse")
            .join("grammars");
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path).join("diffuse").join("grammars");
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".diffuse/grammars"))
        .unwrap_or_else(|| PathBuf::from(".diffuse/grammars"))
}

impl Default for SyntaxManagerOptions {
    fn default() -> Self {
        Self {
            grammar_root: PathBuf::from(".diffuse/grammars"),
            registry_root: None,
            registry_git_url: Some(DEFAULT_REGISTRY_GIT_URL.into()),
            parser_backend: parser_backend_from_environment(),
            command_timeout: Duration::from_secs(5 * 60),
            parser_timeout: Duration::from_secs(10),
            max_command_output: 1024 * 1024,
            max_parser_output: 20 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Error)]
pub enum SyntaxError {
    #[error("SyntaxIoError: {0}")]
    Io(#[from] std::io::Error),
    #[error("InvalidSyntaxJson: {0}")]
    Json(#[from] serde_json::Error),
    #[error("SyntaxManagerLockPoisoned")]
    LockPoisoned,
    #[error("InvalidGrammarLanguage: {0}")]
    InvalidLanguage(String),
    #[error("UnsafeGrammarPath: {0}")]
    UnsafePath(String),
    #[error("InvalidRegistry: {0}")]
    InvalidRegistry(String),
    #[error("SyntaxCommandTimedOut")]
    Timeout,
    #[error("SyntaxCommandCancelled")]
    Cancelled,
    #[error("SyntaxCommandOutputTooLarge")]
    OutputTooLarge,
    #[error("SyntaxParserUnavailable: configure an isolated executable or WASM parser runner")]
    ParserUnavailable,
    #[error("SyntaxParserFailed: {0}")]
    ParserFailed(String),
}

pub type SyntaxResult<T> = Result<T, SyntaxError>;

pub struct SyntaxManager {
    options: SyntaxManagerOptions,
    process_gate: Mutex<()>,
}

impl SyntaxManager {
    pub fn from_environment() -> SyntaxResult<Self> {
        Self::new(SyntaxManagerOptions::from_environment())
    }

    pub fn new(options: SyntaxManagerOptions) -> SyntaxResult<Self> {
        validate_managed_root(&options.grammar_root)?;
        if let Some(root) = &options.registry_root {
            validate_managed_root(root)?;
        }
        Ok(Self {
            options,
            process_gate: Mutex::new(()),
        })
    }

    pub fn get_syntax_spans(
        &self,
        params: &GetSyntaxSpansParams,
        documents: &impl SyntaxDocumentProvider,
        control: Option<&OperationControl>,
    ) -> SyntaxResult<Vec<SyntaxLineSpans>> {
        if params.end_line < params.start_line {
            return Ok(Vec::new());
        }
        let document = documents.resolve_syntax_document(params)?;
        if document.source.is_empty() {
            return Ok(Vec::new());
        }
        if document.source.len() > MAX_SOURCE_SIZE {
            return Err(SyntaxError::ParserFailed("source exceeds 20 MiB".into()));
        }
        let status = self.detect_status(&document.path)?;
        if !status.grammar_installed || !status.highlights_installed {
            return Ok(Vec::new());
        }
        let ParserBackend::IsolatedExecutable { command, args } = &self.options.parser_backend
        else {
            return Err(SyntaxError::ParserUnavailable);
        };
        let _gate = self
            .process_gate
            .lock()
            .map_err(|_| SyntaxError::LockPoisoned)?;
        let request = ParserRequest {
            language: status.language.as_deref().unwrap_or_default(),
            grammar_path: status.grammar_path.as_deref().unwrap_or_default(),
            highlights_query_path: status.highlights_query_path.as_deref().unwrap_or_default(),
            source: &document.source,
            start_line: params.start_line,
            end_line: params.end_line,
        };
        let input = serde_json::to_vec(&request)?;
        let default_control = OperationControl::new(self.options.parser_timeout);
        let output = run_process(
            command.as_os_str(),
            args,
            Some(input),
            control.unwrap_or(&default_control),
            self.options.max_parser_output,
        )?;
        if !output.success {
            return Err(SyntaxError::ParserFailed(output.message()));
        }
        let response: ParserResponse = serde_json::from_slice(&output.stdout)?;
        let spans = match response {
            ParserResponse::Direct(spans) => spans,
            ParserResponse::Wrapped { spans } => spans,
        };
        validate_spans(spans, params.start_line, params.end_line)
    }

    pub fn list_tree_sitter_grammars(
        &self,
        _params: &ListTreeSitterGrammarsParams,
    ) -> SyntaxResult<Vec<TreeSitterGrammar>> {
        let registry = self.registry()?;
        let mut result = Vec::new();
        for entry in registry
            .languages
            .into_iter()
            .filter(|entry| !entry.query_only)
        {
            validate_language_id(&entry.id)?;
            let parser =
                safe_grammar_path(&self.options.grammar_root, &entry.id)?.join(parser_file_name());
            let query = self.query_path(&entry, QueryKind::Highlights)?;
            let installed = safe_regular_file(&self.options.grammar_root, &parser);
            let highlights_installed = query
                .as_ref()
                .is_some_and(|path| safe_regular_file(&self.registry_root(), path));
            result.push(TreeSitterGrammar {
                id: entry.id,
                url: entry.url,
                revision: entry.revision,
                requires: entry.requires,
                installed,
                grammar_path: installed.then(|| path_string(&parser)),
                highlights_query_path: highlights_installed
                    .then(|| path_string(query.as_ref().expect("checked query"))),
                highlights_installed,
            });
        }
        Ok(result)
    }

    pub fn sync_tree_sitter_registry(
        &self,
        params: &SyncTreeSitterRegistryParams,
        control: Option<&OperationControl>,
    ) -> SyntaxResult<SyncTreeSitterRegistryResult> {
        let _gate = self
            .process_gate
            .lock()
            .map_err(|_| SyntaxError::LockPoisoned)?;
        let root = self.registry_root();
        validate_managed_root(&root)?;
        let registry_file = root.join("registry.json");
        let git_url = params
            .git_url
            .as_deref()
            .or(self.options.registry_git_url.as_deref());
        let Some(git_url) = git_url else {
            return Ok(SyncTreeSitterRegistryResult {
                path: path_string(&root),
                synced: registry_file.is_file(),
                message: Some(
                    if registry_file.is_file() {
                        "using-local-registry"
                    } else {
                        "registry-git-url-required"
                    }
                    .into(),
                ),
            });
        };
        if let Err(error) = validate_git_url(git_url) {
            return Ok(SyncTreeSitterRegistryResult {
                path: path_string(&root),
                synced: false,
                message: Some(format!("clone tree-sitter registry failed: {error}")),
            });
        }
        if let Some(parent) = root.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let default_control = OperationControl::new(self.options.command_timeout);
        let control = control.unwrap_or(&default_control);
        let output = if root.join(".git").is_dir() {
            run_process(
                OsStr::new("git"),
                &[
                    OsString::from("-C"),
                    root.as_os_str().to_owned(),
                    OsString::from("pull"),
                    OsString::from("--ff-only"),
                ],
                None,
                control,
                self.options.max_command_output,
            )?
        } else {
            remove_managed_path(&root)?;
            run_process(
                OsStr::new("git"),
                &[
                    OsString::from("clone"),
                    OsString::from("--depth"),
                    OsString::from("1"),
                    OsString::from("--"),
                    OsString::from(git_url),
                    root.as_os_str().to_owned(),
                ],
                None,
                control,
                self.options.max_command_output,
            )?
        };
        Ok(SyncTreeSitterRegistryResult {
            path: path_string(&root),
            synced: output.success && registry_file.is_file(),
            message: Some(if output.success {
                "synced".into()
            } else {
                format!("registry sync failed: {}", output.message())
            }),
        })
    }

    pub fn install_tree_sitter_grammar(
        &self,
        params: &InstallTreeSitterGrammarParams,
        control: Option<&OperationControl>,
        mut progress: impl FnMut(&str),
    ) -> SyntaxResult<InstallTreeSitterGrammarResult> {
        validate_language_id(&params.language)?;
        let _gate = self
            .process_gate
            .lock()
            .map_err(|_| SyntaxError::LockPoisoned)?;
        progress("Resolving grammar metadata");
        let registry = self.registry()?;
        let Some(entry) = registry
            .languages
            .into_iter()
            .find(|entry| entry.id == params.language)
        else {
            return Ok(failed_install(&params.language, "language-not-in-registry"));
        };
        if entry.query_only {
            return Ok(failed_install(&params.language, "query-only-language"));
        }
        let Some(url) = entry.url.as_deref() else {
            return Ok(failed_install(&params.language, "grammar-url-missing"));
        };
        validate_git_url(url)?;
        let checkout = entry
            .revision
            .as_deref()
            .or(entry.branch.as_deref())
            .unwrap_or("HEAD");
        validate_git_ref(checkout)?;

        let install_dir = safe_grammar_path(&self.options.grammar_root, &params.language)?;
        let source_root = self
            .options
            .grammar_root
            .parent()
            .unwrap_or(&self.options.grammar_root)
            .join("sources");
        validate_managed_root(&source_root)?;
        let source_dir = safe_grammar_path(&source_root, &params.language)?;
        let parser_dir = match entry.location.as_deref() {
            Some(location) => safe_relative_join(&source_dir, location)?,
            None => source_dir.clone(),
        };
        let parser_path = install_dir.join(parser_file_name());

        progress("Preparing grammar directories");
        std::fs::create_dir_all(&self.options.grammar_root)?;
        std::fs::create_dir_all(&source_root)?;
        remove_managed_path(&source_dir)?;
        let default_control = OperationControl::new(self.options.command_timeout);
        let control = control.unwrap_or(&default_control);

        progress("Cloning grammar repository");
        let clone = run_process(
            OsStr::new("git"),
            &[
                OsString::from("-c"),
                OsString::from("protocol.file.allow=never"),
                OsString::from("clone"),
                OsString::from("--"),
                OsString::from(url),
                source_dir.as_os_str().to_owned(),
            ],
            None,
            control,
            self.options.max_command_output,
        )?;
        if !clone.success {
            return Ok(failed_install(
                &params.language,
                &format!("clone grammar repository failed: {}", clone.message()),
            ));
        }

        progress("Checking out grammar revision");
        let checkout_output = run_process(
            OsStr::new("git"),
            &[
                OsString::from("-C"),
                source_dir.as_os_str().to_owned(),
                OsString::from("checkout"),
                OsString::from("--detach"),
                OsString::from(checkout),
            ],
            None,
            control,
            self.options.max_command_output,
        )?;
        if !checkout_output.success {
            return Ok(failed_install(
                &params.language,
                &format!(
                    "checkout grammar revision failed: {}",
                    checkout_output.message()
                ),
            ));
        }

        if entry.generate || entry.build.as_ref().is_some_and(|build| build.generate) {
            progress("Generating parser source");
            let generated = run_process(
                OsStr::new("tree-sitter"),
                &[
                    OsString::from("generate"),
                    parser_dir.as_os_str().to_owned(),
                ],
                None,
                control,
                self.options.max_command_output,
            )?;
            if !generated.success {
                return Ok(failed_install(
                    &params.language,
                    &format!("generate parser source failed: {}", generated.message()),
                ));
            }
        }

        progress("Building parser library");
        ensure_managed_directory(&self.options.grammar_root, &install_dir)?;
        ensure_existing_within(&source_dir, &parser_dir)?;
        if std::fs::symlink_metadata(&parser_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(SyntaxError::UnsafePath(path_string(&parser_path)));
        }
        let built = run_process(
            OsStr::new("tree-sitter"),
            &[
                OsString::from("build"),
                OsString::from("-o"),
                parser_path.as_os_str().to_owned(),
                parser_dir.as_os_str().to_owned(),
            ],
            None,
            control,
            self.options.max_command_output,
        )?;
        if !built.success || !safe_regular_file(&self.options.grammar_root, &parser_path) {
            return Ok(failed_install(
                &params.language,
                &format!("build parser failed: {}", built.message()),
            ));
        }
        progress("Grammar installed");
        let query = self.query_path(&entry, QueryKind::Highlights)?;
        let highlights_installed = query
            .as_ref()
            .is_some_and(|path| safe_regular_file(&self.registry_root(), path));
        Ok(InstallTreeSitterGrammarResult {
            language: params.language.clone(),
            installed: true,
            grammar_path: Some(path_string(&parser_path)),
            highlights_query_path: highlights_installed
                .then(|| path_string(query.as_ref().expect("checked query"))),
            highlights_installed,
            message: Some(
                if highlights_installed {
                    "installed"
                } else {
                    "installed-without-highlights"
                }
                .into(),
            ),
        })
    }

    pub fn uninstall_tree_sitter_grammar(
        &self,
        params: &UninstallTreeSitterGrammarParams,
    ) -> SyntaxResult<UninstallTreeSitterGrammarResult> {
        validate_language_id(&params.language)?;
        let _gate = self
            .process_gate
            .lock()
            .map_err(|_| SyntaxError::LockPoisoned)?;
        let registry = self.registry()?;
        let Some(entry) = registry
            .languages
            .iter()
            .find(|entry| entry.id == params.language)
        else {
            return Ok(UninstallTreeSitterGrammarResult {
                language: params.language.clone(),
                uninstalled: false,
                message: Some("language-not-in-registry".into()),
            });
        };
        if entry.query_only {
            return Ok(UninstallTreeSitterGrammarResult {
                language: params.language.clone(),
                uninstalled: false,
                message: Some("query-only-language".into()),
            });
        }
        let install_dir = safe_grammar_path(&self.options.grammar_root, &params.language)?;
        let existed = std::fs::symlink_metadata(&install_dir).is_ok();
        remove_managed_path(&install_dir)?;
        Ok(UninstallTreeSitterGrammarResult {
            language: params.language.clone(),
            uninstalled: true,
            message: Some(
                if existed {
                    "uninstalled"
                } else {
                    "not-installed"
                }
                .into(),
            ),
        })
    }

    pub fn detect_status(&self, path: &Path) -> SyntaxResult<SyntaxStatus> {
        let registry = self.registry()?;
        let Some(language) = detect_language(path, &registry) else {
            return Ok(SyntaxStatus {
                missing_reason: Some("unsupported-language".into()),
                ..SyntaxStatus::default()
            });
        };
        validate_language_id(&language)?;
        let entry = registry.languages.iter().find(|entry| entry.id == language);
        let parser =
            safe_grammar_path(&self.options.grammar_root, &language)?.join(parser_file_name());
        let query = match entry {
            Some(entry) => self.query_path(entry, QueryKind::Highlights)?,
            None => self.default_query_path(&language, QueryKind::Highlights)?,
        };
        let grammar_installed = safe_regular_file(&self.options.grammar_root, &parser);
        let highlights_installed = query
            .as_ref()
            .is_some_and(|path| safe_regular_file(&self.registry_root(), path));
        Ok(SyntaxStatus {
            language: Some(language),
            grammar_installed,
            grammar_path: grammar_installed.then(|| path_string(&parser)),
            highlights_query_path: highlights_installed
                .then(|| path_string(query.as_ref().expect("checked query"))),
            highlights_installed,
            missing_reason: if !grammar_installed {
                Some("grammar-not-installed".into())
            } else if !highlights_installed {
                Some("highlights-query-not-installed".into())
            } else {
                None
            },
        })
    }

    fn registry(&self) -> SyntaxResult<Registry> {
        let root = self.registry_root();
        let path = root.join("registry.json");
        if path.is_file() {
            if !safe_regular_file(&root, &path) {
                return Err(SyntaxError::UnsafePath(path_string(&path)));
            }
            let bytes = read_limited(&path, MAX_REGISTRY_SIZE)?;
            return serde_json::from_slice(&bytes)
                .map_err(|error| SyntaxError::InvalidRegistry(error.to_string()));
        }
        serde_json::from_str(EMBEDDED_REGISTRY)
            .map_err(|error| SyntaxError::InvalidRegistry(error.to_string()))
    }

    fn registry_root(&self) -> PathBuf {
        self.options.registry_root.clone().unwrap_or_else(|| {
            self.options
                .grammar_root
                .parent()
                .unwrap_or(&self.options.grammar_root)
                .join("tree-sitter")
        })
    }

    fn query_path(
        &self,
        entry: &RegistryLanguage,
        kind: QueryKind,
    ) -> SyntaxResult<Option<PathBuf>> {
        let explicit = entry.queries.as_ref().and_then(|queries| match kind {
            QueryKind::Highlights => queries.highlights.as_ref(),
            QueryKind::Injections => queries.injections.as_ref(),
        });
        if let Some(query) = explicit {
            let path = safe_relative_join(&self.registry_root(), &query.path)?;
            if path.is_file() && std::fs::metadata(&path)?.len() <= MAX_QUERY_SIZE {
                if let Some(expected) = query.sha256.as_deref() {
                    let source = read_limited(&path, MAX_QUERY_SIZE)?;
                    if expected.len() != 64 || !hex_sha256(&source).eq_ignore_ascii_case(expected) {
                        return Ok(None);
                    }
                }
                return Ok(Some(path));
            }
            return Ok(None);
        }
        self.default_query_path(&entry.id, kind)
    }

    fn default_query_path(&self, language: &str, kind: QueryKind) -> SyntaxResult<Option<PathBuf>> {
        validate_language_id(language)?;
        let filename = match kind {
            QueryKind::Highlights => "highlights.scm",
            QueryKind::Injections => "injections.scm",
        };
        let path = self
            .registry_root()
            .join("queries")
            .join(language)
            .join(filename);
        if path.is_file() && std::fs::metadata(&path)?.len() <= MAX_QUERY_SIZE {
            Ok(Some(path))
        } else {
            Ok(None)
        }
    }
}

impl Default for SyntaxManager {
    fn default() -> Self {
        Self::from_environment().expect("default syntax roots are safe managed paths")
    }
}

fn parser_backend_from_environment() -> ParserBackend {
    if let Some(command) = std::env::var_os("DIFFUSE_SYNTAX_RUNNER")
        && !command.is_empty()
    {
        return ParserBackend::IsolatedExecutable {
            command: PathBuf::from(command),
            args: Vec::new(),
        };
    }

    ParserBackend::IsolatedExecutable {
        command: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("diffuse")),
        args: vec![OsString::from(SYNTAX_RUNNER_SUBCOMMAND)],
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default)]
    languages: Vec<RegistryLanguage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryLanguage {
    id: String,
    url: Option<String>,
    revision: Option<String>,
    branch: Option<String>,
    location: Option<String>,
    #[serde(default)]
    filetypes: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    query_only: bool,
    #[serde(default)]
    generate: bool,
    build: Option<RegistryBuild>,
    queries: Option<RegistryQueries>,
    #[serde(default)]
    requires: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryBuild {
    #[serde(default)]
    generate: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct RegistryQueries {
    highlights: Option<RegistryQueryFile>,
    injections: Option<RegistryQueryFile>,
}

#[derive(Clone, Debug, Deserialize)]
struct RegistryQueryFile {
    path: String,
    sha256: Option<String>,
}

#[derive(Clone, Copy)]
enum QueryKind {
    Highlights,
    #[allow(dead_code)]
    Injections,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParserRequest<'a> {
    language: &'a str,
    grammar_path: &'a str,
    highlights_query_path: &'a str,
    source: &'a str,
    start_line: u32,
    end_line: u32,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ParserResponse {
    Direct(Vec<SyntaxLineSpans>),
    Wrapped { spans: Vec<SyntaxLineSpans> },
}

struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl ProcessOutput {
    fn message(&self) -> String {
        let stderr = String::from_utf8_lossy(&self.stderr).trim().to_owned();
        if !stderr.is_empty() {
            return stderr;
        }
        String::from_utf8_lossy(&self.stdout).trim().to_owned()
    }
}

fn run_process(
    command: &OsStr,
    args: &[OsString],
    input: Option<Vec<u8>>,
    control: &OperationControl,
    output_limit: usize,
) -> SyntaxResult<ProcessOutput> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let writer = input.map(|input| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        thread::spawn(move || -> std::io::Result<()> {
            stdin.write_all(&input)?;
            stdin.flush()
        })
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_reader = thread::spawn(move || read_bounded(stdout, output_limit));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, output_limit));
    let deadline = Instant::now() + control.timeout;

    let status = loop {
        if control.cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            join_process_threads(writer, stdout_reader, stderr_reader)?;
            return Err(SyntaxError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            join_process_threads(writer, stdout_reader, stderr_reader)?;
            return Err(SyntaxError::Timeout);
        }
        thread::sleep(Duration::from_millis(20));
    };

    if let Some(writer) = writer {
        writer
            .join()
            .map_err(|_| SyntaxError::ParserFailed("stdin writer panicked".into()))??;
    }
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;
    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn join_process_threads(
    writer: Option<thread::JoinHandle<std::io::Result<()>>>,
    stdout: thread::JoinHandle<SyntaxResult<Vec<u8>>>,
    stderr: thread::JoinHandle<SyntaxResult<Vec<u8>>>,
) -> SyntaxResult<()> {
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let _ = join_reader(stdout);
    let _ = join_reader(stderr);
    Ok(())
}

fn join_reader(reader: thread::JoinHandle<SyntaxResult<Vec<u8>>>) -> SyntaxResult<Vec<u8>> {
    reader
        .join()
        .map_err(|_| SyntaxError::ParserFailed("output reader panicked".into()))?
}

fn read_bounded(mut reader: impl Read, limit: usize) -> SyntaxResult<Vec<u8>> {
    let mut result = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut exceeded = false;
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        if result.len().saturating_add(count) <= limit {
            result.extend_from_slice(&chunk[..count]);
        } else {
            exceeded = true;
        }
    }
    if exceeded {
        Err(SyntaxError::OutputTooLarge)
    } else {
        Ok(result)
    }
}

fn validate_spans(
    mut lines: Vec<SyntaxLineSpans>,
    start_line: u32,
    end_line: u32,
) -> SyntaxResult<Vec<SyntaxLineSpans>> {
    if lines.len() > 1_000_000 {
        return Err(SyntaxError::ParserFailed("too many span lines".into()));
    }
    for line in &mut lines {
        if line.line < start_line || line.line > end_line || line.spans.len() > 1_000_000 {
            return Err(SyntaxError::ParserFailed(
                "span outside requested range".into(),
            ));
        }
        for span in &line.spans {
            if span.end_column <= span.start_column
                || span.scope.is_empty()
                || span.scope.len() > 512
            {
                return Err(SyntaxError::ParserFailed("invalid syntax span".into()));
            }
        }
        line.spans
            .sort_by_key(|span| (span.start_column, span.end_column));
        line.spans.dedup();
    }
    lines.sort_by_key(|line| line.line);
    Ok(lines)
}

pub fn validate_language_id(language: &str) -> SyntaxResult<()> {
    if language.is_empty()
        || language.len() > 128
        || !language
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(SyntaxError::InvalidLanguage(language.into()));
    }
    Ok(())
}

/// Returns the managed language directory only after proving the language is a
/// single safe path segment.
pub fn safe_grammar_path(root: &Path, language: &str) -> SyntaxResult<PathBuf> {
    validate_managed_root(root)?;
    validate_language_id(language)?;
    Ok(root.join(language))
}

fn safe_relative_join(root: &Path, relative: &str) -> SyntaxResult<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(SyntaxError::UnsafePath(relative.into()));
    }
    let joined = root.join(relative_path);
    if joined == root {
        return Err(SyntaxError::UnsafePath(relative.into()));
    }
    Ok(joined)
}

fn validate_managed_root(root: &Path) -> SyntaxResult<()> {
    if root.as_os_str().is_empty()
        || root.parent().is_none()
        || root.file_name().is_none()
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(SyntaxError::UnsafePath(path_string(root)));
    }
    Ok(())
}

fn safe_regular_file(root: &Path, candidate: &Path) -> bool {
    if !candidate.is_file() {
        return false;
    }
    let Ok(root) = std::fs::canonicalize(root) else {
        return false;
    };
    let Ok(candidate) = std::fs::canonicalize(candidate) else {
        return false;
    };
    candidate.starts_with(root)
}

fn ensure_managed_directory(root: &Path, directory: &Path) -> SyntaxResult<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(directory)
        && metadata.file_type().is_symlink()
    {
        return Err(SyntaxError::UnsafePath(path_string(directory)));
    }
    std::fs::create_dir_all(directory)?;
    ensure_existing_within(root, directory)
}

fn ensure_existing_within(root: &Path, candidate: &Path) -> SyntaxResult<()> {
    let canonical_root = std::fs::canonicalize(root)?;
    let canonical_candidate = std::fs::canonicalize(candidate)?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(SyntaxError::UnsafePath(path_string(candidate)));
    }
    Ok(())
}

fn remove_managed_path(path: &Path) -> SyntaxResult<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(path)?;
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        return Err(SyntaxError::UnsafePath(path_string(path)));
    }
    Ok(())
}

fn validate_git_url(url: &str) -> SyntaxResult<()> {
    if url.is_empty()
        || url.starts_with('-')
        || url.bytes().any(|byte| byte.is_ascii_control())
        || !(url.starts_with("https://")
            || url.starts_with("http://")
            || url.starts_with("ssh://")
            || url.starts_with("git@"))
    {
        return Err(SyntaxError::InvalidRegistry("unsafe git URL".into()));
    }
    Ok(())
}

fn validate_git_ref(reference: &str) -> SyntaxResult<()> {
    if reference.is_empty()
        || reference.starts_with('-')
        || reference.contains("..")
        || reference.contains("@{")
        || reference.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
        })
    {
        return Err(SyntaxError::InvalidRegistry("unsafe git revision".into()));
    }
    Ok(())
}

fn detect_language(path: &Path, registry: &Registry) -> Option<String> {
    let basename = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or_default();
    for entry in &registry.languages {
        if entry.filenames.iter().any(|value| value == basename)
            || entry.filetypes.iter().any(|value| value == extension)
            || entry.aliases.iter().any(|value| value == extension)
            || entry.id == extension
        {
            return Some(entry.id.clone());
        }
    }
    let language = if basename == "Dockerfile" {
        "dockerfile"
    } else if basename == "Makefile" {
        "make"
    } else {
        match extension {
            "bash" | "sh" => "bash",
            "c" => "c",
            "cc" | "cpp" | "cxx" | "hpp" => "cpp",
            "css" => "css",
            "go" => "go",
            "html" => "html",
            "java" => "java",
            "js" | "jsx" | "mjs" | "cjs" => "javascript",
            "json" => "json",
            "md" | "markdown" => "markdown",
            "py" => "python",
            "rs" => "rust",
            "scss" => "scss",
            "ts" => "typescript",
            "tsx" => "tsx",
            "vue" => "vue",
            "yaml" | "yml" => "yaml",
            "zig" => "zig",
            _ => return None,
        }
    };
    Some(language.into())
}

fn parser_file_name() -> &'static str {
    if cfg!(windows) {
        "parser.dll"
    } else if cfg!(target_os = "macos") {
        "parser.dylib"
    } else {
        "parser.so"
    }
}

fn read_limited(path: &Path, limit: u64) -> SyntaxResult<Vec<u8>> {
    if std::fs::metadata(path)?.len() > limit {
        return Err(SyntaxError::InvalidRegistry(
            "registry file is too large".into(),
        ));
    }
    Ok(std::fs::read(path)?)
}

fn hex_sha256(input: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut hash = INITIAL;
    for chunk in padded.chunks_exact(64) {
        let mut words = [0_u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes(chunk[offset..offset + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = hash;
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (value, update) in hash.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *value = value.wrapping_add(update);
        }
    }
    use std::fmt::Write as _;
    let mut output = String::with_capacity(64);
    for value in hash {
        write!(output, "{value:08x}").unwrap();
    }
    output
}

fn failed_install(language: &str, message: &str) -> InstallTreeSitterGrammarResult {
    InstallTreeSitterGrammarResult {
        language: language.into(),
        installed: false,
        grammar_path: None,
        highlights_query_path: None,
        highlights_installed: false,
        message: Some(message.into()),
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    struct Document(SyntaxSourceDocument);

    impl SyntaxDocumentProvider for Document {
        fn resolve_syntax_document(
            &self,
            _params: &GetSyntaxSpansParams,
        ) -> SyntaxResult<SyntaxSourceDocument> {
            Ok(self.0.clone())
        }
    }

    fn manager(temp: &TempDir) -> SyntaxManager {
        SyntaxManager::new(SyntaxManagerOptions {
            grammar_root: temp.path().join("grammars"),
            registry_root: Some(temp.path().join("registry")),
            registry_git_url: None,
            parser_backend: ParserBackend::Unavailable,
            ..SyntaxManagerOptions::default()
        })
        .unwrap()
    }

    #[test]
    fn request_and_result_dtos_match_the_typescript_contract() {
        let params = GetSyntaxSpansParams {
            file_id: "src/main.rs".into(),
            side: SyntaxSide::New,
            start_line: 4,
            end_line: 8,
            options: SyntaxSpanOptions::default(),
            target: DiffTarget::default(),
        };
        let value = serde_json::to_value(params).unwrap();
        assert_eq!(value["fileId"], "src/main.rs");
        assert_eq!(value["startLine"], 4);
        assert_eq!(value["options"]["context"], "diff");
    }

    #[test]
    fn grammar_paths_reject_traversal_and_separators() {
        let root = Path::new(".diffuse/grammars");
        assert_eq!(
            safe_grammar_path(root, "markdown_inline").unwrap(),
            root.join("markdown_inline")
        );
        for invalid in ["", "..", "../rust", "/tmp/rust", "a/b", "a\\b", "."] {
            assert!(
                safe_grammar_path(root, invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        assert!(safe_relative_join(root, "../../outside").is_err());
        assert!(safe_relative_join(root, "/outside").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn managed_directories_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("grammars");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let language = root.join("rust");
        symlink(&outside, &language).unwrap();
        assert!(matches!(
            ensure_managed_directory(&root, &language),
            Err(SyntaxError::UnsafePath(_))
        ));
    }

    #[test]
    fn embedded_registry_lists_current_grammar_metadata() {
        let temp = TempDir::new().unwrap();
        let manager = manager(&temp);
        let grammars = manager
            .list_tree_sitter_grammars(&ListTreeSitterGrammarsParams {})
            .unwrap();
        let rust = grammars
            .iter()
            .find(|grammar| grammar.id == "rust")
            .unwrap();
        assert_eq!(
            rust.url.as_deref(),
            Some("https://github.com/tree-sitter/tree-sitter-rust")
        );
        assert!(!rust.installed);
        assert!(grammars.iter().all(|grammar| grammar.id != "ecma"));
    }

    #[test]
    fn registry_query_hashes_are_verified() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let temp = TempDir::new().unwrap();
        let manager = manager(&temp);
        let registry = manager.registry_root();
        let query = registry.join("queries/rust/highlights.scm");
        std::fs::create_dir_all(query.parent().unwrap()).unwrap();
        std::fs::write(&query, b"query").unwrap();
        std::fs::write(
            registry.join("registry.json"),
            r#"{"languages":[{"id":"rust","queries":{"highlights":{"path":"queries/rust/highlights.scm","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}}]}"#,
        )
        .unwrap();
        let grammars = manager
            .list_tree_sitter_grammars(&ListTreeSitterGrammarsParams {})
            .unwrap();
        assert!(!grammars[0].highlights_installed);
    }

    #[test]
    fn status_detects_installed_parser_and_registry_query() {
        let temp = TempDir::new().unwrap();
        let manager = manager(&temp);
        let parser = manager
            .options
            .grammar_root
            .join("rust")
            .join(parser_file_name());
        let query = manager.registry_root().join("queries/rust/highlights.scm");
        std::fs::create_dir_all(parser.parent().unwrap()).unwrap();
        std::fs::create_dir_all(query.parent().unwrap()).unwrap();
        std::fs::write(&parser, b"not loaded by this test").unwrap();
        std::fs::write(&query, b"(identifier) @variable").unwrap();
        let status = manager.detect_status(Path::new("src/main.rs")).unwrap();
        assert!(status.grammar_installed);
        assert!(status.highlights_installed);
        assert_eq!(status.language.as_deref(), Some("rust"));
    }

    #[test]
    fn installed_native_parser_is_not_loaded_without_isolated_runner() {
        let temp = TempDir::new().unwrap();
        let manager = manager(&temp);
        let parser = manager
            .options
            .grammar_root
            .join("rust")
            .join(parser_file_name());
        let query = manager.registry_root().join("queries/rust/highlights.scm");
        std::fs::create_dir_all(parser.parent().unwrap()).unwrap();
        std::fs::create_dir_all(query.parent().unwrap()).unwrap();
        std::fs::write(parser, b"untrusted native bytes").unwrap();
        std::fs::write(query, b"query").unwrap();
        let params = GetSyntaxSpansParams {
            file_id: "src/main.rs".into(),
            side: SyntaxSide::New,
            start_line: 1,
            end_line: 1,
            options: SyntaxSpanOptions::default(),
            target: DiffTarget::default(),
        };
        let document = Document(SyntaxSourceDocument {
            path: PathBuf::from("src/main.rs"),
            source: "fn main() {}".into(),
        });
        assert!(matches!(
            manager.get_syntax_spans(&params, &document, None),
            Err(SyntaxError::ParserUnavailable)
        ));
    }

    #[test]
    fn default_backend_invokes_the_current_executable_subcommand() {
        let backend = parser_backend_from_environment();
        if std::env::var_os("DIFFUSE_SYNTAX_RUNNER").is_none() {
            assert_eq!(
                backend,
                ParserBackend::IsolatedExecutable {
                    command: std::env::current_exe().unwrap(),
                    args: vec![OsString::from(SYNTAX_RUNNER_SUBCOMMAND)],
                }
            );
        }
    }

    #[test]
    fn environment_options_accept_an_explicit_parser_backend() {
        let options =
            SyntaxManagerOptions::from_environment_with_parser_backend(ParserBackend::Unavailable);

        assert_eq!(options.parser_backend, ParserBackend::Unavailable);
    }

    #[test]
    fn syntax_manager_invokes_an_isolated_child_runner() {
        let temp = TempDir::new().unwrap();
        let helper_source = temp.path().join("fake_syntax_runner.rs");
        let helper_binary = temp.path().join(if cfg!(windows) {
            "fake-syntax-runner.exe"
        } else {
            "fake-syntax-runner"
        });
        let marker = temp.path().join("request.json");
        std::fs::write(
            &helper_source,
            r##"
use std::io::Read;

fn main() {
    let marker = std::env::args_os().nth(1).expect("marker path");
    let mut request = String::new();
    std::io::stdin().read_to_string(&mut request).unwrap();
    assert!(request.contains("\"language\":\"rust\""));
    assert!(request.contains("\"startLine\":2"));
    std::fs::write(marker, request).unwrap();
    print!("{}", r#"[{"line":2,"spans":[{"startColumn":0,"endColumn":2,"scope":"keyword"}]}]"#);
}
"##,
        )
        .unwrap();
        let compiled = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg(&helper_source)
            .arg("-o")
            .arg(&helper_binary)
            .status()
            .unwrap();
        assert!(compiled.success());

        let grammar_root = temp.path().join("grammars");
        let registry_root = temp.path().join("registry");
        let parser = grammar_root.join("rust").join(parser_file_name());
        let query = registry_root.join("queries/rust/highlights.scm");
        std::fs::create_dir_all(parser.parent().unwrap()).unwrap();
        std::fs::create_dir_all(query.parent().unwrap()).unwrap();
        std::fs::write(parser, b"the fake child does not load this").unwrap();
        std::fs::write(query, b"(identifier) @variable").unwrap();

        let manager = SyntaxManager::new(SyntaxManagerOptions {
            grammar_root,
            registry_root: Some(registry_root),
            registry_git_url: None,
            parser_backend: ParserBackend::IsolatedExecutable {
                command: helper_binary,
                args: vec![marker.as_os_str().to_owned()],
            },
            ..SyntaxManagerOptions::default()
        })
        .unwrap();
        let params = GetSyntaxSpansParams {
            file_id: "src/main.rs".into(),
            side: SyntaxSide::New,
            start_line: 2,
            end_line: 2,
            options: SyntaxSpanOptions::default(),
            target: DiffTarget::default(),
        };
        let document = Document(SyntaxSourceDocument {
            path: PathBuf::from("src/main.rs"),
            source: "// first\nfn main() {}\n".into(),
        });

        assert_eq!(
            manager.get_syntax_spans(&params, &document, None).unwrap(),
            vec![SyntaxLineSpans {
                line: 2,
                spans: vec![SyntaxSpan {
                    start_column: 0,
                    end_column: 2,
                    scope: "keyword".into(),
                }],
            }]
        );
        let request = std::fs::read_to_string(marker).unwrap();
        assert!(request.contains("fn main() {}"));
    }

    #[test]
    fn parser_results_are_bounded_to_the_requested_lines() {
        let lines = vec![SyntaxLineSpans {
            line: 3,
            spans: vec![SyntaxSpan {
                start_column: 1,
                end_column: 4,
                scope: "function".into(),
            }],
        }];
        assert!(validate_spans(lines.clone(), 2, 4).is_ok());
        assert!(validate_spans(lines, 4, 5).is_err());
    }
}
