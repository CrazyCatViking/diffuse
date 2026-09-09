use crate::{CoreError, CoreResult};
use std::time::{Duration, Instant};

/// Cooperative cancellation for synchronous work, backed by a real process
/// kill/reap boundary in Repository rather than aborting a blocking-task handle.
#[derive(Clone, Debug)]
pub(crate) struct OperationControl {
    cancelled: tokio::sync::watch::Sender<bool>,
    deadline: Instant,
}
impl OperationControl {
    pub fn new(timeout: Duration) -> Self {
        Self {
            cancelled: tokio::sync::watch::channel(false).0,
            deadline: Instant::now() + timeout,
        }
    }
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
    }
    pub fn check(&self) -> CoreResult<()> {
        if *self.cancelled.borrow() || Instant::now() >= self.deadline {
            Err(CoreError::TaskFailed(
                "MCP operation cancelled or deadline exceeded".into(),
            ))
        } else {
            Ok(())
        }
    }
    pub async fn interrupted(&self) {
        let mut receiver = self.cancelled.subscribe();
        tokio::select! {
            _=async {let _=receiver.wait_for(|v|*v).await;}=>{},
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(self.deadline))=>{},
        }
        self.cancel();
    }
}
