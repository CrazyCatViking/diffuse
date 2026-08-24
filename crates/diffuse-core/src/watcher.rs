use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

const REPOSITORY_CHANGED: &str = "repository/changed";
const REVIEW_CHANGED: &str = "review/changed";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RepositoryWatcherStatus {
    #[default]
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepositoryWatchEvent {
    RepositoryChanged { root: PathBuf, paths: Vec<String> },
    ReviewChanged { root: PathBuf, paths: Vec<String> },
    RescanRequired { root: PathBuf },
    Stopped { root: PathBuf },
}

impl RepositoryWatchEvent {
    pub fn method(&self) -> Option<&'static str> {
        match self {
            Self::RepositoryChanged { .. } => Some(REPOSITORY_CHANGED),
            Self::ReviewChanged { .. } => Some(REVIEW_CHANGED),
            Self::RescanRequired { .. } | Self::Stopped { .. } => None,
        }
    }

    pub fn root(&self) -> &Path {
        match self {
            Self::RepositoryChanged { root, .. }
            | Self::ReviewChanged { root, .. }
            | Self::RescanRequired { root }
            | Self::Stopped { root } => root,
        }
    }

    pub fn paths(&self) -> Option<&[String]> {
        match self {
            Self::RepositoryChanged { paths, .. } | Self::ReviewChanged { paths, .. } => {
                Some(paths)
            }
            Self::RescanRequired { .. } | Self::Stopped { .. } => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RepositoryWatcherConfig {
    pub poll_interval: Duration,
    pub debounce: Duration,
    pub channel_capacity: usize,
    pub max_batch_paths: usize,
}

impl Default for RepositoryWatcherConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(250),
            debounce: Duration::from_millis(500),
            channel_capacity: 32,
            max_batch_paths: 4096,
        }
    }
}

impl RepositoryWatcherConfig {
    fn validate(&self) -> io::Result<()> {
        if self.poll_interval.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "repository watcher poll interval must be positive",
            ));
        }
        if self.channel_capacity < 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "repository watcher channel capacity must be at least two",
            ));
        }
        if self.max_batch_paths == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "repository watcher path limit must be positive",
            ));
        }
        Ok(())
    }
}

pub struct RepositoryWatcher {
    root: PathBuf,
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}

impl RepositoryWatcher {
    pub fn start(
        root: impl AsRef<Path>,
        config: RepositoryWatcherConfig,
    ) -> io::Result<(Self, RepositoryWatchReceiver)> {
        config.validate()?;
        let root = dunce::canonicalize(root)?;
        if !fs::metadata(&root)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "repository watcher root must be a directory",
            ));
        }

        let shared = Arc::new(Shared::new(config.channel_capacity));
        let callback_shared = shared.clone();
        let callback_root = root.clone();
        let backend_config = notify::Config::default().with_poll_interval(config.poll_interval);
        let mut backend = RecommendedWatcher::new(
            move |result| {
                if let Some(event) = normalize_backend_event(&callback_root, result) {
                    callback_shared.enqueue_backend(event);
                }
            },
            backend_config,
        )
        .map_err(notify_error_to_io)?;
        watch_nonignored_tree(&mut backend, &root)?;

        let worker_shared = shared.clone();
        let worker_root = root.clone();
        let worker = thread::Builder::new()
            .name("diffuse-repository-watcher".to_owned())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    watch_repository(worker_root.clone(), backend, config, &worker_shared);
                }));
                finish_worker(&worker_shared, worker_root, result);
            })?;

        Ok((
            Self {
                root,
                shared: shared.clone(),
                worker: Some(worker),
            },
            RepositoryWatchReceiver { shared },
        ))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn stop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.shared.request_stop();
            let _ = worker.join();
        }
    }

    pub fn status(&self) -> RepositoryWatcherStatus {
        self.shared.state().worker_status
    }
}

impl Drop for RepositoryWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct RepositoryWatchReceiver {
    shared: Arc<Shared>,
}

impl RepositoryWatchReceiver {
    pub fn recv(&self) -> Option<RepositoryWatchEvent> {
        let mut state = self.shared.state();
        loop {
            if let Some(event) = state.pop() {
                return Some(event);
            }
            if state.closed {
                return None;
            }
            state = self
                .shared
                .wake
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    pub fn try_recv(&self) -> Result<RepositoryWatchEvent, TryRecvError> {
        let mut state = self.shared.state();
        if let Some(event) = state.pop() {
            Ok(event)
        } else if state.closed {
            Err(TryRecvError::Disconnected)
        } else {
            Err(TryRecvError::Empty)
        }
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<RepositoryWatchEvent, RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        let mut state = self.shared.state();
        loop {
            if let Some(event) = state.pop() {
                return Ok(event);
            }
            if state.closed {
                return Err(RecvTimeoutError::Disconnected);
            }

            let now = Instant::now();
            if now >= deadline {
                return Err(RecvTimeoutError::Timeout);
            }
            let waited = self
                .shared
                .wake
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .unwrap_or_else(|error| error.into_inner());
            state = waited.0;
            if waited.1.timed_out() && state.events.is_empty() {
                return Err(RecvTimeoutError::Timeout);
            }
        }
    }
}

struct Shared {
    queue_capacity: usize,
    queue: Mutex<QueueState>,
    wake: Condvar,
}

impl Shared {
    fn new(queue_capacity: usize) -> Self {
        Self {
            queue_capacity,
            queue: Mutex::new(QueueState::default()),
            wake: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, QueueState> {
        self.queue.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn request_stop(&self) {
        self.state().stop_requested = true;
        self.wake.notify_all();
    }

    fn enqueue_backend(&self, event: BackendEvent) {
        let mut state = self.state();
        if state.stop_requested || state.closed || state.backend_overflow {
            return;
        }
        if state.backend_events.len() == self.queue_capacity {
            state.backend_overflow = true;
        } else {
            state.backend_events.push_back(event);
        }
        drop(state);
        self.wake.notify_all();
    }

    fn next_backend(&self, timeout: Option<Duration>) -> BackendMessage {
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let mut state = self.state();
        loop {
            if state.stop_requested {
                return BackendMessage::Stop;
            }
            if state.backend_overflow {
                state.backend_overflow = false;
                state.backend_events.clear();
                return BackendMessage::Overflow;
            }
            if let Some(event) = state.backend_events.pop_front() {
                return BackendMessage::Event(event);
            }

            let Some(deadline) = deadline else {
                state = self
                    .wake
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
                continue;
            };
            let now = Instant::now();
            if now >= deadline {
                return BackendMessage::Timeout;
            }
            let waited = self
                .wake
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .unwrap_or_else(|error| error.into_inner());
            state = waited.0;
            if waited.1.timed_out() && state.backend_events.is_empty() && !state.backend_overflow {
                return BackendMessage::Timeout;
            }
        }
    }

    fn enqueue(&self, event: RepositoryWatchEvent) {
        let mut state = self.state();
        match event {
            event @ (RepositoryWatchEvent::RepositoryChanged { .. }
            | RepositoryWatchEvent::ReviewChanged { .. }) => {
                if state.closed || state.has_rescan {
                    return;
                }
                if state.events.len() == self.queue_capacity {
                    state.promote_to_rescan(event.root().to_owned());
                } else {
                    state.events.push_back(event);
                }
            }
            RepositoryWatchEvent::RescanRequired { root } => {
                if state.closed || state.has_rescan {
                    return;
                }
                state.remove_changes();
                state
                    .events
                    .push_back(RepositoryWatchEvent::RescanRequired { root });
                state.has_rescan = true;
            }
            RepositoryWatchEvent::Stopped { root } => {
                if state.closed {
                    return;
                }
                if state.events.len() == self.queue_capacity {
                    state.promote_to_rescan(root.clone());
                }
                state
                    .events
                    .push_back(RepositoryWatchEvent::Stopped { root });
                state.closed = true;
            }
        }
        drop(state);
        self.wake.notify_all();
    }
}

#[derive(Default)]
struct QueueState {
    events: VecDeque<RepositoryWatchEvent>,
    backend_events: VecDeque<BackendEvent>,
    backend_overflow: bool,
    stop_requested: bool,
    closed: bool,
    has_rescan: bool,
    worker_status: RepositoryWatcherStatus,
}

impl QueueState {
    fn pop(&mut self) -> Option<RepositoryWatchEvent> {
        let event = self.events.pop_front()?;
        if matches!(event, RepositoryWatchEvent::RescanRequired { .. }) {
            self.has_rescan = false;
        }
        Some(event)
    }

    fn remove_changes(&mut self) {
        self.events.retain(|event| {
            !matches!(
                event,
                RepositoryWatchEvent::RepositoryChanged { .. }
                    | RepositoryWatchEvent::ReviewChanged { .. }
            )
        });
    }

    fn promote_to_rescan(&mut self, root: PathBuf) {
        self.remove_changes();
        if !self.has_rescan && !self.closed {
            self.events
                .push_back(RepositoryWatchEvent::RescanRequired { root });
            self.has_rescan = true;
        }
    }
}

enum BackendMessage {
    Event(BackendEvent),
    Overflow,
    Timeout,
    Stop,
}

enum BackendEvent {
    Paths(Vec<String>),
    Rescan,
}

fn finish_worker(shared: &Shared, root: PathBuf, result: thread::Result<()>) {
    let status = if result.is_err() {
        shared.enqueue(RepositoryWatchEvent::RescanRequired { root: root.clone() });
        RepositoryWatcherStatus::Failed
    } else {
        RepositoryWatcherStatus::Stopped
    };
    shared.state().worker_status = status;
    shared.enqueue(RepositoryWatchEvent::Stopped { root });
}

fn notify_error_to_io(error: notify::Error) -> io::Error {
    io::Error::other(error)
}

fn normalize_backend_event(
    root: &Path,
    result: notify::Result<notify::Event>,
) -> Option<BackendEvent> {
    let Ok(event) = result else {
        return Some(BackendEvent::Rescan);
    };
    normalize_event_paths(root, event)
}

fn normalize_event_paths(root: &Path, event: notify::Event) -> Option<BackendEvent> {
    if event.need_rescan() {
        return Some(BackendEvent::Rescan);
    }
    if event.kind.is_access() {
        return None;
    }
    if event.paths.is_empty() {
        return Some(BackendEvent::Rescan);
    }

    let mut paths = BTreeSet::new();
    for path in event.paths {
        let Some(path) = root_relative_slash_path(root, &path) else {
            return Some(BackendEvent::Rescan);
        };
        if !should_ignore_path(&path) {
            paths.insert(path);
        }
    }
    (!paths.is_empty()).then(|| BackendEvent::Paths(paths.into_iter().collect()))
}

fn root_relative_slash_path(root: &Path, path: &Path) -> Option<String> {
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?
    } else {
        path.strip_prefix(root).unwrap_or(path)
    };
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_str()?),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

fn watch_repository(
    root: PathBuf,
    mut backend: RecommendedWatcher,
    config: RepositoryWatcherConfig,
    shared: &Shared,
) {
    let mut pending = PendingChanges::default();
    loop {
        match shared.next_backend(pending.remaining(config.debounce)) {
            BackendMessage::Stop => break,
            BackendMessage::Overflow | BackendMessage::Event(BackendEvent::Rescan) => {
                pending.clear();
                shared.enqueue(RepositoryWatchEvent::RescanRequired { root: root.clone() });
            }
            BackendMessage::Event(BackendEvent::Paths(paths)) => {
                for path in &paths {
                    let absolute = root.join(path);
                    if absolute.is_dir()
                        && let Err(_error) = watch_nonignored_tree(&mut backend, &absolute)
                    {
                        pending.clear();
                        shared.enqueue(RepositoryWatchEvent::RescanRequired { root: root.clone() });
                        continue;
                    }
                }
                if !pending.record(paths, config.max_batch_paths) {
                    shared.enqueue(RepositoryWatchEvent::RescanRequired { root: root.clone() });
                }
            }
            BackendMessage::Timeout => {
                if !pending.is_empty() {
                    enqueue_changes(shared, &root, pending.take());
                }
            }
        }
    }

    if !pending.is_empty() {
        enqueue_changes(shared, &root, pending.take());
    }
}

fn watch_nonignored_tree(backend: &mut RecommendedWatcher, root: &Path) -> io::Result<()> {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        backend
            .watch(&directory, RecursiveMode::NonRecursive)
            .map_err(notify_error_to_io)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let relative = relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(segment) => segment.to_str(),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            if !should_ignore_path(&relative) {
                pending.push(path);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct PendingChanges {
    paths: BTreeSet<String>,
    last_change: Option<Instant>,
}

impl PendingChanges {
    fn record(&mut self, paths: Vec<String>, limit: usize) -> bool {
        self.paths.extend(paths);
        if self.paths.len() > limit {
            self.clear();
            return false;
        }
        self.last_change = Some(Instant::now());
        true
    }

    fn remaining(&self, debounce: Duration) -> Option<Duration> {
        self.last_change
            .map(|changed| debounce.saturating_sub(changed.elapsed()))
    }

    fn take(&mut self) -> Vec<String> {
        self.last_change = None;
        std::mem::take(&mut self.paths).into_iter().collect()
    }

    fn clear(&mut self) {
        self.paths.clear();
        self.last_change = None;
    }

    fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

fn enqueue_changes(shared: &Shared, root: &Path, paths: Vec<String>) {
    let (repository_paths, review_paths) = classify_paths(paths);
    if !repository_paths.is_empty() {
        shared.enqueue(RepositoryWatchEvent::RepositoryChanged {
            root: root.to_owned(),
            paths: repository_paths,
        });
    }
    if !review_paths.is_empty() {
        shared.enqueue(RepositoryWatchEvent::ReviewChanged {
            root: root.to_owned(),
            paths: review_paths,
        });
    }
}

fn classify_paths(paths: Vec<String>) -> (Vec<String>, Vec<String>) {
    paths.into_iter().partition(|path| !is_review_path(path))
}

fn is_review_path(path: &str) -> bool {
    path == ".diffuse/reviews" || path.starts_with(".diffuse/reviews/")
}

fn should_ignore_path(path: &str) -> bool {
    let mut previous = None;
    path.split('/').any(|segment| {
        let ignored = matches!(
            segment,
            "node_modules" | ".zig-cache" | "zig-out" | "target" | "dist" | "build"
        ) || previous == Some(".git") && matches!(segment, "objects" | "logs");
        previous = Some(segment);
        ignored
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_review_storage_separately() {
        let (repository, review) = classify_paths(vec![
            "src/main.rs".to_owned(),
            ".diffuse/reviews".to_owned(),
            ".diffuse/reviews/session/progress.json".to_owned(),
            ".diffuse/settings.json".to_owned(),
        ]);

        assert_eq!(repository, ["src/main.rs", ".diffuse/settings.json"]);
        assert_eq!(
            review,
            [".diffuse/reviews", ".diffuse/reviews/session/progress.json"]
        );
    }

    #[test]
    fn coalesces_duplicate_bursts_in_stable_path_order() {
        let mut pending = PendingChanges::default();
        assert!(pending.record(vec!["src/z.rs".to_owned(), "src/a.rs".to_owned()], 8));
        assert!(pending.record(vec!["src/a.rs".to_owned(), "README.md".to_owned()], 8));

        assert_eq!(pending.take(), ["README.md", "src/a.rs", "src/z.rs"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn ignores_generated_and_high_churn_git_paths() {
        for path in [
            "node_modules/package/index.js",
            "app/node_modules/package/index.js",
            ".zig-cache/o/artifact",
            "core/zig-out/bin/diffuse",
            "crates/core/target/debug/diffuse",
            "web/dist/index.js",
            "native/build/output.o",
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            "nested/.git/objects/ab/cdef",
        ] {
            assert!(should_ignore_path(path), "expected ignored path: {path}");
        }

        for path in [
            "src/node_modules_like.rs",
            "src/targeted.rs",
            "src/build.rs",
            "src/distill.rs",
            "zig-output/readme.md",
            ".zig-cacheable/config.json",
            ".git/objects-backup/index",
            ".git/logstash/config",
            ".git/index",
            ".git/refs/heads/main",
            ".diffuse/reviews/session.json",
        ] {
            assert!(!should_ignore_path(path), "unexpected ignored path: {path}");
        }
    }

    #[test]
    fn normalizes_relative_paths_with_slashes_and_deduplicates() {
        let root = PathBuf::from("repository");
        let event = notify::Event::new(notify::EventKind::Any)
            .add_path(root.join("src").join("main.rs"))
            .add_path(root.join("src").join("main.rs"))
            .add_path(root.join(".diffuse").join("reviews").join("one.json"));

        let Some(BackendEvent::Paths(paths)) = normalize_event_paths(&root, event) else {
            panic!("expected normalized paths");
        };
        assert_eq!(paths, [".diffuse/reviews/one.json", "src/main.rs"]);
    }

    #[test]
    fn backend_queue_is_bounded_and_overflow_requires_rescan() {
        let shared = Shared::new(2);
        for name in ["one", "two", "three"] {
            shared.enqueue_backend(BackendEvent::Paths(vec![name.to_owned()]));
        }

        {
            let state = shared.state();
            assert_eq!(state.backend_events.len(), 2);
            assert!(state.backend_overflow);
        }
        assert!(matches!(
            shared.next_backend(None),
            BackendMessage::Overflow
        ));
        assert!(shared.state().backend_events.is_empty());
    }

    #[test]
    fn backend_errors_and_rescan_flags_require_rescan() {
        let root = PathBuf::from("repository");
        assert!(matches!(
            normalize_backend_event(&root, Err(notify::Error::generic("backend failed"))),
            Some(BackendEvent::Rescan)
        ));

        let event =
            notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(matches!(
            normalize_backend_event(&root, Ok(event)),
            Some(BackendEvent::Rescan)
        ));
    }

    #[test]
    fn watches_nested_files_and_stops_cleanly() {
        let repository = tempfile::tempdir().expect("create repository");
        let nested = repository.path().join("src").join("nested");
        fs::create_dir_all(&nested).expect("create nested directory");
        let config = RepositoryWatcherConfig {
            debounce: Duration::from_millis(25),
            ..RepositoryWatcherConfig::default()
        };
        let (mut watcher, receiver) =
            RepositoryWatcher::start(repository.path(), config).expect("start watcher");

        fs::write(nested.join("event.rs"), "fn event() {}\n").expect("write watched file");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            assert!(
                !timeout.is_zero(),
                "timed out waiting for nested file event"
            );
            match receiver.recv_timeout(timeout) {
                Ok(RepositoryWatchEvent::RepositoryChanged { paths, .. })
                    if paths.iter().any(|path| path == "src/nested/event.rs") =>
                {
                    break;
                }
                Ok(RepositoryWatchEvent::Stopped { .. }) => panic!("watcher stopped early"),
                Ok(_) => {}
                Err(error) => panic!("failed waiting for nested file event: {error}"),
            }
        }

        watcher.stop();
        assert_eq!(watcher.status(), RepositoryWatcherStatus::Stopped);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(2)),
            Ok(RepositoryWatchEvent::Stopped { .. })
        ));
    }

    #[test]
    fn records_worker_failure_before_publishing_terminal_event() {
        let shared = Arc::new(Shared::new(2));
        let result: thread::Result<()> = Err(Box::new("watcher panic"));
        finish_worker(&shared, PathBuf::from("/repository"), result);

        assert_eq!(
            shared.state().worker_status,
            RepositoryWatcherStatus::Failed
        );
        let receiver = RepositoryWatchReceiver { shared };
        assert!(matches!(
            receiver.recv(),
            Some(RepositoryWatchEvent::RescanRequired { .. })
        ));
        assert!(matches!(
            receiver.recv(),
            Some(RepositoryWatchEvent::Stopped { .. })
        ));
    }

    #[test]
    fn queue_overflow_preserves_rescan_and_terminal_events() {
        let root = PathBuf::from("/repository");
        let shared = Shared::new(2);
        shared.enqueue(RepositoryWatchEvent::RepositoryChanged {
            root: root.clone(),
            paths: vec!["one".to_owned()],
        });
        shared.enqueue(RepositoryWatchEvent::ReviewChanged {
            root: root.clone(),
            paths: vec![".diffuse/reviews/one".to_owned()],
        });
        shared.enqueue(RepositoryWatchEvent::RepositoryChanged {
            root: root.clone(),
            paths: vec!["two".to_owned()],
        });
        shared.enqueue(RepositoryWatchEvent::Stopped { root });

        let receiver = RepositoryWatchReceiver {
            shared: Arc::new(shared),
        };
        assert!(matches!(
            receiver.recv(),
            Some(RepositoryWatchEvent::RescanRequired { .. })
        ));
        assert!(matches!(
            receiver.recv(),
            Some(RepositoryWatchEvent::Stopped { .. })
        ));
        assert_eq!(receiver.recv(), None);
    }
}
