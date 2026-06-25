<template>
  <section class="review-agent-shell">
    <div class="review-agent-bar">
      <div class="review-agent-copy">
        <span class="label">AI review</span>

        <span class="message">{{ message }}</span>

        <span v-if="session" class="session-id" :title="session.id">{{ shortSessionId }}</span>
      </div>

      <div class="review-agent-actions">
        <span v-if="progressText" class="progress">{{ progressText }}</span>

        <Button :disabled="sessions.length === 0 && runs.length === 0" @click="showHistory = !showHistory">History</Button>

        <Button :disabled="loading || !enabled" @click="emit('newSession')">New session</Button>

        <Button v-if="activeRun" :disabled="loading" @click="emit('stop')">Stop review</Button>

        <Button v-else :disabled="loading || !enabled" @click="emit('start')">Start AI review</Button>
      </div>
    </div>

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
  border-bottom: 1px solid #252a35;
  background: #111722;
}

.review-agent-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  padding: 0.65rem 1rem;
}

.review-agent-copy,
.review-agent-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.label {
  color: #f5f7fb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message {
  min-width: 0;
  overflow: hidden;
  color: #98a2b3;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  color: #8bd5a3;
  font-size: 12px;
  white-space: nowrap;
}

.session-id {
  flex: 0 0 auto;
  max-width: 160px;
  overflow: hidden;
  padding: 2px 6px;
  color: #8b95a7;
  background: #202635;
  border: 1px solid #2d3545;
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-history {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  padding: 0 1rem 0.75rem;
}

.history-column {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
}

.history-title {
  color: #f5f7fb;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.history-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  color: #98a2b3;
  font-size: 12px;
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
  color: #697386;
  white-space: nowrap;
}
</style>
