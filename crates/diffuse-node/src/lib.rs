use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use diffuse_core_lib::syntax::{ParserBackend, SyntaxManagerOptions};
use diffuse_core_lib::{
    AnswerInputRequest, AppCore, AppCoreOptions, AttentionCasRequest, CloseWorkspaceRequest,
    CoreError, CreateAttentionRequest, CreateInputRequest, EventSubscription, InputCasRequest,
    SaveWorkspaceUiStateRequest, WorkbenchDatabase, WorkbenchEvent, WorkspaceGeneration,
    WorkspaceId, WorkspaceRequestContext, WorkspaceServiceHealth, WorkspaceServiceStatus,
    default_database_path, version_info,
};
use napi::bindgen_prelude::{AsyncTask, Env, JsFunction, Task};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, JsError, JsUnknown, Result, Status};
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Value, json};

const EVENT_SUBSCRIPTION_CAPACITY: usize = 256;
const EVENT_CALLBACK_QUEUE_CAPACITY: usize = 16;
const EVENT_BATCH_MAX_COUNT: usize = 64;
const EVENT_BATCH_MAX_WAIT: Duration = Duration::from_millis(8);
const EVENT_IDLE_WAIT: Duration = Duration::from_millis(8);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

const STATE_HEALTHY: u8 = 0;
const STATE_DEGRADED: u8 = 1;
const STATE_UNHEALTHY: u8 = 2;
const STATE_STOPPING: u8 = 3;
const STATE_STOPPED: u8 = 4;

type EventCallback = ThreadsafeFunction<Value, ErrorStrategy::Fatal>;
type CoreOperation = Box<dyn FnOnce(&AddonInner) -> OperationResult + Send>;
type OperationResult = std::result::Result<Value, NativeFailure>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFailure {
    code: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedWorkspaceSummary {
    workspace_id: WorkspaceId,
    workspace_generation: WorkspaceGeneration,
    root: String,
    display_name: String,
    state: &'static str,
    service_health: WorkspaceServiceHealth,
    attention: diffuse_core_lib::WorkspaceAttentionSummary,
}

impl NativeFailure {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn panic() -> Self {
        Self::new(
            "NATIVE_BOUNDARY_PANIC",
            "Native core task panicked at the addon boundary",
        )
    }

    fn shut_down() -> Self {
        Self::new(
            "BACKEND_SHUT_DOWN",
            "The native core backend is shutting down or has stopped",
        )
    }

    fn shutdown_timeout() -> Self {
        Self::new(
            "NATIVE_SHUTDOWN_TIMEOUT",
            "Native core shutdown exceeded the 5 second timeout",
        )
    }
}

impl From<CoreError> for NativeFailure {
    fn from(error: CoreError) -> Self {
        Self::new(error.protocol_name(), error.to_string())
    }
}

#[derive(Clone)]
struct NativeErrorCode(String);

impl AsRef<str> for NativeErrorCode {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NativeErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

struct HealthState {
    state: AtomicU8,
    shutdown_timed_out: AtomicBool,
    last_boundary_failure: Mutex<Option<NativeFailure>>,
    shutdown_result: Mutex<Option<std::result::Result<(), NativeFailure>>>,
    shutdown_complete: Condvar,
}

impl Default for HealthState {
    fn default() -> Self {
        Self {
            state: AtomicU8::new(STATE_HEALTHY),
            shutdown_timed_out: AtomicBool::new(false),
            last_boundary_failure: Mutex::new(None),
            shutdown_result: Mutex::new(None),
            shutdown_complete: Condvar::new(),
        }
    }
}

impl HealthState {
    fn require_running(&self) -> std::result::Result<(), NativeFailure> {
        match self.state.load(Ordering::Acquire) {
            STATE_HEALTHY | STATE_DEGRADED => Ok(()),
            STATE_UNHEALTHY => Err(NativeFailure::new(
                "NATIVE_CORE_UNHEALTHY",
                "The native core backend is unhealthy",
            )),
            _ => Err(NativeFailure::shut_down()),
        }
    }

    fn mark_degraded(&self, failure: NativeFailure) {
        let _ = self.state.compare_exchange(
            STATE_HEALTHY,
            STATE_DEGRADED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        *lock_unpoisoned(&self.last_boundary_failure) = Some(failure);
    }

    fn mark_unhealthy(&self, failure: NativeFailure) {
        *lock_unpoisoned(&self.last_boundary_failure) = Some(failure);
        let mut current = self.state.load(Ordering::Acquire);
        while matches!(current, STATE_HEALTHY | STATE_DEGRADED) {
            match self.state.compare_exchange_weak(
                current,
                STATE_UNHEALTHY,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(updated) => current = updated,
            }
        }
    }

    fn begin_stopping(&self) -> bool {
        let mut current = self.state.load(Ordering::Acquire);
        loop {
            if current >= STATE_STOPPING {
                return false;
            }
            match self.state.compare_exchange_weak(
                current,
                STATE_STOPPING,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(updated) => current = updated,
            }
        }
    }

    fn finish_shutdown(&self, result: std::result::Result<(), NativeFailure>) {
        if let Err(failure) = &result {
            *lock_unpoisoned(&self.last_boundary_failure) = Some(failure.clone());
        }
        let mut shutdown_result = lock_unpoisoned(&self.shutdown_result);
        *shutdown_result = Some(result);
        self.state.store(STATE_STOPPED, Ordering::Release);
        drop(shutdown_result);
        self.shutdown_complete.notify_all();
    }

    fn wait_for_shutdown(&self, timeout: Duration) -> std::result::Result<(), NativeFailure> {
        let deadline = Instant::now() + timeout;
        let mut result = lock_unpoisoned(&self.shutdown_result);
        while result.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.shutdown_timed_out.store(true, Ordering::Release);
                return Err(NativeFailure::shutdown_timeout());
            }
            let waited = self.shutdown_complete.wait_timeout(result, remaining);
            let (updated, timeout) = match waited {
                Ok(value) => value,
                Err(poisoned) => poisoned.into_inner(),
            };
            result = updated;
            if timeout.timed_out() && result.is_none() {
                self.shutdown_timed_out.store(true, Ordering::Release);
                return Err(NativeFailure::shutdown_timeout());
            }
        }
        result.clone().unwrap_or_else(|| {
            Err(NativeFailure::new(
                "NATIVE_SHUTDOWN_FAILED",
                "Native core shutdown result was unavailable",
            ))
        })
    }

    fn snapshot(&self) -> Value {
        let state = self.state.load(Ordering::Acquire);
        let timed_out = self.shutdown_timed_out.load(Ordering::Relaxed);
        let failure = lock_unpoisoned(&self.last_boundary_failure).clone();
        let status = match state {
            STATE_HEALTHY => "healthy",
            STATE_DEGRADED => "degraded",
            STATE_UNHEALTHY => "unhealthy",
            STATE_STOPPING => "stopping",
            _ => "stopped",
        };
        let mut value = serde_json::Map::from_iter([("status".to_owned(), json!(status))]);
        if let Some(failure) = failure {
            value.insert("message".to_owned(), json!(failure.message));
            value.insert(
                "lastBoundaryFailure".to_owned(),
                serde_json::to_value(failure).expect("native failure is serializable"),
            );
        }
        if timed_out {
            value.insert("shutdownTimedOut".to_owned(), json!(true));
        }
        Value::Object(value)
    }
}

#[derive(Clone, Debug)]
struct ResolvedOptions {
    database_path: PathBuf,
    in_memory: bool,
    syntax_runner_path: Option<PathBuf>,
}

impl ResolvedOptions {
    fn new(database_path: Option<String>, syntax_runner_path: Option<String>) -> Self {
        let database_path =
            database_path.unwrap_or_else(|| default_database_path().to_string_lossy().into_owned());
        Self {
            in_memory: database_path == ":memory:",
            database_path: PathBuf::from(database_path),
            syntax_runner_path: syntax_runner_path
                .filter(|path| !path.is_empty())
                .map(PathBuf::from),
        }
    }

    fn syntax_options(&self) -> SyntaxManagerOptions {
        let parser_backend = match &self.syntax_runner_path {
            Some(command) => ParserBackend::IsolatedExecutable {
                command: command.clone(),
                args: vec!["syntax-runner".into()],
            },
            None => ParserBackend::Unavailable,
        };
        SyntaxManagerOptions::from_environment_with_parser_backend(parser_backend)
    }
}

struct EventDrain {
    stop: Arc<AtomicBool>,
    subscription: Mutex<Option<EventSubscription>>,
    callback: Mutex<Option<EventCallback>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl EventDrain {
    fn start(
        subscription: EventSubscription,
        mut callback: EventCallback,
        env: &Env,
        health: Arc<HealthState>,
    ) -> std::result::Result<Self, NativeFailure> {
        callback.unref(env).map_err(initialization_failure)?;
        let callback_control = callback.clone();
        let worker_subscription = subscription.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let thread = thread::Builder::new()
            .name("diffuse-node-events".to_owned())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    drain_events(worker_subscription, callback, &worker_stop, &health)
                }));
                if result.is_err() {
                    health.mark_degraded(NativeFailure::new(
                        "NATIVE_EVENT_DRAIN_PANIC",
                        "Native event drain thread panicked",
                    ));
                }
            })
            .map_err(|error| initialization_failure(error.to_string()))?;
        Ok(Self {
            stop,
            subscription: Mutex::new(Some(subscription)),
            callback: Mutex::new(Some(callback_control)),
            thread: Mutex::new(Some(thread)),
        })
    }

    fn close_subscription(&self) {
        if let Some(subscription) = lock_unpoisoned(&self.subscription).take() {
            subscription.close();
        }
    }

    fn stop_and_join(&self, health: &HealthState) {
        // Closing removes the sender but preserves queued events. The drain exits after enqueueing
        // the final batch, then releasing the TSFN lets Node process its bounded callback queue.
        self.close_subscription();
        if let Some(worker) = lock_unpoisoned(&self.thread).take() {
            if worker.join().is_err() {
                health.mark_degraded(NativeFailure::new(
                    "NATIVE_EVENT_DRAIN_PANIC",
                    "Native event drain thread panicked",
                ));
            }
        }
        lock_unpoisoned(&self.callback).take();
    }

    fn abort_and_join(&self) {
        self.stop.store(true, Ordering::Release);
        self.close_subscription();
        if let Some(callback) = lock_unpoisoned(&self.callback).take() {
            let _ = catch_unwind(AssertUnwindSafe(|| callback.abort()));
        }
        if let Some(worker) = lock_unpoisoned(&self.thread).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for EventDrain {
    fn drop(&mut self) {
        self.abort_and_join();
    }
}

struct AddonInner {
    core: AppCore,
    runtime: tokio::runtime::Runtime,
    health: Arc<HealthState>,
    events: EventDrain,
    restoration: Arc<RestorationState>,
}

#[derive(Default)]
struct RestorationState {
    result: Mutex<Option<std::result::Result<(), NativeFailure>>>,
    complete: Condvar,
}

impl RestorationState {
    fn finish(&self, result: std::result::Result<(), NativeFailure>) {
        *lock_unpoisoned(&self.result) = Some(result);
        self.complete.notify_all();
    }

    fn wait(&self) -> std::result::Result<(), NativeFailure> {
        let mut result = lock_unpoisoned(&self.result);
        while result.is_none() {
            result = self
                .complete
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        result.clone().unwrap_or_else(|| {
            Err(NativeFailure::new(
                "NATIVE_ADDON_INIT_FAILED",
                "Native core restoration result was unavailable",
            ))
        })
    }
}

impl Drop for AddonInner {
    fn drop(&mut self) {
        // Abort the Node boundary before core fields drop so blocked event publishers are released.
        self.events.abort_and_join();
    }
}

impl AddonInner {
    fn build(
        options: ResolvedOptions,
        callback: JsFunction,
        env: &Env,
    ) -> std::result::Result<Self, NativeFailure> {
        let database = if options.in_memory {
            WorkbenchDatabase::open_in_memory()
        } else {
            WorkbenchDatabase::open(&options.database_path)
        }
        .map_err(|error| initialization_failure(error.to_string()))?;
        let core = AppCore::with_options(
            database,
            AppCoreOptions {
                syntax: options.syntax_options(),
            },
        )
        .map_err(|error| initialization_failure(error.to_string()))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("diffuse-node-tokio")
            .build()
            .map_err(|error| initialization_failure(error.to_string()))?;
        let (_, subscription) = core.events().subscribe(EVENT_SUBSCRIPTION_CAPACITY);
        let callback = callback
            .create_threadsafe_function(EVENT_CALLBACK_QUEUE_CAPACITY, |context| {
                Ok(vec![context.value])
            })
            .map_err(initialization_failure)?;
        let health = Arc::new(HealthState::default());
        let events = EventDrain::start(subscription, callback, env, health.clone())?;
        Ok(Self {
            core,
            runtime,
            health,
            events,
            restoration: Arc::new(RestorationState::default()),
        })
    }

    fn start_restoration(self: &Arc<Self>) {
        let inner = self.clone();
        self.runtime.spawn(async move {
            let result = inner
                .core
                .restore_workbench()
                .await
                .map(|_| ())
                .map_err(|error| initialization_failure(error.to_string()));
            if let Err(failure) = &result {
                inner.health.mark_unhealthy(failure.clone());
            }
            inner.restoration.finish(result);
        });
    }

    fn wait_for_restoration(&self) -> std::result::Result<(), NativeFailure> {
        self.restoration.wait()
    }

    fn run_shutdown(self: &Arc<Self>, leader: bool) -> OperationResult {
        if leader {
            let inner = self.clone();
            let worker = thread::Builder::new()
                .name("diffuse-node-shutdown".to_owned())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        let restoration = inner.wait_for_restoration();
                        inner.core.begin_shutdown();
                        let shutdown = inner.core.shutdown();
                        restoration.map_err(|failure| {
                            CoreError::TaskFailed(format!("{}: {}", failure.code, failure.message))
                        })?;
                        shutdown
                    }));
                    let result = match result {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(NativeFailure::from(error)),
                        Err(_) => Err(NativeFailure::panic()),
                    };
                    let event_stop = catch_unwind(AssertUnwindSafe(|| {
                        inner.events.stop_and_join(&inner.health)
                    }));
                    let result = if event_stop.is_err() && result.is_ok() {
                        Err(NativeFailure::new(
                            "NATIVE_EVENT_STOP_FAILED",
                            "Native event delivery panicked during shutdown",
                        ))
                    } else {
                        result
                    };
                    inner.health.finish_shutdown(result);
                });
            if let Err(error) = worker {
                let failure = NativeFailure::new(
                    "NATIVE_SHUTDOWN_START_FAILED",
                    format!("Failed to start native core shutdown: {error}"),
                );
                self.health.finish_shutdown(Err(failure.clone()));
                return Err(failure);
            }
            // The worker is intentionally detached so it can record completion after this caller
            // times out. Event-drain and core completion are both owned by that worker.
        }

        self.health.wait_for_shutdown(SHUTDOWN_TIMEOUT)?;
        Ok(Value::Null)
    }
}

#[napi(object)]
pub struct DiffuseCoreOptions {
    pub on_event_batch: JsFunction,
    pub database_path: Option<String>,
    pub syntax_runner_path: Option<String>,
}

#[napi]
pub struct DiffuseCore {
    inner: Arc<AddonInner>,
}

#[napi]
impl DiffuseCore {
    #[napi(constructor)]
    pub fn new(env: Env, options: DiffuseCoreOptions) -> Result<Self> {
        create_addon(env, options)
    }

    #[napi(js_name = "getVersion")]
    pub fn get_version(&self) -> AsyncTask<CoreTask> {
        self.task("getVersion", |_inner| {
            serialize(version_info()).map_err(Into::into)
        })
    }

    #[napi(js_name = "getWorkbenchSnapshot")]
    pub fn get_workbench_snapshot(&self) -> AsyncTask<CoreTask> {
        self.task("getWorkbenchSnapshot", |inner| {
            serialize(inner.core.workbench_snapshot()?).map_err(Into::into)
        })
    }

    #[napi(js_name = "openWorkspace")]
    pub fn open_workspace(&self, path: String) -> AsyncTask<CoreTask> {
        self.task("openWorkspace", move |inner| {
            let snapshot = inner.runtime.block_on(inner.core.open_workspace(path))?;
            serialize(snapshot).map_err(Into::into)
        })
    }

    #[napi(js_name = "activateWorkspace")]
    pub fn activate_workspace(&self, reference: Option<Value>) -> AsyncTask<CoreTask> {
        self.task("activateWorkspace", move |inner| match reference {
            Some(reference) => {
                let context = context_from_reference(reference, "activate")?;
                let snapshot = inner
                    .core
                    .activate_workspace(context.workspace_id, context.workspace_generation)?;
                serialize(snapshot).map_err(Into::into)
            }
            None => {
                inner.core.deactivate_workspace()?;
                Ok(Value::Null)
            }
        })
    }

    #[napi(js_name = "getWorkspaceSnapshot")]
    pub fn get_workspace_snapshot(&self, reference: Value) -> AsyncTask<CoreTask> {
        self.task("getWorkspaceSnapshot", move |inner| {
            let context = context_from_reference(reference, "snapshot")?;
            serialize(inner.core.get_workspace_snapshot(&context)?).map_err(Into::into)
        })
    }

    #[napi(js_name = "closeWorkspace")]
    pub fn close_workspace(&self, reference: Value) -> AsyncTask<CoreTask> {
        self.task("closeWorkspace", move |inner| {
            let request: CloseWorkspaceRequest = deserialize_request(reference)?;
            let context = request.context();
            let summary = inner.core.get_workspace_snapshot(&context)?.summary;
            inner.core.close_workspace(&request)?;
            serialize(ClosedWorkspaceSummary {
                workspace_id: summary.workspace_id,
                workspace_generation: summary.workspace_generation,
                root: summary.root,
                display_name: summary.display_name,
                state: "closed",
                service_health: WorkspaceServiceHealth {
                    repository_watcher: WorkspaceServiceStatus::Stopped,
                },
                attention: summary.attention,
            })
            .map_err(Into::into)
        })
    }

    #[napi(js_name = "dismissRestoreFailure")]
    pub fn dismiss_restore_failure(&self, workspace_id: String) -> AsyncTask<CoreTask> {
        self.task("dismissRestoreFailure", move |inner| {
            let workspace_id = WorkspaceId::parse(&workspace_id).map_err(|error| {
                NativeFailure::new(
                    "InvalidParams",
                    format!("InvalidParams: invalid workspace ID: {error}"),
                )
            })?;
            serialize(inner.core.dismiss_restore_failure(workspace_id)?).map_err(Into::into)
        })
    }

    #[napi(js_name = "reorderWorkspaces")]
    pub fn reorder_workspaces(&self, workspace_ids: Vec<String>) -> AsyncTask<CoreTask> {
        self.task("reorderWorkspaces", move |inner| {
            let ids = workspace_ids
                .iter()
                .map(|id| {
                    WorkspaceId::parse(id).map_err(|error| {
                        NativeFailure::new(
                            "InvalidParams",
                            format!("InvalidParams: invalid workspace ID: {error}"),
                        )
                    })
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            serialize(json!({ "workspaceIds": inner.core.reorder_workspaces(ids)? }))
                .map_err(Into::into)
        })
    }

    #[napi(js_name = "saveWorkspaceUiState")]
    pub fn save_workspace_ui_state(&self, request: Value) -> AsyncTask<CoreTask> {
        self.task("saveWorkspaceUiState", move |inner| {
            let request: SaveWorkspaceUiStateRequest = deserialize_request(request)?;
            let result = inner.core.save_workspace_ui_state(request)?;
            serialize(result).map_err(Into::into)
        })
    }

    #[napi(js_name = "createAttention")]
    pub fn create_attention(&self, request: Value) -> AsyncTask<CoreTask> {
        self.task("createAttention", move |inner| {
            let request: CreateAttentionRequest = deserialize_request(request)?;
            serialize(inner.core.create_attention(request)?).map_err(Into::into)
        })
    }

    #[napi(js_name = "acknowledgeAttention")]
    pub fn acknowledge_attention(&self, request: Value) -> AsyncTask<CoreTask> {
        self.attention_cas_task("acknowledgeAttention", request, false)
    }

    #[napi(js_name = "claimAttentionNotification")]
    pub fn claim_attention_notification(&self, request: Value) -> AsyncTask<CoreTask> {
        self.attention_cas_task("claimAttentionNotification", request, true)
    }

    #[napi(js_name = "createInputRequest")]
    pub fn create_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.task("createInputRequest", move |inner| {
            let request: CreateInputRequest = deserialize_request(request)?;
            serialize(inner.core.create_input_request(request)?).map_err(Into::into)
        })
    }

    #[napi(js_name = "answerInputRequest")]
    pub fn answer_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.task("answerInputRequest", move |inner| {
            let request: AnswerInputRequest = deserialize_request(request)?;
            serialize(inner.core.answer_input_request(request)?).map_err(Into::into)
        })
    }

    #[napi(js_name = "acceptInputRequest")]
    pub fn accept_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.input_cas_task("acceptInputRequest", request, |core, request| {
            core.accept_input_request(request)
        })
    }

    #[napi(js_name = "rejectInputRequest")]
    pub fn reject_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.input_cas_task("rejectInputRequest", request, |core, request| {
            core.reject_input_request(request)
        })
    }

    #[napi(js_name = "cancelInputRequest")]
    pub fn cancel_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.input_cas_task("cancelInputRequest", request, |core, request| {
            core.cancel_input_request(request)
        })
    }

    #[napi(js_name = "expireInputRequest")]
    pub fn expire_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.input_cas_task("expireInputRequest", request, |core, request| {
            core.expire_input_request(request)
        })
    }

    #[napi(js_name = "supersedeInputRequest")]
    pub fn supersede_input_request(&self, request: Value) -> AsyncTask<CoreTask> {
        self.input_cas_task("supersedeInputRequest", request, |core, request| {
            core.supersede_input_request(request)
        })
    }

    #[napi]
    pub fn request(
        &self,
        context: Value,
        method: String,
        params: Option<Value>,
    ) -> AsyncTask<CoreTask> {
        self.task("request", move |inner| {
            let context: WorkspaceRequestContext = serde_json::from_value(context)
                .map_err(|error| invalid_params("context", error))?;
            inner
                .runtime
                .block_on(inner.core.dispatch_workspace(&context, &method, params))
                .map_err(Into::into)
        })
    }

    #[napi]
    pub fn health(&self) -> AsyncTask<CoreTask> {
        AsyncTask::new(CoreTask::health(self.inner.clone()))
    }

    #[napi]
    pub fn shutdown(&self) -> AsyncTask<CoreTask> {
        let leader = self.inner.health.begin_stopping();
        AsyncTask::new(CoreTask::shutdown(self.inner.clone(), leader))
    }
}

impl DiffuseCore {
    fn attention_cas_task(
        &self,
        operation_name: &'static str,
        request: Value,
        notification_claim: bool,
    ) -> AsyncTask<CoreTask> {
        self.task(operation_name, move |inner| {
            let request: AttentionCasRequest = deserialize_request(request)?;
            let result = if notification_claim {
                inner.core.claim_attention_notification(request)?
            } else {
                inner.core.acknowledge_attention(request)?
            };
            serialize(result).map_err(Into::into)
        })
    }

    fn input_cas_task<F>(
        &self,
        operation_name: &'static str,
        request: Value,
        operation: F,
    ) -> AsyncTask<CoreTask>
    where
        F: FnOnce(
                &AppCore,
                InputCasRequest,
            )
                -> std::result::Result<diffuse_core_lib::InputMutationResult, CoreError>
            + Send
            + 'static,
    {
        self.task(operation_name, move |inner| {
            let request: InputCasRequest = deserialize_request(request)?;
            serialize(operation(&inner.core, request)?).map_err(Into::into)
        })
    }

    fn task<F>(&self, operation_name: &'static str, operation: F) -> AsyncTask<CoreTask>
    where
        F: FnOnce(&AddonInner) -> OperationResult + Send + 'static,
    {
        AsyncTask::new(CoreTask::normal(
            self.inner.clone(),
            operation_name,
            operation,
        ))
    }
}

#[napi(js_name = "createCore")]
pub fn create_core(env: Env, options: DiffuseCoreOptions) -> Result<DiffuseCore> {
    create_addon(env, options)
}

fn create_addon(env: Env, options: DiffuseCoreOptions) -> Result<DiffuseCore> {
    let DiffuseCoreOptions {
        on_event_batch,
        database_path,
        syntax_runner_path,
    } = options;
    let options = ResolvedOptions::new(database_path, syntax_runner_path);
    match catch_unwind(AssertUnwindSafe(|| {
        AddonInner::build(options, on_event_batch, &env)
    })) {
        Ok(Ok(inner)) => {
            let inner = Arc::new(inner);
            inner.start_restoration();
            Ok(DiffuseCore { inner })
        }
        Ok(Err(failure)) => Err(safe_napi_error(&env, failure)),
        Err(_) => Err(safe_napi_error(&env, NativeFailure::panic())),
    }
}

#[derive(Clone, Copy)]
enum TaskKind {
    Normal,
    Health,
    Shutdown { leader: bool },
}

pub struct CoreTask {
    inner: Arc<AddonInner>,
    operation_name: &'static str,
    kind: TaskKind,
    operation: Option<CoreOperation>,
    rejection: Option<NativeFailure>,
}

impl CoreTask {
    fn normal<F>(inner: Arc<AddonInner>, operation_name: &'static str, operation: F) -> Self
    where
        F: FnOnce(&AddonInner) -> OperationResult + Send + 'static,
    {
        Self {
            inner,
            operation_name,
            kind: TaskKind::Normal,
            operation: Some(Box::new(operation)),
            rejection: None,
        }
    }

    fn health(inner: Arc<AddonInner>) -> Self {
        Self {
            inner,
            operation_name: "health",
            kind: TaskKind::Health,
            operation: None,
            rejection: None,
        }
    }

    fn shutdown(inner: Arc<AddonInner>, leader: bool) -> Self {
        Self {
            inner,
            operation_name: "shutdown",
            kind: TaskKind::Shutdown { leader },
            operation: None,
            rejection: None,
        }
    }

    fn fail(&mut self, failure: NativeFailure) -> Result<Value> {
        self.rejection = Some(failure.clone());
        Err(Error::new(Status::GenericFailure, failure.message))
    }
}

impl Task for CoreTask {
    type Output = Value;
    type JsValue = JsUnknown;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = catch_unwind(AssertUnwindSafe(|| match self.kind {
            TaskKind::Normal => {
                self.inner.wait_for_restoration()?;
                self.inner.health.require_running()?;
                let operation = self.operation.take().ok_or_else(|| {
                    NativeFailure::new(
                        "NATIVE_BOUNDARY_FAILURE",
                        format!(
                            "Native core {} task was already consumed",
                            self.operation_name
                        ),
                    )
                })?;
                operation(&self.inner)
            }
            TaskKind::Health => Ok(self.inner.health.snapshot()),
            TaskKind::Shutdown { leader } => self.inner.run_shutdown(leader),
        }));
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(failure)) => self.fail(failure),
            Err(_) => {
                let failure = NativeFailure::panic();
                record_task_panic(&self.inner.health, self.kind, failure.clone());
                self.fail(failure)
            }
        }
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        env.to_js_value(&output)
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        match self.rejection.take() {
            Some(failure) => Err(safe_napi_error(&env, failure)),
            None => Err(error),
        }
    }
}

fn drain_events(
    subscription: EventSubscription,
    callback: EventCallback,
    stop: &AtomicBool,
    health: &HealthState,
) {
    while !stop.load(Ordering::Acquire) {
        let first = match subscription.recv_timeout(EVENT_IDLE_WAIT) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let batch = collect_event_batch(first, |timeout| subscription.recv_timeout(timeout));
        if stop.load(Ordering::Acquire) {
            break;
        }
        let value = match serde_json::to_value(batch) {
            Ok(value) => value,
            Err(error) => {
                health.mark_degraded(NativeFailure::new(
                    "NATIVE_EVENT_SERIALIZATION_FAILED",
                    format!("Failed to serialize native event batch: {error}"),
                ));
                continue;
            }
        };
        // Only this dedicated drain thread may wait for bounded TSFN capacity. Core workers and
        // core lifecycle locks never perform this blocking Node delivery call.
        match callback.call(value, ThreadsafeFunctionCallMode::Blocking) {
            Status::Ok => {}
            status => {
                health.mark_degraded(NativeFailure::new(
                    "NATIVE_EVENT_DELIVERY_FAILED",
                    format!("Native event callback failed with status {status}"),
                ));
                if status == Status::Closing {
                    break;
                }
            }
        }
    }
    subscription.close();
}

fn record_task_panic(health: &HealthState, kind: TaskKind, failure: NativeFailure) {
    match kind {
        TaskKind::Normal | TaskKind::Health => health.mark_unhealthy(failure),
        TaskKind::Shutdown { .. } => {
            *lock_unpoisoned(&health.last_boundary_failure) = Some(failure);
        }
    }
}

fn collect_event_batch<F>(first: WorkbenchEvent, mut receive: F) -> Vec<WorkbenchEvent>
where
    F: FnMut(Duration) -> std::result::Result<WorkbenchEvent, mpsc::RecvTimeoutError>,
{
    let deadline = Instant::now() + EVENT_BATCH_MAX_WAIT;
    let mut batch = Vec::with_capacity(EVENT_BATCH_MAX_COUNT);
    batch.push(first);
    while batch.len() < EVENT_BATCH_MAX_COUNT {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receive(remaining) {
            Ok(event) => batch.push(event),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    batch
}

fn context_from_reference(
    reference: Value,
    request_id: &str,
) -> std::result::Result<WorkspaceRequestContext, NativeFailure> {
    let mut reference = reference;
    let Value::Object(object) = &mut reference else {
        return Err(NativeFailure::new(
            "InvalidParams",
            "InvalidParams: workspace reference must be an object",
        ));
    };
    object.insert("requestId".to_owned(), json!(request_id));
    serde_json::from_value(reference).map_err(|error| invalid_params("reference", error))
}

fn invalid_params(label: &str, error: serde_json::Error) -> NativeFailure {
    NativeFailure::new(
        "InvalidParams",
        format!("InvalidParams: invalid {label}: {error}"),
    )
}

fn deserialize_request<T: serde::de::DeserializeOwned>(
    mut request: Value,
) -> std::result::Result<T, NativeFailure> {
    if let Value::Object(object) = &mut request {
        if let Some(context_value) = object.get("context").cloned() {
            let Value::Object(context) = context_value else {
                return Err(NativeFailure::new(
                    "InvalidParams",
                    "InvalidParams: request.context must be an object",
                ));
            };
            for key in ["workspaceId", "workspaceGeneration"] {
                if let Some(nested) = context.get(key) {
                    if let Some(flat) = object.get(key) {
                        if flat != nested {
                            return Err(NativeFailure::new(
                                "InvalidParams",
                                format!(
                                    "InvalidParams: conflicting flat and nested {key} identities"
                                ),
                            ));
                        }
                    } else {
                        object.insert(key.to_owned(), nested.clone());
                    }
                }
            }
        }
    }
    serde_json::from_value(request).map_err(|error| invalid_params("request", error))
}

fn serialize(value: impl Serialize) -> std::result::Result<Value, CoreError> {
    serde_json::to_value(value).map_err(|error| CoreError::Serialization(error.to_string()))
}

fn initialization_failure(error: impl fmt::Display) -> NativeFailure {
    NativeFailure::new(
        "NATIVE_ADDON_INIT_FAILED",
        format!("Failed to initialize native core addon: {error}"),
    )
}

fn safe_napi_error(env: &Env, failure: NativeFailure) -> Error {
    let fallback = failure.clone();
    catch_unwind(AssertUnwindSafe(|| {
        let error = Error::new(NativeErrorCode(failure.code), failure.message);
        let unknown: JsUnknown = JsError::from(error).into_unknown(*env);
        Error::from(unknown)
    }))
    .unwrap_or_else(|_| {
        Error::new(
            Status::GenericFailure,
            format!("{}: {}", fallback.code, fallback.message),
        )
    })
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(sequence: u64) -> WorkbenchEvent {
        WorkbenchEvent {
            sequence,
            event_id: format!("event-{sequence}"),
            kind: "test/event".to_owned(),
            workspace_id: Some(WorkspaceId::new()),
            workspace_generation: Some(WorkspaceGeneration::new()),
            payload: json!({ "sequence": sequence }),
        }
    }

    #[test]
    fn options_default_to_native_grammar_unavailable_and_default_database() {
        let options = ResolvedOptions::new(None, None);

        assert_eq!(options.database_path, default_database_path());
        assert!(!options.in_memory);
        assert_eq!(
            options.syntax_options().parser_backend,
            ParserBackend::Unavailable
        );
    }

    #[test]
    fn options_accept_memory_database_and_explicit_syntax_runner() {
        let options = ResolvedOptions::new(
            Some(":memory:".to_owned()),
            Some("/tmp/diffuse-syntax-runner".to_owned()),
        );

        assert!(options.in_memory);
        assert_eq!(
            options.syntax_options().parser_backend,
            ParserBackend::IsolatedExecutable {
                command: PathBuf::from("/tmp/diffuse-syntax-runner"),
                args: vec!["syntax-runner".into()],
            }
        );
    }

    #[test]
    fn close_request_keeps_plain_references_compatible_and_defaults_force_to_false() {
        let workspace_id = WorkspaceId::new();
        let workspace_generation = WorkspaceGeneration::new();
        let plain: CloseWorkspaceRequest = deserialize_request(json!({
            "workspaceId": workspace_id,
            "workspaceGeneration": workspace_generation,
        }))
        .unwrap();
        assert!(!plain.force);

        let forced: CloseWorkspaceRequest = deserialize_request(json!({
            "workspaceId": workspace_id,
            "workspaceGeneration": workspace_generation,
            "force": true,
        }))
        .unwrap();
        assert!(forced.force);
        assert_eq!(
            NativeFailure::from(CoreError::WorkspaceHasPendingInput).code,
            "WorkspaceHasPendingInput"
        );
    }

    #[test]
    fn ui_state_mutation_envelopes_keep_the_napi_serialized_contract() {
        for outcome in [
            diffuse_core_lib::MutationOutcome::Applied,
            diffuse_core_lib::MutationOutcome::Stale,
        ] {
            let value = serialize(diffuse_core_lib::WorkspaceUiStateMutationResult {
                outcome,
                record: diffuse_core_lib::WorkspaceUiStateRecord {
                    revision: 7,
                    state: json!({ "route": "review" }),
                    updated_at: "1234".to_owned(),
                },
            })
            .unwrap();
            assert_eq!(
                value,
                json!({
                    "outcome": match outcome {
                        diffuse_core_lib::MutationOutcome::Applied => "applied",
                        diffuse_core_lib::MutationOutcome::Stale => "stale",
                        _ => unreachable!(),
                    },
                    "record": {
                        "revision": 7,
                        "state": { "route": "review" },
                        "updatedAt": "1234",
                    },
                })
            );
        }
    }

    #[test]
    fn health_reports_recoverable_delivery_failure_and_shutdown_timeout() {
        let health = HealthState::default();
        health.mark_degraded(NativeFailure::new(
            "NATIVE_EVENT_DELIVERY_FAILED",
            "event delivery failed",
        ));
        health.shutdown_timed_out.store(true, Ordering::Release);

        let snapshot = health.snapshot();
        assert_eq!(snapshot["status"], "degraded");
        assert_eq!(snapshot["shutdownTimedOut"], true);
        assert_eq!(
            snapshot["lastBoundaryFailure"]["code"],
            "NATIVE_EVENT_DELIVERY_FAILED"
        );
    }

    #[test]
    fn normal_task_panic_marks_unhealthy_and_rejects_further_normal_work() {
        let health = HealthState::default();
        let caught = catch_unwind(AssertUnwindSafe(|| panic!("normal task panic fixture")));
        assert!(caught.is_err());

        record_task_panic(&health, TaskKind::Normal, NativeFailure::panic());
        assert_eq!(health.snapshot()["status"], "unhealthy");
        assert_eq!(
            health.require_running().unwrap_err().code,
            "NATIVE_CORE_UNHEALTHY"
        );
        health.mark_degraded(NativeFailure::new(
            "NATIVE_EVENT_DELIVERY_FAILED",
            "recoverable delivery failure",
        ));
        assert_eq!(health.snapshot()["status"], "unhealthy");
    }

    #[test]
    fn shutdown_timeout_stays_stopping_until_detached_work_records_completion() {
        let health = Arc::new(HealthState::default());
        assert!(health.begin_stopping());

        let timeout = health
            .wait_for_shutdown(Duration::from_millis(1))
            .unwrap_err();
        assert_eq!(timeout, NativeFailure::shutdown_timeout());
        assert_eq!(health.snapshot()["status"], "stopping");
        assert_eq!(health.snapshot()["shutdownTimedOut"], true);
        assert_eq!(
            health
                .wait_for_shutdown(Duration::from_millis(1))
                .unwrap_err(),
            timeout
        );

        let worker_health = health.clone();
        let worker = thread::spawn(move || worker_health.finish_shutdown(Ok(())));
        worker.join().unwrap();

        health.wait_for_shutdown(Duration::from_millis(10)).unwrap();
        assert_eq!(health.snapshot()["status"], "stopped");
        assert_eq!(health.snapshot()["shutdownTimedOut"], true);
    }

    #[test]
    fn event_batches_stop_at_the_bounded_count() {
        let mut next = 2;
        let batch = collect_event_batch(event(1), |_| {
            let current = next;
            next += 1;
            Ok(event(current))
        });

        assert_eq!(batch.len(), EVENT_BATCH_MAX_COUNT);
        assert_eq!(batch.first().unwrap().sequence, 1);
        assert_eq!(batch.last().unwrap().sequence, EVENT_BATCH_MAX_COUNT as u64);
    }

    #[test]
    fn event_batches_finish_when_the_short_window_has_no_more_events() {
        let batch = collect_event_batch(event(1), |_| Err(mpsc::RecvTimeoutError::Timeout));

        assert_eq!(batch.len(), 1);
    }

    #[test]
    fn every_health_status_has_the_backend_contract_spelling() {
        let health = HealthState::default();
        for (state, expected) in [
            (STATE_HEALTHY, "healthy"),
            (STATE_DEGRADED, "degraded"),
            (STATE_UNHEALTHY, "unhealthy"),
            (STATE_STOPPING, "stopping"),
            (STATE_STOPPED, "stopped"),
        ] {
            health.state.store(state, Ordering::Release);
            assert_eq!(health.snapshot()["status"], expected);
        }
    }

    #[test]
    fn request_helper_accepts_nested_desktop_context_and_contract_id_names() {
        let workspace_id = WorkspaceId::new();
        let generation = WorkspaceGeneration::new();
        let attention: AttentionCasRequest = deserialize_request(json!({
            "context": {
                "workspaceId": workspace_id,
                "workspaceGeneration": generation,
                "requestId": "ack"
            },
            "attentionId": "attention-1",
            "revision": 7
        }))
        .unwrap();
        assert_eq!(attention.workspace_id, workspace_id);
        assert_eq!(attention.workspace_generation, generation);
        assert_eq!(attention.attention_id, "attention-1");
        assert_eq!(attention.expected_revision, 7);

        let input: InputCasRequest = deserialize_request(json!({
            "context": {
                "workspaceId": workspace_id,
                "workspaceGeneration": generation,
                "requestId": "cancel"
            },
            "inputRequestId": "input-1",
            "revision": 3
        }))
        .unwrap();
        assert_eq!(input.input_id, "input-1");
        assert_eq!(input.expected_revision, 3);

        let ui: SaveWorkspaceUiStateRequest = deserialize_request(json!({
            "workspaceId": workspace_id,
            "workspaceGeneration": generation,
            "expectedRevision": 9_007_199_254_740_991_u64,
            "state": { "route": "review" }
        }))
        .unwrap();
        assert_eq!(ui.workspace_id, workspace_id);
        assert_eq!(ui.workspace_generation, generation);
        assert_eq!(ui.expected_revision, 9_007_199_254_740_991);
    }

    #[test]
    fn request_helper_rejects_conflicting_or_malformed_nested_contexts() {
        let workspace_id = WorkspaceId::new();
        let other_workspace_id = WorkspaceId::new();
        let generation = WorkspaceGeneration::new();
        let conflict = deserialize_request::<AttentionCasRequest>(json!({
            "workspaceId": workspace_id,
            "workspaceGeneration": generation,
            "context": {
                "workspaceId": other_workspace_id,
                "workspaceGeneration": generation
            },
            "attentionId": "attention",
            "revision": 1
        }))
        .unwrap_err();
        assert_eq!(conflict.code, "InvalidParams");
        assert!(conflict.message.contains("conflicting"));

        let malformed = deserialize_request::<AttentionCasRequest>(json!({
            "workspaceId": workspace_id,
            "workspaceGeneration": generation,
            "context": "wrong",
            "attentionId": "attention",
            "revision": 1
        }))
        .unwrap_err();
        assert_eq!(malformed.code, "InvalidParams");
        assert!(malformed.message.contains("must be an object"));
    }

    #[test]
    fn restoration_state_is_a_shared_completion_barrier() {
        let restoration = Arc::new(RestorationState::default());
        let waiters = (0..2)
            .map(|_| {
                let restoration = restoration.clone();
                thread::spawn(move || restoration.wait())
            })
            .collect::<Vec<_>>();
        thread::sleep(Duration::from_millis(5));
        restoration.finish(Ok(()));

        for waiter in waiters {
            waiter.join().unwrap().unwrap();
        }
    }
}
