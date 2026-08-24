use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak, mpsc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{WorkspaceGeneration, WorkspaceId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchEvent {
    pub sequence: u64,
    pub event_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_generation: Option<WorkspaceGeneration>,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventReplay {
    pub events: Vec<WorkbenchEvent>,
    pub requires_snapshot: bool,
}

pub struct EventHub {
    capacity: usize,
    inner: Arc<EventHubInner>,
}

struct EventHubInner {
    publish: Mutex<()>,
    state: Mutex<EventState>,
}

struct EventState {
    next_sequence: u64,
    events: VecDeque<WorkbenchEvent>,
    next_subscriber_id: u64,
    subscribers: HashMap<u64, mpsc::SyncSender<WorkbenchEvent>>,
}

#[derive(Clone)]
pub struct EventSubscription {
    inner: Arc<EventSubscriptionInner>,
}

struct EventSubscriptionInner {
    subscriber_id: u64,
    hub: Weak<EventHubInner>,
    receiver: Mutex<mpsc::Receiver<WorkbenchEvent>>,
}

impl EventSubscription {
    pub fn close(&self) {
        let Some(hub) = self.inner.hub.upgrade() else {
            return;
        };
        hub.state
            .lock()
            .expect("event hub lock poisoned")
            .subscribers
            .remove(&self.inner.subscriber_id);
    }
}

impl Iterator for EventSubscription {
    type Item = WorkbenchEvent;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner
            .receiver
            .lock()
            .expect("event subscription lock poisoned")
            .recv()
            .ok()
    }
}

impl Drop for EventSubscriptionInner {
    fn drop(&mut self) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        hub.state
            .lock()
            .expect("event hub lock poisoned")
            .subscribers
            .remove(&self.subscriber_id);
    }
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "event replay capacity must be positive");
        Self {
            capacity,
            inner: Arc::new(EventHubInner {
                publish: Mutex::new(()),
                state: Mutex::new(EventState {
                    next_sequence: 1,
                    events: VecDeque::with_capacity(capacity),
                    next_subscriber_id: 1,
                    subscribers: HashMap::new(),
                }),
            }),
        }
    }

    pub fn current_sequence(&self) -> u64 {
        self.inner
            .state
            .lock()
            .expect("event hub lock poisoned")
            .next_sequence
            .saturating_sub(1)
    }

    pub fn subscribe(&self, capacity: usize) -> (u64, EventSubscription) {
        assert!(capacity > 0, "event subscription capacity must be positive");
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let mut state = self.inner.state.lock().expect("event hub lock poisoned");
        let subscriber_id = state.next_subscriber_id;
        state.next_subscriber_id += 1;
        state.subscribers.insert(subscriber_id, sender);
        let sequence = state.next_sequence.saturating_sub(1);
        drop(state);

        (
            sequence,
            EventSubscription {
                inner: Arc::new(EventSubscriptionInner {
                    subscriber_id,
                    hub: Arc::downgrade(&self.inner),
                    receiver: Mutex::new(receiver),
                }),
            },
        )
    }

    pub fn publish(
        &self,
        kind: impl Into<String>,
        workspace: Option<(WorkspaceId, WorkspaceGeneration)>,
        payload: Value,
    ) -> WorkbenchEvent {
        let kind = kind.into();
        if tokio::runtime::Handle::try_current().is_ok_and(|handle| {
            handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        }) {
            tokio::task::block_in_place(|| self.publish_blocking(kind, workspace, payload))
        } else {
            self.publish_blocking(kind, workspace, payload)
        }
    }

    fn publish_blocking(
        &self,
        kind: String,
        workspace: Option<(WorkspaceId, WorkspaceGeneration)>,
        payload: Value,
    ) -> WorkbenchEvent {
        // Serializing publication lets the state lock go before subscriber delivery without
        // allowing concurrent publishers to enqueue events out of sequence.
        let _publish = self
            .inner
            .publish
            .lock()
            .expect("event publisher lock poisoned");
        let (event, subscribers) = {
            let mut state = self.inner.state.lock().expect("event hub lock poisoned");
            let event = WorkbenchEvent {
                sequence: state.next_sequence,
                event_id: Uuid::new_v4().to_string(),
                kind,
                workspace_id: workspace.map(|value| value.0),
                workspace_generation: workspace.map(|value| value.1),
                payload,
            };
            state.next_sequence += 1;
            if state.events.len() == self.capacity {
                state.events.pop_front();
            }
            state.events.push_back(event.clone());
            let subscribers = state
                .subscribers
                .iter()
                .map(|(&id, sender)| (id, sender.clone()))
                .collect::<Vec<_>>();
            (event, subscribers)
        };

        let mut closed = Vec::new();
        for (id, subscriber) in subscribers {
            if subscriber.send(event.clone()).is_err() {
                closed.push(id);
            }
        }
        if !closed.is_empty() {
            let mut state = self.inner.state.lock().expect("event hub lock poisoned");
            for id in closed {
                state.subscribers.remove(&id);
            }
        }
        event
    }

    pub fn replay_after(&self, sequence: u64) -> EventReplay {
        let state = self.inner.state.lock().expect("event hub lock poisoned");
        let first = state.events.front().map(|event| event.sequence);
        let requires_snapshot = first.is_some_and(|first| sequence.saturating_add(1) < first);
        EventReplay {
            events: if requires_snapshot {
                Vec::new()
            } else {
                state
                    .events
                    .iter()
                    .filter(|event| event.sequence > sequence)
                    .cloned()
                    .collect()
            },
            requires_snapshot,
        }
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new(1024)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    #[test]
    fn replays_ordered_events_and_reports_evicted_gaps() {
        let hub = EventHub::new(2);
        hub.publish("one", None, json!({}));
        hub.publish("two", None, json!({}));
        hub.publish("three", None, json!({}));

        assert!(hub.replay_after(0).requires_snapshot);
        let replay = hub.replay_after(1);
        assert!(!replay.requires_snapshot);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            [2, 3]
        );
    }

    #[test]
    fn concurrent_publication_keeps_queue_and_sequence_order_aligned() {
        let hub = Arc::new(EventHub::new(64));
        let publishers = (0..32)
            .map(|index| {
                let hub = hub.clone();
                thread::spawn(move || hub.publish(format!("event-{index}"), None, json!({})))
            })
            .collect::<Vec<_>>();
        for publisher in publishers {
            publisher.join().unwrap();
        }

        let replay = hub.replay_after(0);
        assert!(!replay.requires_snapshot);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            (1..=32).collect::<Vec<_>>()
        );
    }

    #[test]
    fn cloned_subscriptions_share_one_ordered_receiver() {
        let hub = EventHub::new(4);
        let (sequence, mut subscription) = hub.subscribe(2);
        let mut clone = subscription.clone();
        hub.publish("one", None, json!({}));
        hub.publish("two", None, json!({}));

        assert_eq!(sequence, 0);
        assert_eq!(subscription.next().unwrap().sequence, 1);
        assert_eq!(clone.next().unwrap().sequence, 2);
    }

    #[test]
    fn slow_bounded_subscription_receives_more_than_the_replay_window_without_loss() {
        const EVENT_COUNT: u64 = 2_048;

        let hub = Arc::new(EventHub::new(32));
        let (sequence, mut subscription) = hub.subscribe(8);
        let publisher = {
            let hub = hub.clone();
            thread::spawn(move || {
                for index in 0..EVENT_COUNT {
                    hub.publish("search/progress", None, json!({ "index": index }));
                }
            })
        };

        let received = (0..EVENT_COUNT)
            .map(|_| {
                thread::sleep(Duration::from_micros(50));
                subscription.next().unwrap().sequence
            })
            .collect::<Vec<_>>();
        publisher.join().unwrap();

        assert_eq!(sequence, 0);
        assert_eq!(received, (1..=EVENT_COUNT).collect::<Vec<_>>());
        assert!(hub.replay_after(0).requires_snapshot);
    }
}
