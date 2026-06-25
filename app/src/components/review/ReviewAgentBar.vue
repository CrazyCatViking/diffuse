<template>
  <section class="review-agent-shell">
    <Toolbar class="review-agent-bar" density="compact" borderless>
      <div class="review-agent-copy">
        <Badge tone="ai">AI review</Badge>

        <span class="message">{{ message }}</span>

        <span v-if="session" class="session-id" :title="session.id">{{ shortSessionId }}</span>
      </div>

      <div class="review-agent-actions">
        <span v-if="progressText" class="progress">{{ progressText }}</span>

        <Button variant="secondary" size="sm" :disabled="sessions.length === 0 && runs.length === 0" @click="showHistory = !showHistory">
          History
        </Button>

        <Button variant="secondary" size="sm" :disabled="loading || !enabled" @click="emit('newSession')">New session</Button>

        <Button v-if="activeRun" variant="danger" size="sm" :disabled="loading" @click="emit('stop')">Stop review</Button>

        <Button v-else variant="ai" size="sm" :disabled="loading || !enabled" @click="emit('start')">Start AI review</Button>
      </div>
    </Toolbar>

    <div v-if="showHistory" class="review-history">
      <div class="history-column">
        <span class="history-title">Sessions</span>

        <span v-if="recentSessions.length === 0" class="history-empty">No review sessions yet</span>

        <div v-for="item in recentSessions" :key="item.id" class="history-row" :class="{ current: item.id === session?.id }">
          <span>{{ item.title ?? item.id }}<template v-if="item.id === session?.id"> (current)</template></span>

          <span>{{ formatDate(item.updatedAt) }}</span>
        </div>
      </div>

      <div class="history-column">
        <span class="history-title">Runs</span>

        <span v-if="recentRuns.length === 0" class="history-empty">No agent runs yet</span>

        <div v-for="item in recentRuns" :key="item.id" class="history-row">
          <span>{{ item.provider }} · {{ item.status }}</span>

          <span>{{ formatDate(item.updatedAt) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReviewAgentState, ReviewProgress, ReviewRun, ReviewSession } from '../../lib/protocol';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import Toolbar from '../ui/Toolbar.vue';

const props = defineProps<{
  enabled: boolean;
  loading: boolean;
  progress: ReviewProgress | null;
  activeRun: ReviewRun | null;
  activeAgentState: ReviewAgentState | null;
  session: ReviewSession | null;
  sessions: ReviewSession[];
  runs: ReviewRun[];
  openThreadCount: number;
  error?: string;
}>();

const emit = defineEmits<{
  newSession: [];
  start: [];
  stop: [];
}>();

const showHistory = ref(false);

const message = computed(() => {
  if (props.error) return props.error;
  if (liveAgentMessage.value) return liveAgentMessage.value;
  if (props.activeRun?.message) return props.activeRun.message;
  if (props.progress?.message) return props.progress.message;
  if (props.activeRun) return 'Review agent is running';
  if (!props.enabled) return 'Open a repository with changed files to start a review';
  return `${props.openThreadCount} open review thread${props.openThreadCount === 1 ? '' : 's'}`;
});

const liveAgentMessage = computed(() => {
  const agent = props.activeAgentState;
  if (!agent) return undefined;
  const summary = agent.lastThoughtSummary?.trim();
  const file = agent.currentFile?.trim();
  if (file && summary) return truncateStatus(`${file}: ${summary}`);
  if (summary) return truncateStatus(summary);
  if (file) return truncateStatus(`Reviewing ${file}`);
  return undefined;
});

const truncateStatus = (value: string) => (value.length > 150 ? `${value.slice(0, 147)}...` : value);

const shortSessionId = computed(() => props.session?.id.replace(/^session-/, '').slice(0, 12));

const progressText = computed(() => {
  if (!props.progress || props.progress.totalFiles === undefined || props.progress.reviewedFiles === undefined) return undefined;
  return `${props.progress.reviewedFiles}/${props.progress.totalFiles} files`;
});

const recentSessions = computed(() => {
  return [...props.sessions].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)).slice(0, 5);
});

const recentRuns = computed(() => {
  return [...props.runs].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)).slice(0, 6);
});

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
</script>

<style scoped lang="scss">
.review-agent-shell {
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-shell);
}

.review-agent-bar {
  min-width: 0;
}

.review-agent-copy,
.review-agent-actions {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  min-width: 0;
}

.message {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  color: var(--color-success);
  font-size: var(--font-size-label);
  white-space: nowrap;
}

.session-id {
  flex: 0 0 auto;
  max-width: 160px;
  overflow: hidden;
  padding: 2px 6px;
  color: var(--color-text-subtle);
  background: var(--color-bg-hover);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-history {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-7);
  padding: 0 1rem 0.75rem;
}

.history-column {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}

.history-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.history-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-7);
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.history-row.current {
  color: #dbe7ff;
}

.history-row span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row span:last-child,
.history-empty {
  color: var(--color-text-disabled);
  white-space: nowrap;
}
</style>
