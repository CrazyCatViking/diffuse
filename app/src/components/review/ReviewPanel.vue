<template>
  <aside class="review-panel" aria-label="Review cockpit">
    <header class="panel-header">
      <div>
        <Badge tone="review">Review cockpit</Badge>

        <h2>{{ session?.title ?? 'Local review' }}</h2>
      </div>

      <div class="panel-actions">
        <Badge :tone="session ? 'success' : 'neutral'">{{ session?.status ?? 'starting' }}</Badge>

        <Button v-if="closable" variant="ghost" size="sm" @click="emit('close')">Close</Button>
      </div>
    </header>

    <div v-if="error" class="error-callout" role="alert">{{ error }}</div>

    <section class="progress-card">
      <div class="progress-heading">
        <span>{{ reviewedCount }} of {{ totalFiles }} files reviewed</span>

        <span>{{ reviewedPercent }}%</span>
      </div>

      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" :style="{ width: `${reviewedPercent}%` }" />
      </div>

      <div class="metric-grid">
        <div class="metric">
          <span class="metric-value">{{ openThreads.length }}</span>

          <span class="metric-label">Open threads</span>
        </div>

        <div class="metric">
          <span class="metric-value">{{ resolvedThreads.length }}</span>

          <span class="metric-label">Resolved</span>
        </div>

        <div class="metric">
          <span class="metric-value">{{ agentStatus }}</span>

          <span class="metric-label">AI review</span>
        </div>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-heading">
        <h3>AI Activity</h3>

        <Button v-if="activeRun" variant="danger" size="sm" :disabled="loading" @click="emit('stopReview')">Stop</Button>

        <Button v-else variant="ai" size="sm" :disabled="loading || totalFiles === 0" @click="emit('startReview')">Start</Button>
      </div>

      <div class="activity-card">
        <div class="activity-message">{{ activityMessage }}</div>

        <div v-if="progressText" class="activity-detail">{{ progressText }}</div>

        <div v-if="activeAgentState?.currentPhase" class="activity-detail">{{ activeAgentState.currentPhase }}</div>
      </div>

      <Button variant="secondary" size="sm" :disabled="loading" block @click="emit('newSession')">New review session</Button>
    </section>

    <section class="panel-section files-section">
      <div class="section-heading">
        <h3>Files</h3>

        <Badge tone="neutral">{{ totalFiles }}</Badge>
      </div>

      <EmptyState
        v-if="changedFiles.length === 0"
        class="compact-empty"
        align="start"
        bordered
        title="No changed files"
        description="Review progress appears here when files change."
      />

      <div v-else class="file-list">
        <button
          v-for="file in changedFiles"
          :key="file.id"
          class="file-item"
          :class="{ active: file.id === activeFileId, reviewed: reviewedFileIds.includes(file.id) }"
          type="button"
          @click="emit('selectFile', file.id)"
        >
          <span class="file-status" :class="`status-${file.status}`">{{ statusLabel(file.status) }}</span>

          <span class="file-path">{{ filePath(file) }}</span>

          <span class="file-reviewed">{{ reviewedFileIds.includes(file.id) ? 'Reviewed' : 'Open' }}</span>
        </button>
      </div>
    </section>

    <section class="panel-section threads-section">
      <div class="section-heading">
        <h3>Threads</h3>

        <Badge :tone="filteredThreads.length > 0 ? 'warning' : 'success'">{{ filteredThreads.length }} shown</Badge>
      </div>

      <div class="thread-filters" role="group" aria-label="Thread filters">
        <Button
          v-for="filter in threadFilters"
          :key="filter.value"
          variant="secondary"
          size="sm"
          :pressed="threadFilter === filter.value"
          :aria-pressed="threadFilter === filter.value"
          :disabled="filter.value === 'current' && !activeFileId"
          @click="threadFilter = filter.value"
        >
          {{ filter.label }}
        </Button>
      </div>

      <EmptyState
        v-if="threads.length === 0"
        class="compact-empty"
        align="start"
        bordered
        title="No review threads"
        description="Line comments and AI findings will appear here."
      />

      <EmptyState
        v-else-if="filteredThreads.length === 0"
        class="compact-empty"
        align="start"
        bordered
        title="No matching threads"
        description="Change the filter to see more review threads."
      />

      <div v-else class="thread-list">
        <article
          v-for="thread in filteredThreads"
          :key="thread.id"
          class="thread-card"
          :class="[thread.status, { flashing: thread.id === flashingThreadId }]"
        >
          <button class="thread-target" type="button" @click="emit('selectThread', thread)">
            <span class="thread-file">{{ threadPath(thread) }}</span>

            <span class="thread-line">{{ anchorLabel(thread) }}</span>
          </button>

          <p>{{ threadSummary(thread) }}</p>

          <div class="thread-meta">
            <Badge :tone="thread.status === 'open' ? 'warning' : 'success'">{{ thread.status }}</Badge>

            <Badge v-if="thread.source?.kind === 'agent'" tone="ai">AI</Badge>

            <span>{{ formatDate(thread.updatedAt) }}</span>

            <Button v-if="thread.status === 'open'" variant="ghost" size="sm" @click="emit('resolveThread', thread)">Resolve</Button>

            <Button v-else variant="ghost" size="sm" @click="emit('reopenThread', thread)">Reopen</Button>
          </div>
        </article>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ChangedFile, ReviewAgentState, ReviewProgress, ReviewRun, ReviewSession, ReviewThread } from '../../lib/protocol';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';

const props = withDefaults(
  defineProps<{
    changedFiles: ChangedFile[];
    activeFileId?: string;
    reviewedFileIds: string[];
    session: ReviewSession | null;
    progress: ReviewProgress | null;
    activeRun: ReviewRun | null;
    activeAgentState: ReviewAgentState | null;
    threads: ReviewThread[];
    loading: boolean;
    error?: string;
    closable?: boolean;
    threadRevealRequest?: {
      threadId: string;
      fileId: string;
      requestId: number;
    };
  }>(),
  {
    closable: false,
  },
);

const emit = defineEmits<{
  selectFile: [fileId: string];
  newSession: [];
  startReview: [];
  stopReview: [];
  selectThread: [thread: ReviewThread];
  resolveThread: [thread: ReviewThread];
  reopenThread: [thread: ReviewThread];
  close: [];
}>();

type ThreadFilter = 'all' | 'open' | 'resolved' | 'ai' | 'current';

const threadFilters: { value: ThreadFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ai', label: 'AI' },
  { value: 'current', label: 'Current file' },
];

const threadFilter = ref<ThreadFilter>('all');
const flashingThreadId = ref<string>();
const threadFlashDurationMs = 1800;
let threadFlashTimer: number | undefined;

const totalFiles = computed(() => props.changedFiles.length);
const reviewedCount = computed(() => props.changedFiles.filter((file) => props.reviewedFileIds.includes(file.id)).length);
const reviewedPercent = computed(() => (totalFiles.value === 0 ? 0 : Math.round((reviewedCount.value / totalFiles.value) * 100)));
const openThreads = computed(() => props.threads.filter((thread) => thread.status === 'open'));
const resolvedThreads = computed(() => props.threads.filter((thread) => thread.status === 'resolved'));
const orderedThreads = computed(() => [...props.threads].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)));
const filteredThreads = computed(() => {
  return orderedThreads.value.filter((thread) => {
    if (threadFilter.value === 'open') return thread.status === 'open';
    if (threadFilter.value === 'resolved') return thread.status === 'resolved';
    if (threadFilter.value === 'ai') return thread.source?.kind === 'agent';
    if (threadFilter.value === 'current') return Boolean(props.activeFileId && thread.fileId === props.activeFileId);
    return true;
  });
});
const agentStatus = computed(() => props.activeRun?.status ?? props.progress?.status ?? 'idle');
const progressText = computed(() => {
  const progress = props.progress;
  if (!progress || progress.totalFiles === undefined || progress.reviewedFiles === undefined) return undefined;
  return `${progress.reviewedFiles}/${progress.totalFiles} files reviewed by AI`;
});
const activityMessage = computed(() => {
  if (props.activeAgentState?.currentFile && props.activeAgentState.lastThoughtSummary) {
    return `${props.activeAgentState.currentFile}: ${props.activeAgentState.lastThoughtSummary}`;
  }
  if (props.activeAgentState?.lastThoughtSummary) return props.activeAgentState.lastThoughtSummary;
  if (props.activeRun?.message) return props.activeRun.message;
  if (props.progress?.message) return props.progress.message;
  if (props.activeRun) return 'Review agent is running.';
  return 'Start an AI review to populate findings and progress here.';
});

const filePath = (file: ChangedFile) => file.newPath ?? file.oldPath ?? file.id;
const threadPath = (thread: ReviewThread) => thread.newPath ?? thread.oldPath ?? thread.fileId;
const statusLabel = (status: ChangedFile['status']) => {
  return {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[status];
};
const anchorLabel = (thread: ReviewThread) => {
  const side = thread.anchor.side === 'old' ? 'old' : 'new';
  const range =
    thread.anchor.startLine === thread.anchor.endLine
      ? `${thread.anchor.startLine}`
      : `${thread.anchor.startLine}-${thread.anchor.endLine}`;
  return `${side}:${range}`;
};
const threadSummary = (thread: ReviewThread) => {
  return thread.messages.at(-1)?.body ?? thread.anchor.selectedText ?? thread.anchor.lineText ?? 'Review thread';
};
const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const flashThread = async (threadId: string) => {
  if (threadFlashTimer) window.clearTimeout(threadFlashTimer);
  flashingThreadId.value = undefined;
  await nextTick();
  flashingThreadId.value = threadId;
  threadFlashTimer = window.setTimeout(() => {
    if (flashingThreadId.value === threadId) flashingThreadId.value = undefined;
    threadFlashTimer = undefined;
  }, threadFlashDurationMs);
};

watch(
  () => props.threadRevealRequest?.requestId,
  () => {
    const request = props.threadRevealRequest;
    if (request) void flashThread(request.threadId);
  },
);

onBeforeUnmount(() => {
  if (threadFlashTimer) window.clearTimeout(threadFlashTimer);
});
</script>

<style scoped lang="scss">
.review-panel {
  display: grid;
  align-content: start;
  gap: var(--space-7);
  min-width: 0;
  min-height: 0;
  padding: var(--space-7);
  overflow: auto;
  color: var(--color-text-secondary);
  background: var(--color-bg-shell);
  border-left: 1px solid var(--color-border-subtle);
}

.panel-header,
.panel-actions,
.section-heading,
.thread-meta,
.progress-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  min-width: 0;
}

.panel-actions {
  flex: 0 0 auto;
}

h2,
h3,
p {
  margin: 0;
}

h2 {
  margin-top: var(--space-3);
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
  line-height: 1.2;
}

h3 {
  color: var(--color-text-primary);
  font-size: var(--font-size-body-lg);
}

.error-callout {
  padding: var(--space-5) var(--space-6);
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border: 1px solid rgba(255, 107, 107, 0.28);
  border-radius: var(--radius-4);
  font-size: var(--font-size-body);
}

.progress-card,
.activity-card,
.thread-card {
  display: grid;
  gap: var(--space-5);
  padding: var(--space-6);
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);
}

.progress-heading {
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  font-weight: 650;
}

.progress-track {
  height: 8px;
  overflow: hidden;
  background: var(--color-bg-inset);
  border-radius: var(--radius-pill);
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-review), var(--color-accent-hover));
  border-radius: inherit;
  transition: width var(--transition-fast);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}

.metric {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.metric-value {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-label,
.activity-detail,
.thread-meta span {
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.panel-section {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}

.activity-message {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.compact-empty {
  padding: var(--space-6);

  :deep(h1) {
    font-size: var(--font-size-body-lg);
  }

  :deep(p) {
    font-size: var(--font-size-body);
  }
}

.file-list,
.thread-list,
.thread-filters {
  display: grid;
  gap: var(--space-3);
}

.thread-filters {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.file-item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  font: inherit;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
  }

  &.active {
    background: var(--color-bg-active);
    border-color: var(--color-border-default);
  }

  &.reviewed .file-path {
    color: var(--color-success);
  }
}

.file-status {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  border-radius: var(--radius-2);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.status-added {
  color: var(--color-success);
  background: var(--color-success-muted);
  border-color: rgba(91, 184, 119, 0.25);
}

.status-modified,
.status-renamed {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(143, 179, 255, 0.25);
}

.status-deleted {
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border-color: rgba(255, 107, 107, 0.25);
}

.file-path,
.thread-file {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-reviewed {
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.thread-card.resolved {
  opacity: 0.72;
}

.thread-card.flashing {
  animation: thread-card-flash 1800ms ease-out;
}

.thread-target {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  min-width: 0;
  padding: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  font: inherit;
}

.thread-file {
  color: var(--color-text-primary);
  font-weight: 650;
}

.thread-line {
  color: var(--color-text-subtle);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.thread-card p {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.thread-meta {
  justify-content: start;
  flex-wrap: wrap;
}

@keyframes thread-card-flash {
  0%,
  22% {
    background: linear-gradient(90deg, var(--color-review-muted), var(--color-bg-panel) 28px);
    border-color: rgba(240, 195, 106, 0.34);
    box-shadow:
      var(--shadow-inset-highlight),
      0 0 0 1px rgba(240, 195, 106, 0.14);
  }

  100% {
    background: var(--color-bg-panel);
    border-color: var(--color-border-subtle);
    box-shadow: var(--shadow-inset-highlight);
  }
}
</style>
