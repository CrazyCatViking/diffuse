use std::collections::VecDeque;
use std::sync::Mutex;

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
    state: Mutex<EventState>,
}

struct EventState {
    next_sequence: u64,
    events: VecDeque<WorkbenchEvent>,
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "event replay capacity must be positive");
        Self {
            capacity,
            state: Mutex::new(EventState {
                next_sequence: 1,
                events: VecDeque::with_capacity(capacity),
            }),
        }
    }

    pub fn current_sequence(&self) -> u64 {
        self.state
            .lock()
            .expect("event hub lock poisoned")
            .next_sequence
            .saturating_sub(1)
    }

    pub fn publish(
        &self,
        kind: impl Into<String>,
        workspace: Option<(WorkspaceId, WorkspaceGeneration)>,
        payload: Value,
    ) -> WorkbenchEvent {
        let mut state = self.state.lock().expect("event hub lock poisoned");
        let event = WorkbenchEvent {
            sequence: state.next_sequence,
            event_id: Uuid::new_v4().to_string(),
            kind: kind.into(),
            workspace_id: workspace.map(|value| value.0),
            workspace_generation: workspace.map(|value| value.1),
            payload,
        };
        state.next_sequence += 1;
        if state.events.len() == self.capacity {
            state.events.pop_front();
        }
        state.events.push_back(event.clone());
        event
    }

    pub fn replay_after(&self, sequence: u64) -> EventReplay {
        let state = self.state.lock().expect("event hub lock poisoned");
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
}
