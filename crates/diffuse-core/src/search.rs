//! Deterministic search over changed files, source text, and review comments.
//!
//! The providers deliberately own the repository, diff, and review integration. This keeps the
//! search implementation usable while those modules are ported independently.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const DEFAULT_BATCH_SIZE: usize = 75;
pub const MAX_CONTENT_FILE_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_RESULTS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    All,
    Files,
    Content,
    Comments,
    Symbols,
}

impl SearchMode {
    fn includes_files(self) -> bool {
        matches!(self, Self::All | Self::Files)
    }

    fn includes_content(self) -> bool {
        matches!(self, Self::All | Self::Content)
    }

    fn includes_comments(self) -> bool {
        matches!(self, Self::All | Self::Comments)
    }
}

impl std::str::FromStr for SearchMode {
    type Err = SearchError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "all" => Ok(Self::All),
            "files" => Ok(Self::Files),
            "content" => Ok(Self::Content),
            "comments" => Ok(Self::Comments),
            "symbols" => Ok(Self::Symbols),
            _ => Err(SearchError::InvalidMode(value.to_owned())),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchFilterKind {
    Unviewed,
    Viewed,
    Commented,
    Unresolved,
    Generated,
    #[serde(rename = "test")]
    Tests,
    Docs,
    Renamed,
    Deleted,
}

impl std::str::FromStr for SearchFilterKind {
    type Err = SearchError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "unviewed" => Ok(Self::Unviewed),
            "viewed" => Ok(Self::Viewed),
            "commented" => Ok(Self::Commented),
            "unresolved" => Ok(Self::Unresolved),
            "generated" => Ok(Self::Generated),
            "test" => Ok(Self::Tests),
            "docs" => Ok(Self::Docs),
            "renamed" => Ok(Self::Renamed),
            "deleted" => Ok(Self::Deleted),
            _ => Err(SearchError::InvalidFilter(value.to_owned())),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedFilter {
    pub key: String,
    pub value: String,
    pub negated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedQuery {
    pub raw: String,
    pub terms: Vec<String>,
    pub phrases: Vec<String>,
    pub filters: Vec<ParsedFilter>,
}

impl ParsedQuery {
    pub fn has_text(&self) -> bool {
        !self.terms.is_empty() || !self.phrases.is_empty()
    }

    fn terms(&self) -> Vec<&str> {
        self.terms
            .iter()
            .chain(&self.phrases)
            .map(String::as_str)
            .collect()
    }

    fn comment_terms(&self) -> Vec<&str> {
        self.terms
            .iter()
            .chain(&self.phrases)
            .map(String::as_str)
            .chain(
                self.filters
                    .iter()
                    .filter(|filter| filter.key.eq_ignore_ascii_case("comment"))
                    .map(|filter| filter.value.as_str()),
            )
            .collect()
    }
}

/// Parses incomplete and unknown query syntax without rejecting the search.
pub fn parse_query(raw: impl Into<String>) -> ParsedQuery {
    let raw = raw.into();
    let mut terms = Vec::new();
    let mut phrases = Vec::new();
    let mut filters = Vec::new();
    let mut negate_next = false;

    for token in tokenize(raw.trim()) {
        if token.eq_ignore_ascii_case("NOT") {
            negate_next = true;
            continue;
        }

        let mut negated = negate_next;
        negate_next = false;
        let value = if let Some(value) = token.strip_prefix('-') {
            negated = true;
            value
        } else {
            token
        };

        if let Some((key, value)) = parse_filter(value) {
            filters.push(ParsedFilter {
                key: key.to_owned(),
                value: value.to_owned(),
                negated,
            });
        } else if value.len() > 1 && value.starts_with('"') && value.ends_with('"') {
            phrases.push(value[1..value.len() - 1].to_owned());
        } else {
            // Preserve malformed tokens exactly so an unfinished query remains searchable.
            terms.push(token.to_owned());
        }
    }

    ParsedQuery {
        raw,
        terms,
        phrases,
        filters,
    }
}

fn tokenize(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index == bytes.len() {
            break;
        }
        let start = index;
        let mut quoted = false;
        while index < bytes.len() {
            if bytes[index] == b'"' {
                quoted = !quoted;
            }
            if !quoted && bytes[index].is_ascii_whitespace() {
                break;
            }
            index += 1;
        }
        tokens.push(&value[start..index]);
    }
    tokens
}

fn parse_filter(token: &str) -> Option<(&str, &str)> {
    let separator = token.find(':')?;
    if separator == 0 || separator + 1 == token.len() {
        return None;
    }
    let key = &token[..separator];
    if !key.as_bytes()[0].is_ascii_alphabetic()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    Some((key, &token[separator + 1..]))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangedFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangedFileStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub status: ChangedFileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub signature: String,
}

impl ChangedFile {
    pub fn path(&self) -> &str {
        self.new_path
            .as_deref()
            .or(self.old_path.as_deref())
            .unwrap_or(&self.id)
    }

    pub fn source_side(&self) -> SyntaxSide {
        if self.status == ChangedFileStatus::Deleted {
            SyntaxSide::Old
        } else {
            SyntaxSide::New
        }
    }

    pub fn source_path(&self, side: SyntaxSide) -> &str {
        match side {
            SyntaxSide::Old => self.old_path.as_deref().unwrap_or(&self.id),
            SyntaxSide::New => self.new_path.as_deref().unwrap_or(&self.id),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyntaxSide {
    Old,
    New,
}

impl SyntaxSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Old => "old",
            Self::New => "new",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewCommentStatus {
    Open,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub file_id: String,
    pub status: ReviewCommentStatus,
    /// The complete review anchor object expected by the TypeScript protocol.
    pub anchor: Value,
    /// Message bodies joined with one space, matching `threadSearchText`.
    pub body: String,
    /// The complete review thread object expected by the TypeScript protocol.
    pub thread: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub reviewed_file_ids: Vec<String>,
    pub comments: Vec<ReviewComment>,
}

pub trait ChangedFilesProvider: Send + Sync {
    fn changed_files(&self) -> Result<Vec<ChangedFile>, SearchError>;
}

pub trait SourceTextProvider: Send + Sync {
    /// Returns source bytes for the requested diff side. Missing and unreadable sources are skipped.
    fn source_text(
        &self,
        file: &ChangedFile,
        side: SyntaxSide,
    ) -> Result<Option<Vec<u8>>, SearchError>;
}

pub trait ReviewCommentsProvider: Send + Sync {
    fn review_snapshot(&self, session_id: &str) -> Result<ReviewSnapshot, SearchError>;
}

pub trait SearchDataSource:
    ChangedFilesProvider + SourceTextProvider + ReviewCommentsProvider
{
}

impl<T> SearchDataSource for T where
    T: ChangedFilesProvider + SourceTextProvider + ReviewCommentsProvider
{
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMetadata {
    pub reviewed: bool,
    pub comment_count: u32,
    pub unresolved_count: u32,
    pub generated: bool,
    #[serde(rename = "test")]
    pub is_test: bool,
    pub docs: bool,
}

pub fn classify_file(
    file: &ChangedFile,
    reviewed: bool,
    comment_count: u32,
    unresolved_count: u32,
) -> FileSearchMetadata {
    let path = file.path();
    let name = file_name(path);
    let extension = extension(path);
    let generated = path_has_any_segment(
        path,
        &[
            "node_modules",
            "vendor",
            "dist",
            "build",
            "target",
            "coverage",
            ".next",
            ".nuxt",
        ],
    ) || string_in_set(
        name,
        &[
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "Cargo.lock",
            "Gopkg.lock",
            "Pipfile.lock",
        ],
    ) || ends_with_ignore_ascii_case(path, ".min.js")
        || ends_with_ignore_ascii_case(path, ".min.css")
        || ends_with_ignore_ascii_case(path, ".map")
        || ends_with_ignore_ascii_case(path, ".generated.go")
        || ends_with_ignore_ascii_case(path, ".pb.go");
    let docs = path_has_segment(path, "docs")
        || extension.eq_ignore_ascii_case("md")
        || extension.eq_ignore_ascii_case("rst")
        || extension.eq_ignore_ascii_case("adoc")
        || string_in_set(
            strip_extension(name),
            &["readme", "changelog", "license", "contributing"],
        );
    let is_test = path_has_any_segment(path, &["test", "tests", "__tests__", "spec", "specs"])
        || [".test.", ".spec.", "_test.", "_spec.", "-test.", "-spec."]
            .iter()
            .any(|needle| contains_ignore_ascii_case(name, needle));

    FileSearchMetadata {
        reviewed,
        comment_count,
        unresolved_count,
        generated,
        is_test,
        docs,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchField {
    Name,
    Path,
    Body,
    Symbol,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFieldMatch {
    pub field: SearchField,
    pub ranges: Vec<SearchMatchRange>,
    pub score: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchResult {
    File {
        id: String,
        #[serde(rename = "fileId")]
        file_id: String,
        path: String,
        title: String,
        subtitle: String,
        rank: i64,
        matches: Vec<SearchFieldMatch>,
        name: String,
        file: ChangedFile,
        metadata: FileSearchMetadata,
    },
    Comment {
        id: String,
        #[serde(rename = "fileId")]
        file_id: String,
        path: String,
        title: String,
        subtitle: String,
        rank: i64,
        matches: Vec<SearchFieldMatch>,
        #[serde(rename = "threadId")]
        thread_id: String,
        status: ReviewCommentStatus,
        anchor: Value,
        body: String,
        thread: Value,
    },
    Content {
        id: String,
        #[serde(rename = "fileId")]
        file_id: String,
        path: String,
        title: String,
        subtitle: String,
        rank: i64,
        matches: Vec<SearchFieldMatch>,
        side: SyntaxSide,
        line: u32,
        preview: String,
    },
}

impl SearchResult {
    pub fn id(&self) -> &str {
        match self {
            Self::File { id, .. } | Self::Comment { id, .. } | Self::Content { id, .. } => id,
        }
    }

    pub fn rank(&self) -> i64 {
        match self {
            Self::File { rank, .. } | Self::Comment { rank, .. } | Self::Content { rank, .. } => {
                *rank
            }
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Self::File { path, .. } | Self::Comment { path, .. } | Self::Content { path, .. } => {
                path
            }
        }
    }

    pub fn line(&self) -> u32 {
        match self {
            Self::Comment { anchor, .. } => anchor
                .get("startLine")
                .and_then(Value::as_u64)
                .and_then(|line| u32::try_from(line).ok())
                .unwrap_or(0),
            Self::Content { line, .. } => *line,
            Self::File { .. } => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStarted {
    pub search_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub search_id: String,
    pub results: Vec<SearchResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub search_id: String,
    pub scanned_files: u32,
    pub total_files: u32,
    pub emitted_results: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDone {
    pub search_id: String,
    pub total_results: u32,
    pub scanned_files: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCancelled {
    pub search_id: String,
    pub scanned_files: u32,
    pub emitted_results: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFailed {
    pub search_id: String,
    pub message: String,
}

/// Serializes directly to the TypeScript core event `method`/`params` shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum SearchEvent {
    #[serde(rename = "search/started")]
    Started(SearchStarted),
    #[serde(rename = "search/results")]
    Results(SearchResults),
    #[serde(rename = "search/progress")]
    Progress(SearchProgress),
    #[serde(rename = "search/done")]
    Done(SearchDone),
    #[serde(rename = "search/cancelled")]
    Cancelled(SearchCancelled),
    #[serde(rename = "search/error")]
    Error(SearchFailed),
}

pub trait SearchEventSink: Send + Sync {
    fn send(&self, event: SearchEvent) -> Result<(), SearchError>;
}

impl<F> SearchEventSink for F
where
    F: Fn(SearchEvent) -> Result<(), SearchError> + Send + Sync,
{
    fn send(&self, event: SearchEvent) -> Result<(), SearchError> {
        self(event)
    }
}

#[derive(Clone)]
pub struct BoundedSearchEventSender {
    sender: SyncSender<SearchEvent>,
}

impl SearchEventSink for BoundedSearchEventSender {
    fn send(&self, event: SearchEvent) -> Result<(), SearchError> {
        self.sender
            .send(event)
            .map_err(|_| SearchError::EventChannelClosed)
    }
}

pub fn bounded_event_channel(capacity: usize) -> (BoundedSearchEventSender, Receiver<SearchEvent>) {
    assert!(capacity > 0, "search event capacity must be positive");
    let (sender, receiver) = sync_channel(capacity);
    (BoundedSearchEventSender { sender }, receiver)
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn is_same_token(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchLimits {
    pub batch_size: usize,
    pub max_content_file_bytes: usize,
    /// Global result cap across all search phases.
    pub max_results: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_BATCH_SIZE,
            max_content_file_bytes: MAX_CONTENT_FILE_BYTES,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    pub search_id: String,
    pub session_id: String,
    pub query: String,
    pub mode: SearchMode,
    pub filters: Vec<SearchFilterKind>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchStats {
    pub total_files: u32,
    pub scanned_files: u32,
    pub emitted_results: u32,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SearchError {
    #[error("invalid search mode: {0}")]
    InvalidMode(String),
    #[error("invalid search filter: {0}")]
    InvalidFilter(String),
    #[error("search ID must not be empty")]
    InvalidSearchId,
    #[error("search ID is already active: {0}")]
    DuplicateSearchId(String),
    #[error("search provider failed: {0}")]
    Provider(String),
    #[error("{0}")]
    Protocol(String),
    #[error("search event channel closed")]
    EventChannelClosed,
}

impl SearchError {
    pub fn provider(error: impl fmt::Display) -> Self {
        Self::Provider(error.to_string())
    }
}

#[derive(Default)]
pub struct SearchCoordinator {
    jobs: Mutex<HashMap<String, CancellationToken>>,
    jobs_changed: Condvar,
    limits: SearchLimits,
}

#[derive(Debug)]
pub struct SearchReservation {
    search_id: String,
    token: CancellationToken,
}

struct SearchCompletion<'a> {
    coordinator: &'a SearchCoordinator,
    search_id: String,
    token: CancellationToken,
}

impl Drop for SearchCompletion<'_> {
    fn drop(&mut self) {
        self.coordinator.finish(&self.search_id, &self.token);
    }
}

impl SearchCoordinator {
    pub fn new(limits: SearchLimits) -> Self {
        assert!(limits.batch_size > 0, "search batch size must be positive");
        Self {
            jobs: Mutex::new(HashMap::new()),
            jobs_changed: Condvar::new(),
            limits,
        }
    }

    /// Reserves an ID synchronously so cancellation is effective before a worker is spawned.
    pub fn reserve(&self, search_id: &str) -> Result<SearchReservation, SearchError> {
        if search_id.trim().is_empty() {
            return Err(SearchError::InvalidSearchId);
        }
        let token = CancellationToken::default();
        let mut jobs = self.jobs.lock().expect("search jobs lock poisoned");
        if jobs.contains_key(search_id) {
            return Err(SearchError::DuplicateSearchId(search_id.to_owned()));
        }
        jobs.insert(search_id.to_owned(), token.clone());
        Ok(SearchReservation {
            search_id: search_id.to_owned(),
            token,
        })
    }

    /// Runs synchronously. Callers should place this on their blocking worker pool.
    pub fn run(
        &self,
        request: SearchRequest,
        source: &dyn SearchDataSource,
        sink: &dyn SearchEventSink,
    ) -> Result<SearchStats, SearchError> {
        let reservation = self.reserve(&request.search_id)?;
        self.run_reserved(request, reservation, source, sink)
    }

    /// Runs a job whose ID was synchronously reserved by [`Self::reserve`].
    pub fn run_reserved(
        &self,
        request: SearchRequest,
        reservation: SearchReservation,
        source: &dyn SearchDataSource,
        sink: &dyn SearchEventSink,
    ) -> Result<SearchStats, SearchError> {
        let completion = SearchCompletion {
            coordinator: self,
            search_id: reservation.search_id,
            token: reservation.token,
        };
        if request.search_id != completion.search_id {
            return Err(SearchError::InvalidSearchId);
        }
        execute_search(&request, source, sink, &completion.token, self.limits)
    }

    pub fn cancel(&self, search_id: &str) -> bool {
        let jobs = self.jobs.lock().expect("search jobs lock poisoned");
        let Some(token) = jobs.get(search_id) else {
            return false;
        };
        token.cancel();
        true
    }

    pub fn is_active(&self, search_id: &str) -> bool {
        self.jobs
            .lock()
            .expect("search jobs lock poisoned")
            .contains_key(search_id)
    }

    pub fn cancel_all(&self) {
        let jobs = self.jobs.lock().expect("search jobs lock poisoned");
        for token in jobs.values() {
            token.cancel();
        }
    }

    pub fn wait_for_all(&self) {
        let mut jobs = self.jobs.lock().expect("search jobs lock poisoned");
        while !jobs.is_empty() {
            jobs = self
                .jobs_changed
                .wait(jobs)
                .expect("search jobs lock poisoned while waiting");
        }
    }

    pub fn shutdown(&self) {
        self.cancel_all();
        self.wait_for_all();
    }

    fn finish(&self, search_id: &str, token: &CancellationToken) {
        let mut jobs = self.jobs.lock().expect("search jobs lock poisoned");
        if jobs
            .get(search_id)
            .is_some_and(|current| current.is_same_token(token))
        {
            jobs.remove(search_id);
            self.jobs_changed.notify_all();
        }
    }
}

pub fn execute_search(
    request: &SearchRequest,
    source: &dyn SearchDataSource,
    sink: &dyn SearchEventSink,
    cancellation: &CancellationToken,
    limits: SearchLimits,
) -> Result<SearchStats, SearchError> {
    assert!(limits.batch_size > 0, "search batch size must be positive");
    let mut stats = SearchStats::default();
    sink.send(SearchEvent::Started(SearchStarted {
        search_id: request.search_id.clone(),
    }))?;

    let run = run_phases(request, source, sink, cancellation, limits, &mut stats);
    match run {
        Ok(()) if cancellation.is_cancelled() => {
            sink.send(cancelled_event(request, stats))?;
            Ok(stats)
        }
        Ok(()) => {
            sink.send(SearchEvent::Done(SearchDone {
                search_id: request.search_id.clone(),
                total_results: stats.emitted_results,
                scanned_files: stats.scanned_files,
            }))?;
            Ok(stats)
        }
        Err(PhaseError::Cancelled) => {
            sink.send(cancelled_event(request, stats))?;
            Ok(stats)
        }
        Err(PhaseError::Failed(error)) => {
            sink.send(SearchEvent::Error(SearchFailed {
                search_id: request.search_id.clone(),
                message: error.to_string(),
            }))?;
            Err(error)
        }
    }
}

fn cancelled_event(request: &SearchRequest, stats: SearchStats) -> SearchEvent {
    SearchEvent::Cancelled(SearchCancelled {
        search_id: request.search_id.clone(),
        scanned_files: stats.scanned_files,
        emitted_results: stats.emitted_results,
    })
}

#[derive(Debug)]
enum PhaseError {
    Cancelled,
    Failed(SearchError),
}

impl From<SearchError> for PhaseError {
    fn from(error: SearchError) -> Self {
        Self::Failed(error)
    }
}

fn run_phases(
    request: &SearchRequest,
    source: &dyn SearchDataSource,
    sink: &dyn SearchEventSink,
    cancellation: &CancellationToken,
    limits: SearchLimits,
    stats: &mut SearchStats,
) -> Result<(), PhaseError> {
    if cancellation.is_cancelled() {
        return Err(PhaseError::Cancelled);
    }
    let files = source.changed_files()?;
    stats.total_files = count_u32(files.len());
    if cancellation.is_cancelled() {
        return Err(PhaseError::Cancelled);
    }
    let review = if request.session_id.is_empty() {
        ReviewSnapshot::default()
    } else {
        source.review_snapshot(&request.session_id)?
    };
    if cancellation.is_cancelled() {
        return Err(PhaseError::Cancelled);
    }
    let index = ReviewIndex::new(&review, cancellation)?;
    let query = parse_query(request.query.clone());
    let terms = query.terms();
    let comment_terms = query.comment_terms();

    if request.mode.includes_files() {
        let phase_limit = remaining_results(limits, stats);
        let mut results = Vec::new();
        for file in &files {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            let metadata = index.metadata(file);
            if results.len() < phase_limit
                && let Some(result) =
                    build_file_result(file, metadata, &query, &terms, &request.filters, &index)
            {
                results.push(result);
            }
        }
        emit_phase(results, request, sink, cancellation, limits, stats)?;
    }

    if request.mode.includes_content() {
        let phase_limit = remaining_results(limits, stats);
        let mut results = Vec::new();
        for file in &files {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            stats.scanned_files = stats.scanned_files.saturating_add(1);
            let metadata = index.metadata(file);
            if file_passes_filters(
                file,
                metadata,
                &query.filters,
                &request.filters,
                &index,
                false,
            ) {
                let side = file.source_side();
                // The Zig source reader treats individual source failures as an unavailable file.
                if results.len() < phase_limit
                    && let Ok(Some(text)) = source.source_text(file, side)
                {
                    results.extend(build_content_results(
                        file,
                        metadata,
                        &text,
                        side,
                        &terms,
                        SearchLimits {
                            max_results: phase_limit.saturating_sub(results.len()),
                            ..limits
                        },
                        cancellation,
                    )?);
                }
            }
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            sink.send(SearchEvent::Progress(SearchProgress {
                search_id: request.search_id.clone(),
                scanned_files: stats.scanned_files,
                total_files: stats.total_files,
                emitted_results: stats.emitted_results,
            }))?;
        }
        emit_phase(results, request, sink, cancellation, limits, stats)?;
    }

    if request.mode.includes_comments() {
        if cancellation.is_cancelled() {
            return Err(PhaseError::Cancelled);
        }
        let mut files_by_id = HashMap::with_capacity(files.len());
        for file in &files {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            files_by_id.insert(file.id.as_str(), file);
        }
        let phase_limit = remaining_results(limits, stats);
        let mut results = Vec::new();
        for comment in &review.comments {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            let Some(file) = files_by_id.get(comment.file_id.as_str()) else {
                continue;
            };
            let metadata = index.metadata(file);
            if results.len() < phase_limit
                && let Some(result) = build_comment_result(
                    comment,
                    file,
                    metadata,
                    &query,
                    &comment_terms,
                    &request.filters,
                    &index,
                )
            {
                results.push(result);
            }
        }
        emit_phase(results, request, sink, cancellation, limits, stats)?;
    }

    // Symbols intentionally have no phase until the LSP port supplies a provider.
    Ok(())
}

fn emit_phase(
    mut results: Vec<SearchResult>,
    request: &SearchRequest,
    sink: &dyn SearchEventSink,
    cancellation: &CancellationToken,
    limits: SearchLimits,
    stats: &mut SearchStats,
) -> Result<(), PhaseError> {
    results.sort_by(|left, right| {
        right
            .rank()
            .cmp(&left.rank())
            .then_with(|| left.path().cmp(right.path()))
            .then_with(|| left.line().cmp(&right.line()))
    });
    let remaining = limits
        .max_results
        .saturating_sub(stats.emitted_results as usize);
    results.truncate(remaining);

    for batch in results.chunks(limits.batch_size) {
        if cancellation.is_cancelled() {
            return Err(PhaseError::Cancelled);
        }
        sink.send(SearchEvent::Results(SearchResults {
            search_id: request.search_id.clone(),
            results: batch.to_vec(),
        }))?;
        stats.emitted_results = stats.emitted_results.saturating_add(count_u32(batch.len()));
    }
    Ok(())
}

fn remaining_results(limits: SearchLimits, stats: &SearchStats) -> usize {
    limits
        .max_results
        .saturating_sub(stats.emitted_results as usize)
}

struct ReviewIndex<'a> {
    reviewed: HashSet<&'a str>,
    comments_by_file: HashMap<&'a str, Vec<&'a ReviewComment>>,
}

impl<'a> ReviewIndex<'a> {
    fn new(
        review: &'a ReviewSnapshot,
        cancellation: &CancellationToken,
    ) -> Result<Self, PhaseError> {
        let mut reviewed = HashSet::with_capacity(review.reviewed_file_ids.len());
        for file_id in &review.reviewed_file_ids {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            reviewed.insert(file_id.as_str());
        }
        let mut comments_by_file: HashMap<&str, Vec<&ReviewComment>> = HashMap::new();
        for comment in &review.comments {
            if cancellation.is_cancelled() {
                return Err(PhaseError::Cancelled);
            }
            comments_by_file
                .entry(&comment.file_id)
                .or_default()
                .push(comment);
        }
        Ok(Self {
            reviewed,
            comments_by_file,
        })
    }

    fn metadata(&self, file: &ChangedFile) -> FileSearchMetadata {
        let comments = self
            .comments_by_file
            .get(file.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        classify_file(
            file,
            self.reviewed.contains(file.id.as_str()),
            count_u32(comments.len()),
            count_u32(
                comments
                    .iter()
                    .filter(|comment| comment.status == ReviewCommentStatus::Open)
                    .count(),
            ),
        )
    }

    fn comment_text_matches(&self, file_id: &str, value: &str) -> bool {
        self.comments_by_file.get(file_id).is_some_and(|comments| {
            comments
                .iter()
                .any(|comment| match_text(&comment.body, &[value]).matched)
        })
    }
}

fn build_file_result(
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    query: &ParsedQuery,
    terms: &[&str],
    active_filters: &[SearchFilterKind],
    review: &ReviewIndex<'_>,
) -> Option<SearchResult> {
    if !file_passes_filters(
        file,
        metadata,
        &query.filters,
        active_filters,
        review,
        false,
    ) {
        return None;
    }
    let path = file.path();
    let name = file_name(path);
    let mut matches = Vec::new();
    if let Some(result) = field_match(SearchField::Name, name, terms, 500) {
        matches.push(result);
    }
    if let Some(result) = field_match(SearchField::Path, path, terms, 160) {
        matches.push(result);
    }
    if !terms.is_empty() && matches.is_empty() {
        return None;
    }

    let metadata_boost = if metadata.unresolved_count > 0 {
        140
    } else if metadata.comment_count > 0 {
        80
    } else {
        0
    };
    let review_boost = if metadata.reviewed { 0 } else { 45 };
    let generated_penalty =
        if metadata.generated && !has_generated_filter(&query.filters, active_filters) {
            260
        } else {
            0
        };
    let rank = matches.iter().map(|item| item.score).sum::<i64>() + metadata_boost + review_boost
        - generated_penalty;
    Some(SearchResult::File {
        id: format!("file:{}", file.id),
        file_id: file.id.clone(),
        path: path.to_owned(),
        title: name.to_owned(),
        subtitle: path.to_owned(),
        rank,
        matches,
        name: name.to_owned(),
        file: file.clone(),
        metadata,
    })
}

fn build_comment_result(
    comment: &ReviewComment,
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    query: &ParsedQuery,
    terms: &[&str],
    active_filters: &[SearchFilterKind],
    review: &ReviewIndex<'_>,
) -> Option<SearchResult> {
    if terms.is_empty()
        && !active_filters.contains(&SearchFilterKind::Commented)
        && !active_filters.contains(&SearchFilterKind::Unresolved)
    {
        return None;
    }
    if !file_passes_filters(file, metadata, &query.filters, active_filters, review, true) {
        return None;
    }
    let path = file.path();
    let name = file_name(path);
    let mut matches = Vec::new();
    if let Some(result) = field_match(SearchField::Body, &comment.body, terms, 320) {
        matches.push(result);
    }
    if let Some(result) = field_match(SearchField::Path, path, terms, 100) {
        matches.push(result);
    }
    if !terms.is_empty() && matches.is_empty() {
        return None;
    }
    let rank = matches.iter().map(|item| item.score).sum::<i64>()
        + if comment.status == ReviewCommentStatus::Open {
            220
        } else {
            80
        };
    Some(SearchResult::Comment {
        id: format!("comment:{}", comment.id),
        file_id: file.id.clone(),
        path: path.to_owned(),
        title: name.to_owned(),
        subtitle: if comment.body.is_empty() {
            path.to_owned()
        } else {
            comment.body.clone()
        },
        rank,
        matches,
        thread_id: comment.id.clone(),
        status: comment.status,
        anchor: comment.anchor.clone(),
        body: comment.body.clone(),
        thread: comment.thread.clone(),
    })
}

fn build_content_results(
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    source: &[u8],
    side: SyntaxSide,
    terms: &[&str],
    limits: SearchLimits,
    cancellation: &CancellationToken,
) -> Result<Vec<SearchResult>, PhaseError> {
    if terms.is_empty()
        || source.is_empty()
        || source.len() > limits.max_content_file_bytes
        || source.contains(&0)
    {
        return Ok(Vec::new());
    }
    let Ok(source) = std::str::from_utf8(source) else {
        return Ok(Vec::new());
    };
    let path = file.path();
    let name = file_name(path);
    let mut results = Vec::new();
    for (index, raw_line) in source.split('\n').enumerate() {
        if cancellation.is_cancelled() {
            return Err(PhaseError::Cancelled);
        }
        if results.len() == limits.max_results {
            break;
        }
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let Some(result) = match_content_line(line, terms) else {
            continue;
        };
        let preview = content_preview(line, &result.ranges);
        let line_number = count_u32(index.saturating_add(1));
        let rank = result.score + if metadata.reviewed { 0 } else { 20 };
        results.push(SearchResult::Content {
            id: format!(
                "content:{}:{}:{}:{}",
                file.id,
                side.as_str(),
                line_number,
                results.len()
            ),
            file_id: file.id.clone(),
            path: path.to_owned(),
            title: name.to_owned(),
            subtitle: format!("{path}:{line_number}"),
            rank,
            matches: vec![SearchFieldMatch {
                field: SearchField::Body,
                ranges: preview.ranges,
                score: result.score,
            }],
            side,
            line: line_number,
            preview: preview.text,
        });
    }
    Ok(results)
}

fn file_passes_filters(
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    query_filters: &[ParsedFilter],
    active_filters: &[SearchFilterKind],
    review: &ReviewIndex<'_>,
    skip_comment_filter: bool,
) -> bool {
    if active_filters
        .iter()
        .any(|filter| !file_passes_filter_kind(file, metadata, *filter))
    {
        return false;
    }
    query_filters.iter().all(|filter| {
        if skip_comment_filter && filter.key.eq_ignore_ascii_case("comment") {
            return true;
        }
        let passes = file_passes_query_filter(file, metadata, filter, review);
        if filter.negated { !passes } else { passes }
    })
}

fn file_passes_filter_kind(
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    filter: SearchFilterKind,
) -> bool {
    match filter {
        SearchFilterKind::Unviewed => !metadata.reviewed,
        SearchFilterKind::Viewed => metadata.reviewed,
        SearchFilterKind::Commented => metadata.comment_count > 0,
        SearchFilterKind::Unresolved => metadata.unresolved_count > 0,
        SearchFilterKind::Generated => metadata.generated,
        SearchFilterKind::Tests => metadata.is_test,
        SearchFilterKind::Docs => metadata.docs,
        SearchFilterKind::Renamed => file.status == ChangedFileStatus::Renamed,
        SearchFilterKind::Deleted => file.status == ChangedFileStatus::Deleted,
    }
}

fn file_passes_query_filter(
    file: &ChangedFile,
    metadata: FileSearchMetadata,
    filter: &ParsedFilter,
    review: &ReviewIndex<'_>,
) -> bool {
    let key = filter.key.as_str();
    let value = filter.value.as_str();
    if key.eq_ignore_ascii_case("is") {
        return file_passes_is_filter(file, metadata, value);
    }
    if key.eq_ignore_ascii_case("status") {
        return file.status.as_str().eq_ignore_ascii_case(value);
    }
    if key.eq_ignore_ascii_case("ext") {
        return extension(file.path()).eq_ignore_ascii_case(value.trim_start_matches('.'));
    }
    if key.eq_ignore_ascii_case("lang") {
        return language_matches_extension(value, extension(file.path()));
    }
    if key.eq_ignore_ascii_case("path") {
        return contains_ignore_ascii_case(file.path(), value);
    }
    if key.eq_ignore_ascii_case("file") {
        return contains_ignore_ascii_case(file_name(file.path()), value);
    }
    if key.eq_ignore_ascii_case("changes") {
        return compare_number(file.additions.saturating_add(file.deletions), value);
    }
    if key.eq_ignore_ascii_case("added") {
        return compare_number(file.additions, value);
    }
    if key.eq_ignore_ascii_case("deleted") {
        return compare_number(file.deletions, value);
    }
    if key.eq_ignore_ascii_case("comment") {
        return review.comment_text_matches(&file.id, value);
    }
    contains_ignore_ascii_case(file.path(), value)
        || file.status.as_str().eq_ignore_ascii_case(value)
}

fn file_passes_is_filter(file: &ChangedFile, metadata: FileSearchMetadata, value: &str) -> bool {
    if value.eq_ignore_ascii_case("unviewed") || value.eq_ignore_ascii_case("unreviewed") {
        return !metadata.reviewed;
    }
    if value.eq_ignore_ascii_case("viewed") || value.eq_ignore_ascii_case("reviewed") {
        return metadata.reviewed;
    }
    if value.eq_ignore_ascii_case("commented") || value.eq_ignore_ascii_case("comments") {
        return metadata.comment_count > 0;
    }
    if value.eq_ignore_ascii_case("unresolved") {
        return metadata.unresolved_count > 0;
    }
    if value.eq_ignore_ascii_case("generated") {
        return metadata.generated;
    }
    if value.eq_ignore_ascii_case("test") || value.eq_ignore_ascii_case("tests") {
        return metadata.is_test;
    }
    if value.eq_ignore_ascii_case("doc") || value.eq_ignore_ascii_case("docs") {
        return metadata.docs;
    }
    [
        ("renamed", ChangedFileStatus::Renamed),
        ("deleted", ChangedFileStatus::Deleted),
        ("added", ChangedFileStatus::Added),
        ("modified", ChangedFileStatus::Modified),
    ]
    .iter()
    .any(|(name, status)| value.eq_ignore_ascii_case(name) && file.status == *status)
}

fn has_generated_filter(filters: &[ParsedFilter], active_filters: &[SearchFilterKind]) -> bool {
    active_filters.contains(&SearchFilterKind::Generated)
        || filters.iter().any(|filter| {
            filter.key.eq_ignore_ascii_case("is") && filter.value.eq_ignore_ascii_case("generated")
        })
}

fn compare_number(actual: u32, expression: &str) -> bool {
    let expression = expression.trim();
    let (operator, number) = if let Some(number) = expression.strip_prefix(">=") {
        (">=", number)
    } else if let Some(number) = expression.strip_prefix("<=") {
        ("<=", number)
    } else if let Some(number) = expression.strip_prefix('>') {
        (">", number)
    } else if let Some(number) = expression.strip_prefix('<') {
        ("<", number)
    } else {
        ("=", expression)
    };
    let Ok(expected) = number.parse::<u32>() else {
        return false;
    };
    match operator {
        ">" => actual > expected,
        ">=" => actual >= expected,
        "<" => actual < expected,
        "<=" => actual <= expected,
        _ => actual == expected,
    }
}

fn language_matches_extension(language: &str, extension: &str) -> bool {
    let aliases: &[&str] = if language.eq_ignore_ascii_case("javascript") {
        &["js", "jsx", "mjs", "cjs"]
    } else if language.eq_ignore_ascii_case("typescript") {
        &["ts", "tsx"]
    } else if language.eq_ignore_ascii_case("vue") {
        &["vue"]
    } else if language.eq_ignore_ascii_case("markdown") {
        &["md", "markdown"]
    } else if language.eq_ignore_ascii_case("python") {
        &["py"]
    } else if language.eq_ignore_ascii_case("rust") {
        &["rs"]
    } else if language.eq_ignore_ascii_case("go") {
        &["go"]
    } else if language.eq_ignore_ascii_case("zig") {
        &["zig"]
    } else if language.eq_ignore_ascii_case("shell") {
        &["sh", "bash", "zsh"]
    } else {
        return language.eq_ignore_ascii_case(extension);
    };
    aliases
        .iter()
        .any(|alias| extension.eq_ignore_ascii_case(alias))
}

#[derive(Debug)]
struct TextMatch {
    matched: bool,
    score: i64,
    ranges: Vec<SearchMatchRange>,
}

fn field_match(
    field: SearchField,
    value: &str,
    terms: &[&str],
    boost: i64,
) -> Option<SearchFieldMatch> {
    let result = match_text(value, terms);
    result.matched.then_some(SearchFieldMatch {
        field,
        ranges: result.ranges,
        score: result.score + boost,
    })
}

fn match_text(value: &str, terms: &[&str]) -> TextMatch {
    let mut score = 0;
    let mut ranges = Vec::new();
    let mut meaningful_terms = 0;
    for term in terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
    {
        meaningful_terms += 1;
        let result = match_single_term(value, term);
        if !result.matched {
            return TextMatch {
                matched: false,
                score: 0,
                ranges: Vec::new(),
            };
        }
        score += result.score;
        ranges.extend(result.ranges);
    }
    TextMatch {
        matched: meaningful_terms == 0 || !ranges.is_empty(),
        score,
        ranges: merge_ranges(ranges),
    }
}

fn match_single_term(value: &str, term: &str) -> TextMatch {
    if term.is_empty() {
        return TextMatch {
            matched: true,
            score: 0,
            ranges: Vec::new(),
        };
    }
    let lower_value = value.to_ascii_lowercase();
    let lower_term = term.to_ascii_lowercase();
    if let Some(index) = lower_value.find(&lower_term) {
        let prefix_boost = if index == 0 { 800 } else { 0 };
        let boundary_boost = if index > 0 && is_boundary(value.as_bytes()[index - 1]) {
            240
        } else {
            0
        };
        return TextMatch {
            matched: true,
            score: 1600 + prefix_boost + boundary_boost - index as i64,
            ranges: vec![SearchMatchRange {
                start: index,
                end: index + term.len(),
            }],
        };
    }
    if let Some(ranges) = word_initial_ranges(value, lower_term.as_bytes()) {
        return TextMatch {
            matched: true,
            score: 980,
            ranges,
        };
    }
    fuzzy_match(value, lower_term.as_bytes())
}

fn word_initial_ranges(value: &str, term: &[u8]) -> Option<Vec<SearchMatchRange>> {
    let lower_value = value.to_ascii_lowercase();
    let bytes = lower_value.as_bytes();
    let mut ranges = Vec::new();
    let mut term_index = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if term_index == term.len() {
            break;
        }
        if index > 0 && !is_boundary(value.as_bytes()[index - 1]) {
            continue;
        }
        if *byte == term[term_index] {
            ranges.push(SearchMatchRange {
                start: index,
                end: index + 1,
            });
            term_index += 1;
        }
    }
    (term_index == term.len()).then_some(ranges)
}

fn fuzzy_match(value: &str, term: &[u8]) -> TextMatch {
    let lower_value = value.to_ascii_lowercase();
    let bytes = lower_value.as_bytes();
    let mut ranges = Vec::new();
    let mut value_index = 0;
    let mut last_match = None;
    let mut gap_penalty = 0i64;
    for needle in term {
        let Some(relative) = bytes[value_index..]
            .iter()
            .position(|candidate| candidate == needle)
        else {
            return TextMatch {
                matched: false,
                score: 0,
                ranges: Vec::new(),
            };
        };
        let found = value_index + relative;
        if let Some(last) = last_match {
            gap_penalty += (found - last - 1) as i64;
        }
        ranges.push(SearchMatchRange {
            start: found,
            end: found + 1,
        });
        value_index = found + 1;
        last_match = Some(found);
    }
    TextMatch {
        matched: true,
        score: 120.max(620 - gap_penalty * 8),
        ranges: merge_ranges(ranges),
    }
}

fn match_content_line(text: &str, terms: &[&str]) -> Option<TextMatch> {
    let lower_text = text.to_ascii_lowercase();
    let mut ranges = Vec::new();
    let mut score = 0;
    let mut meaningful_terms = 0;
    for term in terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
    {
        meaningful_terms += 1;
        let lower_term = term.to_ascii_lowercase();
        let before = ranges.len();
        let mut search_from = 0;
        while search_from < lower_text.len() {
            let Some(relative) = lower_text[search_from..].find(&lower_term) else {
                break;
            };
            let found = search_from + relative;
            ranges.push(SearchMatchRange {
                start: found,
                end: found + term.len(),
            });
            search_from = found + term.len();
        }
        if ranges.len() == before {
            return None;
        }
        score += 1200 - ranges[before].start as i64 + ((ranges.len() - before).min(8) * 30) as i64;
    }
    (meaningful_terms > 0).then(|| TextMatch {
        matched: true,
        score,
        ranges: merge_ranges(ranges),
    })
}

struct Preview {
    text: String,
    ranges: Vec<SearchMatchRange>,
}

fn content_preview(text: &str, ranges: &[SearchMatchRange]) -> Preview {
    const PREVIEW_LENGTH: usize = 150;
    const PREFIX_LENGTH: usize = 48;
    let first = ranges.first().map(|range| range.start).unwrap_or(0);
    let requested_start = first.saturating_sub(PREFIX_LENGTH);
    let start = floor_char_boundary(text, requested_start);
    let end = floor_char_boundary(text, (start + PREVIEW_LENGTH).min(text.len()));
    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < text.len() { "..." } else { "" };
    let mut preview_ranges = Vec::new();
    for range in ranges {
        let range_start = start.max(range.start);
        let range_end = end.min(range.end);
        if range_end > range_start {
            preview_ranges.push(SearchMatchRange {
                start: range_start - start + prefix.len(),
                end: range_end - start + prefix.len(),
            });
        }
    }
    Preview {
        text: format!("{prefix}{}{suffix}", &text[start..end]),
        ranges: preview_ranges,
    }
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn merge_ranges(mut ranges: Vec<SearchMatchRange>) -> Vec<SearchMatchRange> {
    ranges.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<SearchMatchRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn extension(path: &str) -> &str {
    let name = file_name(path);
    let Some(index) = name.rfind('.') else {
        return "";
    };
    if index == 0 { "" } else { &name[index + 1..] }
}

fn strip_extension(name: &str) -> &str {
    name.rfind('.').map_or(name, |index| &name[..index])
}

fn path_has_segment(path: &str, needle: &str) -> bool {
    path.split('/')
        .any(|segment| segment.eq_ignore_ascii_case(needle))
}

fn path_has_any_segment(path: &str, segments: &[&str]) -> bool {
    segments
        .iter()
        .any(|segment| path_has_segment(path, segment))
}

fn string_in_set(value: &str, values: &[&str]) -> bool {
    values.iter().any(|item| value.eq_ignore_ascii_case(item))
}

fn contains_ignore_ascii_case(value: &str, needle: &str) -> bool {
    value
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn ends_with_ignore_ascii_case(value: &str, suffix: &str) -> bool {
    value
        .get(value.len().saturating_sub(suffix.len())..)
        .is_some_and(|end| end.eq_ignore_ascii_case(suffix))
}

fn is_boundary(byte: u8) -> bool {
    matches!(byte, b'/' | b'-' | b'_' | b'.' | b' ')
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Condvar;
    use std::thread;

    use serde_json::json;

    use super::*;

    fn file(id: &str, status: ChangedFileStatus) -> ChangedFile {
        ChangedFile {
            id: id.to_owned(),
            old_path: (status != ChangedFileStatus::Added).then(|| id.to_owned()),
            new_path: (status != ChangedFileStatus::Deleted).then(|| id.to_owned()),
            status,
            additions: 3,
            deletions: 2,
            signature: format!("signature:{id}"),
        }
    }

    fn comment(id: &str, file_id: &str, body: &str, status: ReviewCommentStatus) -> ReviewComment {
        ReviewComment {
            id: id.to_owned(),
            file_id: file_id.to_owned(),
            status,
            anchor: json!({
                "side": "new",
                "startLine": 2,
                "endLine": 2,
                "diffTargetFingerprint": "fixture"
            }),
            body: body.to_owned(),
            thread: json!({ "id": id, "fileId": file_id, "messages": [{ "body": body }] }),
        }
    }

    #[derive(Default)]
    struct FixtureSource {
        files: Vec<ChangedFile>,
        sources: HashMap<String, Result<Option<Vec<u8>>, SearchError>>,
        review: ReviewSnapshot,
        fail_files: bool,
        fail_review: bool,
    }

    impl ChangedFilesProvider for FixtureSource {
        fn changed_files(&self) -> Result<Vec<ChangedFile>, SearchError> {
            if self.fail_files {
                Err(SearchError::provider("changed files unavailable"))
            } else {
                Ok(self.files.clone())
            }
        }
    }

    impl SourceTextProvider for FixtureSource {
        fn source_text(
            &self,
            file: &ChangedFile,
            _side: SyntaxSide,
        ) -> Result<Option<Vec<u8>>, SearchError> {
            self.sources.get(&file.id).cloned().unwrap_or(Ok(None))
        }
    }

    impl ReviewCommentsProvider for FixtureSource {
        fn review_snapshot(&self, _session_id: &str) -> Result<ReviewSnapshot, SearchError> {
            if self.fail_review {
                Err(SearchError::provider("review unavailable"))
            } else {
                Ok(self.review.clone())
            }
        }
    }

    #[derive(Default)]
    struct EventLog(Mutex<Vec<SearchEvent>>);

    impl SearchEventSink for EventLog {
        fn send(&self, event: SearchEvent) -> Result<(), SearchError> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }

    impl EventLog {
        fn events(&self) -> Vec<SearchEvent> {
            self.0.lock().unwrap().clone()
        }
    }

    fn request(query: &str, mode: SearchMode) -> SearchRequest {
        SearchRequest {
            search_id: "search-fixture".to_owned(),
            session_id: "review-fixture".to_owned(),
            query: query.to_owned(),
            mode,
            filters: Vec::new(),
        }
    }

    #[test]
    fn parser_is_forgiving_and_handles_phrases_and_negation() {
        let parsed = parse_query(
            " button \"review agent\" -is:generated NOT path:vendor broken: -plain \"open",
        );
        assert_eq!(
            parsed.raw,
            " button \"review agent\" -is:generated NOT path:vendor broken: -plain \"open"
        );
        assert_eq!(parsed.terms, ["button", "broken:", "-plain", "\"open"]);
        assert_eq!(parsed.phrases, ["review agent"]);
        assert_eq!(
            parsed.filters,
            [
                ParsedFilter {
                    key: "is".to_owned(),
                    value: "generated".to_owned(),
                    negated: true,
                },
                ParsedFilter {
                    key: "path".to_owned(),
                    value: "vendor".to_owned(),
                    negated: true,
                },
            ]
        );
    }

    #[test]
    fn mode_and_filter_protocol_values_are_strict() {
        assert_eq!("symbols".parse(), Ok(SearchMode::Symbols));
        assert_eq!("test".parse(), Ok(SearchFilterKind::Tests));
        assert!(matches!(
            "unknown".parse::<SearchMode>(),
            Err(SearchError::InvalidMode(_))
        ));
        assert_eq!(
            serde_json::to_value(SearchFilterKind::Tests).unwrap(),
            "test"
        );
    }

    #[test]
    fn metadata_classifies_generated_docs_tests_and_review_state() {
        let generated = classify_file(
            &file("vendor/app.min.js", ChangedFileStatus::Modified),
            false,
            0,
            0,
        );
        let docs = classify_file(
            &file("docs/README", ChangedFileStatus::Modified),
            true,
            2,
            1,
        );
        let test = classify_file(
            &file("src/widget.spec.ts", ChangedFileStatus::Modified),
            false,
            0,
            0,
        );
        assert!(generated.generated);
        assert!(docs.docs && docs.reviewed);
        assert_eq!((docs.comment_count, docs.unresolved_count), (2, 1));
        assert!(test.is_test);
        assert_eq!(serde_json::to_value(test).unwrap()["test"], true);
    }

    #[test]
    fn text_matching_supports_exact_initial_and_fuzzy_ranking() {
        let exact = match_text("PullCommentRow", &["Pull"]);
        let initials = match_text("PullCommentRow", &["pcr"]);
        let fuzzy = match_text("PullCommentRow", &["plrw"]);
        assert!(exact.matched && initials.matched && fuzzy.matched);
        assert!(exact.score > initials.score && initials.score > fuzzy.score);
        assert_eq!(initials.ranges.len(), 3);
        assert!(!match_text("PullCommentRow", &["xyz"]).matched);
    }

    #[test]
    fn query_filters_cover_metadata_paths_languages_counts_and_comments() {
        let changed = file("tests/widget.ts", ChangedFileStatus::Modified);
        let review = ReviewSnapshot {
            reviewed_file_ids: vec![changed.id.clone()],
            comments: vec![comment(
                "thread-1",
                &changed.id,
                "needs cleanup",
                ReviewCommentStatus::Open,
            )],
        };
        let index = ReviewIndex::new(&review, &CancellationToken::default()).unwrap();
        let metadata = index.metadata(&changed);
        for query in [
            "is:reviewed",
            "is:test",
            "lang:typescript",
            "ext:.ts",
            "path:widget",
            "file:widget",
            "changes:5",
            "added:>=3",
            "deleted:<3",
            "comment:cleanup",
        ] {
            let parsed = parse_query(query);
            assert!(
                file_passes_filters(&changed, metadata, &parsed.filters, &[], &index, false),
                "filter should pass: {query}"
            );
        }
        let parsed = parse_query("-path:tests");
        assert!(!file_passes_filters(
            &changed,
            metadata,
            &parsed.filters,
            &[],
            &index,
            false
        ));
    }

    #[test]
    fn result_and_event_serialization_match_typescript_shapes() {
        let changed = file("src/main.ts", ChangedFileStatus::Modified);
        let metadata = classify_file(&changed, false, 0, 0);
        let query = parse_query("main");
        let terms = query.terms();
        let review = ReviewSnapshot::default();
        let index = ReviewIndex::new(&review, &CancellationToken::default()).unwrap();
        let result = build_file_result(&changed, metadata, &query, &terms, &[], &index).unwrap();
        let value = serde_json::to_value(SearchEvent::Results(SearchResults {
            search_id: "explicit-id".to_owned(),
            results: vec![result],
        }))
        .unwrap();
        assert_eq!(value["method"], "search/results");
        assert_eq!(value["params"]["searchId"], "explicit-id");
        assert_eq!(value["params"]["results"][0]["kind"], "file");
        assert_eq!(value["params"]["results"][0]["fileId"], "src/main.ts");
        assert!(
            value["params"]["results"][0]["metadata"]
                .get("commentCount")
                .is_some()
        );
    }

    #[test]
    fn content_search_skips_empty_binary_invalid_and_oversized_sources() {
        let changed = file("src/main.ts", ChangedFileStatus::Modified);
        let metadata = classify_file(&changed, false, 0, 0);
        assert!(
            build_content_results(
                &changed,
                metadata,
                b"",
                SyntaxSide::New,
                &["x"],
                SearchLimits {
                    max_content_file_bytes: 10,
                    max_results: usize::MAX,
                    ..SearchLimits::default()
                },
                &CancellationToken::default(),
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            build_content_results(
                &changed,
                metadata,
                b"x\0",
                SyntaxSide::New,
                &["x"],
                SearchLimits {
                    max_content_file_bytes: 10,
                    max_results: usize::MAX,
                    ..SearchLimits::default()
                },
                &CancellationToken::default(),
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            build_content_results(
                &changed,
                metadata,
                &[0xff],
                SyntaxSide::New,
                &["x"],
                SearchLimits {
                    max_content_file_bytes: 10,
                    max_results: usize::MAX,
                    ..SearchLimits::default()
                },
                &CancellationToken::default(),
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            build_content_results(
                &changed,
                metadata,
                b"answer",
                SyntaxSide::New,
                &["answer"],
                SearchLimits {
                    max_content_file_bytes: 3,
                    max_results: usize::MAX,
                    ..SearchLimits::default()
                },
                &CancellationToken::default(),
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn content_results_have_stable_lines_ids_previews_and_old_side() {
        let mut changed = file("docs/removed.md", ChangedFileStatus::Deleted);
        changed.new_path = None;
        let metadata = classify_file(&changed, false, 0, 0);
        let long_line = format!("{}answer at the end", "prefix ".repeat(12));
        let results = build_content_results(
            &changed,
            metadata,
            format!("first\r\n{long_line}\n").as_bytes(),
            changed.source_side(),
            &["answer"],
            SearchLimits {
                max_results: usize::MAX,
                ..SearchLimits::default()
            },
            &CancellationToken::default(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id(), "content:docs/removed.md:old:2:0");
        let SearchResult::Content {
            line,
            side,
            preview,
            matches,
            ..
        } = &results[0]
        else {
            panic!("expected content result");
        };
        assert_eq!((*line, *side), (2, SyntaxSide::Old));
        assert!(preview.starts_with("...") && preview.contains("answer"));
        assert_eq!(
            &preview[matches[0].ranges[0].start..matches[0].ranges[0].end],
            "answer"
        );
    }

    #[test]
    fn pipeline_emits_deterministic_phases_batches_progress_and_terminal_event() {
        let files = vec![
            file("src/z-answer.ts", ChangedFileStatus::Modified),
            file("src/answer.ts", ChangedFileStatus::Modified),
        ];
        let source = FixtureSource {
            sources: HashMap::from([
                (
                    files[0].id.clone(),
                    Ok(Some(b"const answer = 1;\n".to_vec())),
                ),
                (
                    files[1].id.clone(),
                    Ok(Some(b"const answer = 2;\n".to_vec())),
                ),
            ]),
            review: ReviewSnapshot {
                reviewed_file_ids: vec![files[0].id.clone()],
                comments: vec![comment(
                    "thread-1",
                    &files[1].id,
                    "answer concern",
                    ReviewCommentStatus::Open,
                )],
            },
            files,
            ..FixtureSource::default()
        };
        let events = EventLog::default();
        let stats = execute_search(
            &request("answer", SearchMode::All),
            &source,
            &events,
            &CancellationToken::default(),
            SearchLimits {
                batch_size: 1,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(
            (
                stats.total_files,
                stats.scanned_files,
                stats.emitted_results
            ),
            (2, 2, 5)
        );

        let events = events.events();
        assert!(matches!(events.first(), Some(SearchEvent::Started(_))));
        assert!(matches!(
            events.last(),
            Some(SearchEvent::Done(SearchDone {
                total_results: 5,
                ..
            }))
        ));
        let result_ids = events
            .iter()
            .filter_map(|event| match event {
                SearchEvent::Results(batch) => Some(batch.results[0].id()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            result_ids,
            [
                "file:src/answer.ts",
                "file:src/z-answer.ts",
                "content:src/answer.ts:new:1:0",
                "content:src/z-answer.ts:new:1:0",
                "comment:thread-1",
            ]
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, SearchEvent::Progress(_)))
                .count(),
            2
        );
    }

    #[test]
    fn global_result_limit_keeps_best_results_in_phase_order() {
        let source = FixtureSource {
            files: vec![
                file("src/answer.ts", ChangedFileStatus::Modified),
                file("src/other-answer.ts", ChangedFileStatus::Modified),
            ],
            ..FixtureSource::default()
        };
        let events = EventLog::default();
        let stats = execute_search(
            &request("answer", SearchMode::All),
            &source,
            &events,
            &CancellationToken::default(),
            SearchLimits {
                max_results: 1,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(stats.emitted_results, 1);
        let ids = events
            .events()
            .into_iter()
            .flat_map(|event| match event {
                SearchEvent::Results(results) => results.results,
                _ => Vec::new(),
            })
            .map(|result| result.id().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["file:src/answer.ts"]);
    }

    #[test]
    fn symbols_mode_has_no_results_but_completes() {
        let source = FixtureSource {
            files: vec![file("src/main.ts", ChangedFileStatus::Modified)],
            ..FixtureSource::default()
        };
        let events = EventLog::default();
        let stats = execute_search(
            &request("main", SearchMode::Symbols),
            &source,
            &events,
            &CancellationToken::default(),
            SearchLimits::default(),
        )
        .unwrap();
        assert_eq!(stats.total_files, 1);
        assert_eq!(stats.emitted_results, 0);
        assert!(matches!(events.events().last(), Some(SearchEvent::Done(_))));
    }

    #[test]
    fn provider_failure_emits_error_terminal_event() {
        let source = FixtureSource {
            fail_files: true,
            ..FixtureSource::default()
        };
        let events = EventLog::default();
        let error = execute_search(
            &request("answer", SearchMode::All),
            &source,
            &events,
            &CancellationToken::default(),
            SearchLimits::default(),
        )
        .unwrap_err();
        assert!(matches!(error, SearchError::Provider(_)));
        assert!(matches!(
            events.events().last(),
            Some(SearchEvent::Error(_))
        ));
    }

    #[test]
    fn source_failure_is_skipped_and_search_still_completes() {
        let changed = file("src/main.ts", ChangedFileStatus::Modified);
        let source = FixtureSource {
            sources: HashMap::from([(
                changed.id.clone(),
                Err(SearchError::provider("source unavailable")),
            )]),
            files: vec![changed],
            ..FixtureSource::default()
        };
        let events = EventLog::default();
        execute_search(
            &request("answer", SearchMode::Content),
            &source,
            &events,
            &CancellationToken::default(),
            SearchLimits::default(),
        )
        .unwrap();
        assert!(matches!(events.events().last(), Some(SearchEvent::Done(_))));
    }

    #[test]
    fn cancellation_emits_cancelled_instead_of_done() {
        struct CancellingSource {
            token: CancellationToken,
            files: Vec<ChangedFile>,
        }
        impl ChangedFilesProvider for CancellingSource {
            fn changed_files(&self) -> Result<Vec<ChangedFile>, SearchError> {
                Ok(self.files.clone())
            }
        }
        impl SourceTextProvider for CancellingSource {
            fn source_text(
                &self,
                _file: &ChangedFile,
                _side: SyntaxSide,
            ) -> Result<Option<Vec<u8>>, SearchError> {
                self.token.cancel();
                Ok(Some(b"answer\n".to_vec()))
            }
        }
        impl ReviewCommentsProvider for CancellingSource {
            fn review_snapshot(&self, _session_id: &str) -> Result<ReviewSnapshot, SearchError> {
                Ok(ReviewSnapshot::default())
            }
        }

        let token = CancellationToken::default();
        let source = CancellingSource {
            token: token.clone(),
            files: vec![
                file("src/one.ts", ChangedFileStatus::Modified),
                file("src/two.ts", ChangedFileStatus::Modified),
            ],
        };
        let events = EventLog::default();
        let stats = execute_search(
            &request("answer", SearchMode::Content),
            &source,
            &events,
            &token,
            SearchLimits::default(),
        )
        .unwrap();
        assert_eq!(stats.scanned_files, 1);
        assert!(matches!(
            events.events().last(),
            Some(SearchEvent::Cancelled(_))
        ));
        assert!(
            !events
                .events()
                .iter()
                .any(|event| matches!(event, SearchEvent::Done(_)))
        );
    }

    #[test]
    fn coordinator_registers_explicit_ids_and_supports_cross_thread_cancellation() {
        struct BlockingSource {
            state: Arc<(Mutex<(bool, bool)>, Condvar)>,
        }
        impl ChangedFilesProvider for BlockingSource {
            fn changed_files(&self) -> Result<Vec<ChangedFile>, SearchError> {
                let (lock, condition) = &*self.state;
                let mut state = lock.lock().unwrap();
                state.0 = true;
                condition.notify_one();
                while !state.1 {
                    state = condition.wait(state).unwrap();
                }
                Ok(vec![file("src/main.ts", ChangedFileStatus::Modified)])
            }
        }
        impl SourceTextProvider for BlockingSource {
            fn source_text(
                &self,
                _file: &ChangedFile,
                _side: SyntaxSide,
            ) -> Result<Option<Vec<u8>>, SearchError> {
                Ok(None)
            }
        }
        impl ReviewCommentsProvider for BlockingSource {
            fn review_snapshot(&self, _session_id: &str) -> Result<ReviewSnapshot, SearchError> {
                Ok(ReviewSnapshot::default())
            }
        }

        let coordinator = Arc::new(SearchCoordinator::default());
        let state = Arc::new((Mutex::new((false, false)), Condvar::new()));
        let source = Arc::new(BlockingSource {
            state: state.clone(),
        });
        let worker_coordinator = coordinator.clone();
        let worker = thread::spawn(move || {
            let events = EventLog::default();
            let result =
                worker_coordinator.run(request("main", SearchMode::Files), &*source, &events);
            (result, events.events())
        });
        let (lock, condition) = &*state;
        let mut ready = lock.lock().unwrap();
        while !ready.0 {
            ready = condition.wait(ready).unwrap();
        }
        assert!(coordinator.is_active("search-fixture"));
        assert!(coordinator.cancel("search-fixture"));
        ready.1 = true;
        condition.notify_one();
        drop(ready);
        let (result, events) = worker.join().unwrap();
        result.unwrap();
        assert!(matches!(events.last(), Some(SearchEvent::Cancelled(_))));
        assert!(!coordinator.is_active("search-fixture"));
        assert!(!coordinator.cancel("search-fixture"));
    }

    #[test]
    fn coordinator_rejects_empty_and_duplicate_ids() {
        let coordinator = SearchCoordinator::default();
        let source = FixtureSource::default();
        let events = EventLog::default();
        let mut empty = request("", SearchMode::Files);
        empty.search_id = " ".to_owned();
        assert_eq!(
            coordinator.run(empty, &source, &events),
            Err(SearchError::InvalidSearchId)
        );

        let reservation = coordinator.reserve("search-fixture").unwrap();
        assert_eq!(
            coordinator.reserve("search-fixture").unwrap_err(),
            SearchError::DuplicateSearchId("search-fixture".to_owned())
        );
        coordinator
            .run_reserved(
                request("", SearchMode::Files),
                reservation,
                &source,
                &events,
            )
            .unwrap();
    }

    #[test]
    fn reserved_search_can_be_cancelled_before_worker_starts() {
        let coordinator = SearchCoordinator::default();
        let reservation = coordinator.reserve("search-fixture").unwrap();
        assert!(coordinator.cancel("search-fixture"));

        let events = EventLog::default();
        coordinator
            .run_reserved(
                request("answer", SearchMode::All),
                reservation,
                &FixtureSource::default(),
                &events,
            )
            .unwrap();
        coordinator.wait_for_all();

        assert!(matches!(
            events.events().first(),
            Some(SearchEvent::Started(_))
        ));
        assert!(matches!(
            events.events().last(),
            Some(SearchEvent::Cancelled(_))
        ));
        assert!(!coordinator.is_active("search-fixture"));
    }

    #[test]
    fn bounded_event_channel_delivers_events_and_reports_closed_receiver() {
        let (sender, receiver) = bounded_event_channel(1);
        sender
            .send(SearchEvent::Started(SearchStarted {
                search_id: "bounded".to_owned(),
            }))
            .unwrap();
        assert!(matches!(receiver.recv().unwrap(), SearchEvent::Started(_)));
        drop(receiver);
        assert_eq!(
            sender.send(SearchEvent::Done(SearchDone {
                search_id: "bounded".to_owned(),
                total_results: 0,
                scanned_files: 0,
            })),
            Err(SearchError::EventChannelClosed)
        );
    }
}
