<template>
  <section class="review-overview" aria-label="Review overview">
    <header class="overview-hero">
      <div class="hero-copy">
        <Badge tone="review">Review overview</Badge>

        <h1>{{ session?.title ?? 'Local review' }}</h1>

        <p>{{ overviewSubtitle }}</p>
      </div>

      <div class="hero-actions">
        <Button variant="secondary" size="sm" :disabled="loading" @click="emit('newSession')">New session</Button>

        <Button v-if="activeRun" variant="danger" size="sm" :disabled="loading" @click="emit('stopReview')">Stop AI review</Button>

        <Button v-else variant="ai" size="sm" :disabled="loading || changedFiles.length === 0" @click="emit('startReview')">
          Start AI review
        </Button>
      </div>
    </header>

    <div v-if="error" class="error-callout" role="alert">{{ error }}</div>

    <section class="summary-grid" aria-label="Review session summary">
      <Panel class="summary-card progress-card" padding="md">
        <span class="card-kicker">Human review</span>

        <div class="metric-line">
          <span class="metric-value">{{ reviewedCount }}/{{ totalFiles }}</span>

          <Badge :tone="reviewedPercent === 100 && totalFiles > 0 ? 'success' : 'review'">{{ reviewedPercent }}%</Badge>
        </div>

        <div class="progress-track" aria-hidden="true">
          <div class="progress-fill" :style="{ width: `${reviewedPercent}%` }" />
        </div>

        <p>{{ reviewedCount }} {{ reviewedCount === 1 ? 'file' : 'files' }} marked reviewed.</p>
      </Panel>

      <Panel class="summary-card" padding="md">
        <span class="card-kicker">Changes</span>

        <div class="metric-line">
          <span class="metric-value">{{ totalFiles }}</span>

          <Badge tone="neutral">{{ additionsTotal }}+ / {{ deletionsTotal }}-</Badge>
        </div>

        <p>{{ changeStatusText }}</p>
      </Panel>

      <Panel class="summary-card" padding="md">
        <span class="card-kicker">Diagnostics</span>

        <div class="metric-line">
          <span class="metric-value">{{ diagnosticsHeadline }}</span>

          <Badge :tone="diagnosticsTone">{{ diagnosticsScanLabel }}</Badge>
        </div>

        <p>{{ diagnosticsDetail }}</p>
      </Panel>

      <Panel class="summary-card" padding="md">
        <span class="card-kicker">AI activity</span>

        <div class="metric-line">
          <span class="metric-value compact">{{ agentStatus }}</span>

          <Badge :tone="activeRun ? 'ai' : 'neutral'">{{ progressText ?? 'idle' }}</Badge>
        </div>

        <p>{{ activityMessage }}</p>
      </Panel>
    </section>

    <section class="content-grid">
      <Panel class="files-panel" padding="none">
        <header class="panel-header">
          <div>
            <h2>Changed files</h2>

            <p>{{ filePanelSubtitle }}</p>
          </div>

          <Badge tone="neutral">{{ totalFiles }}</Badge>
        </header>

        <EmptyState
          v-if="changedFiles.length === 0"
          class="panel-empty"
          align="start"
          bordered
          title="No changed files"
          description="Pick another compare target or refresh after editing files."
        />

        <div v-else class="file-overview-list">
          <article v-for="item in fileSummaries" :key="item.file.id" class="file-card" :class="{ reviewed: item.reviewed }">
            <button class="file-target" type="button" @click="emit('selectFile', item.file.id)">
              <span class="file-status" :class="`status-${item.file.status}`">{{ statusLabel(item.file.status) }}</span>

              <span class="file-copy">
                <span class="file-path">{{ item.path }}</span>

                <span class="file-stats">{{ item.file.additions }} additions, {{ item.file.deletions }} deletions</span>
              </span>
            </button>

            <div class="file-meta">
              <Badge :tone="item.reviewed ? 'success' : 'neutral'">{{ item.reviewed ? 'reviewed' : 'open' }}</Badge>

              <Badge :tone="item.openThreadCount > 0 ? 'warning' : item.threadCount > 0 ? 'success' : 'neutral'">
                {{ item.threadLabel }}
              </Badge>

              <Badge :tone="item.diagnosticTone" :title="item.diagnosticTitle">{{ item.diagnosticLabel }}</Badge>
            </div>
          </article>
        </div>
      </Panel>

      <Panel class="threads-panel" padding="none">
        <header class="panel-header">
          <div>
            <h2>Review threads</h2>

            <p>{{ threadPanelSubtitle }}</p>
          </div>

          <Badge :tone="openThreads.length > 0 ? 'warning' : 'success'">{{ openThreads.length }} open</Badge>
        </header>

        <div class="thread-filters" role="group" aria-label="Thread filters">
          <Button
            v-for="filter in threadFilters"
            :key="filter.value"
            variant="secondary"
            size="sm"
            :pressed="threadFilter === filter.value"
            :aria-pressed="threadFilter === filter.value"
            @click="threadFilter = filter.value"
          >
            {{ filter.label }}
          </Button>
        </div>

        <EmptyState
          v-if="threads.length === 0"
          class="panel-empty"
          align="start"
          bordered
          title="No review threads"
          description="Line comments and AI findings will appear here."
        />

        <EmptyState
          v-else-if="filteredThreads.length === 0"
          class="panel-empty"
          align="start"
          bordered
          title="No matching threads"
          description="Change the filter to see more review threads."
        />

        <div v-else class="thread-list">
          <article v-for="thread in filteredThreads" :key="thread.id" class="thread-card" :class="thread.status">
            <button class="thread-target" type="button" @click="emit('selectThread', thread)">
              <span class="thread-file">{{ threadPath(thread) }}</span>

              <span class="thread-line">{{ anchorLabel(thread) }}</span>
            </button>

            <p>{{ threadSummary(thread) }}</p>

            <div class="thread-meta">
              <Badge :tone="thread.status === 'open' ? 'warning' : 'success'">{{ thread.status }}</Badge>

              <Badge v-if="thread.source?.kind === 'agent'" tone="ai">AI</Badge>

              <Badge v-if="thread.severity" :tone="severityTone(thread.severity)">{{ thread.severity }}</Badge>

              <span>{{ formatDate(thread.updatedAt) }}</span>

              <Button v-if="thread.status === 'open'" variant="ghost" size="sm" @click="emit('resolveThread', thread)">Resolve</Button>

              <Button v-else variant="ghost" size="sm" @click="emit('reopenThread', thread)">Reopen</Button>
            </div>
          </article>
        </div>
      </Panel>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ChangedFile, DiffTarget, LspDiagnostic, ReviewAgentState, ReviewProgress, ReviewRun, ReviewSession, ReviewThread } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import Button from '../Button.vue';
import { supportsLspFile } from '../diff/useLspHover';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'review' | 'ai';
type ThreadFilter = 'all' | 'open' | 'resolved' | 'ai';
type DiagnosticFileState = {
  status: 'checked' | 'unavailable' | 'failed';
  message?: string;
};
type DiagnosticScan = {
  running: boolean;
  checked: number;
  total: number;
  error?: string;
};

const props = defineProps<{
  changedFiles: ChangedFile[];
  target: DiffTarget;
  reviewedFileIds: string[];
  session: ReviewSession | null;
  progress: ReviewProgress | null;
  activeRun: ReviewRun | null;
  activeAgentState: ReviewAgentState | null;
  threads: ReviewThread[];
  loading: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  selectFile: [fileId: string];
  newSession: [];
  startReview: [];
  stopReview: [];
  selectThread: [thread: ReviewThread];
  resolveThread: [thread: ReviewThread];
  reopenThread: [thread: ReviewThread];
}>();

const client = useClient();
const threadFilters: { value: ThreadFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ai', label: 'AI' },
];
const threadFilter = ref<ThreadFilter>('all');
const diagnosticsByFile = ref<Record<string, LspDiagnostic[]>>({});
const diagnosticStateByFile = ref<Record<string, DiagnosticFileState>>({});
const diagnosticScan = ref<DiagnosticScan>({ running: false, checked: 0, total: 0 });
let diagnosticGeneration = 0;

const totalFiles = computed(() => props.changedFiles.length);
const reviewedCount = computed(() => props.changedFiles.filter((file) => props.reviewedFileIds.includes(file.id)).length);
const reviewedPercent = computed(() => (totalFiles.value === 0 ? 0 : Math.round((reviewedCount.value / totalFiles.value) * 100)));
const additionsTotal = computed(() => props.changedFiles.reduce((total, file) => total + file.additions, 0));
const deletionsTotal = computed(() => props.changedFiles.reduce((total, file) => total + file.deletions, 0));
const openThreads = computed(() => props.threads.filter((thread) => thread.status === 'open'));
const resolvedThreads = computed(() => props.threads.filter((thread) => thread.status === 'resolved'));
const orderedThreads = computed(() => [...props.threads].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)));
const filteredThreads = computed(() => {
  return orderedThreads.value.filter((thread) => {
    if (threadFilter.value === 'open') return thread.status === 'open';
    if (threadFilter.value === 'resolved') return thread.status === 'resolved';
    if (threadFilter.value === 'ai') return thread.source?.kind === 'agent';
    return true;
  });
});
const diagnosticsForChangedFiles = computed(() => Object.values(diagnosticsByFile.value).flat());
const diagnosticSummary = computed(() => {
  const diagnostics = diagnosticsForChangedFiles.value;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  return {
    errors,
    warnings,
    other: diagnostics.length - errors - warnings,
    total: diagnostics.length,
    unavailable: Object.values(diagnosticStateByFile.value).filter((state) => state.status === 'unavailable').length,
    failed: Object.values(diagnosticStateByFile.value).filter((state) => state.status === 'failed').length,
  };
});
const diagnosticEligibleFiles = computed(() => props.changedFiles.filter(shouldCheckDiagnostics));
const diagnosticsTone = computed<BadgeTone>(() => {
  if (diagnosticScan.value.running) return 'info';
  if (diagnosticSummary.value.errors > 0 || diagnosticSummary.value.failed > 0) return 'danger';
  if (diagnosticSummary.value.warnings > 0 || diagnosticSummary.value.unavailable > 0) return 'warning';
  if (diagnosticScan.value.total > 0) return 'success';
  return 'neutral';
});
const diagnosticsHeadline = computed(() => {
  const summary = diagnosticSummary.value;
  if (diagnosticScan.value.running) return `${diagnosticScan.value.checked}/${diagnosticScan.value.total}`;
  if (diagnosticScan.value.total === 0) return '0';
  if (summary.total === 0 && summary.unavailable + summary.failed > 0) return String(summary.unavailable + summary.failed);
  if (summary.total === 0) return 'Clean';
  return String(summary.total);
});
const diagnosticsScanLabel = computed(() => {
  if (diagnosticScan.value.running) return 'checking';
  if (diagnosticScan.value.total === 0) return 'not applicable';
  return 'checked';
});
const diagnosticsDetail = computed(() => {
  if (diagnosticEligibleFiles.value.length === 0) return 'No changed files with new-side LSP diagnostics support.';
  if (diagnosticScan.value.running) return `Checking diagnostics for ${diagnosticScan.value.total} supported files.`;
  if (diagnosticScan.value.error) return diagnosticScan.value.error;

  const parts = diagnosticParts(diagnosticSummary.value);
  if (parts.length === 0) return 'No diagnostics reported for supported changed files.';
  return parts.join(', ');
});
const agentStatus = computed(() => props.activeRun?.status ?? props.progress?.status ?? 'idle');
const progressText = computed(() => {
  if (!props.progress || props.progress.totalFiles === undefined || props.progress.reviewedFiles === undefined) return undefined;
  return `${props.progress.reviewedFiles}/${props.progress.totalFiles} files`;
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
const overviewSubtitle = computed(() => {
  if (!props.session) return 'Preparing the local review session.';
  return `${totalFiles.value} changed ${totalFiles.value === 1 ? 'file' : 'files'}, ${openThreads.value.length} open ${openThreads.value.length === 1 ? 'thread' : 'threads'}.`;
});
const changeStatusText = computed(() => {
  const counts = statusCounts.value;
  const parts = [
    counts.added > 0 ? `${counts.added} added` : undefined,
    counts.modified > 0 ? `${counts.modified} modified` : undefined,
    counts.renamed > 0 ? `${counts.renamed} renamed` : undefined,
    counts.deleted > 0 ? `${counts.deleted} deleted` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'No file changes in the current target.';
});
const statusCounts = computed<Record<ChangedFile['status'], number>>(() => {
  const counts: Record<ChangedFile['status'], number> = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const file of props.changedFiles) counts[file.status] += 1;
  return counts;
});
const filePanelSubtitle = computed(() => {
  if (diagnosticScan.value.running) return `Diagnostics ${diagnosticScan.value.checked}/${diagnosticScan.value.total} checked.`;
  return `${reviewedCount.value} reviewed, ${totalFiles.value - reviewedCount.value} open.`;
});
const threadPanelSubtitle = computed(() => {
  return `${props.threads.length} total, ${resolvedThreads.value.length} resolved.`;
});
const fileSummaries = computed(() => {
  return props.changedFiles.map((file) => {
    const threads = props.threads.filter((thread) => thread.fileId === file.id);
    const openThreadCount = threads.filter((thread) => thread.status === 'open').length;
    const diagnostics = diagnosticsByFile.value[file.id] ?? [];
    const diagnosticBadge = fileDiagnosticBadge(file, diagnostics, diagnosticStateByFile.value[file.id]);
    return {
      file,
      path: changedFilePath(file),
      reviewed: props.reviewedFileIds.includes(file.id),
      threadCount: threads.length,
      openThreadCount,
      threadLabel: threadLabel(threads.length, openThreadCount),
      diagnosticLabel: diagnosticBadge.label,
      diagnosticTone: diagnosticBadge.tone,
      diagnosticTitle: diagnosticBadge.title,
    };
  });
});
const diagnosticScanKey = computed(() =>
  JSON.stringify({
    target: props.target,
    files: props.changedFiles.map((file) => `${file.id}:${file.signature}`).join('\n'),
  }),
);

const changedFilePath = (file: ChangedFile) => file.newPath ?? file.oldPath ?? file.id;
const shouldCheckDiagnostics = (file: ChangedFile) => file.status !== 'deleted' && supportsLspFile(changedFilePath(file));
const statusLabel = (status: ChangedFile['status']) => {
  return {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[status];
};
const threadLabel = (threadCount: number, openThreadCount: number) => {
  if (threadCount === 0) return 'no threads';
  if (openThreadCount === 0) return `${threadCount} resolved`;
  return `${openThreadCount} open`;
};
const threadPath = (thread: ReviewThread) => thread.newPath ?? thread.oldPath ?? thread.fileId;
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
const severityTone = (severity: ReviewThread['severity']): BadgeTone => {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'info';
};
const fileDiagnosticBadge = (file: ChangedFile, diagnostics: LspDiagnostic[], state?: DiagnosticFileState) => {
  if (file.status === 'deleted') return { label: 'deleted', tone: 'neutral' as BadgeTone, title: 'Deleted files have no new-side diagnostics.' };
  if (!supportsLspFile(changedFilePath(file))) return { label: 'unsupported', tone: 'neutral' as BadgeTone };
  if (!state && diagnosticScan.value.running) return { label: 'queued', tone: 'info' as BadgeTone };
  if (!state) return { label: 'not checked', tone: 'neutral' as BadgeTone };
  if (state.status === 'failed') return { label: 'failed', tone: 'danger' as BadgeTone, title: state.message };
  if (state.status === 'unavailable') return { label: 'unavailable', tone: 'warning' as BadgeTone, title: state.message };

  const summary = diagnosticCounts(diagnostics);
  if (summary.total === 0) return { label: 'clean', tone: 'success' as BadgeTone };
  return {
    label: diagnosticParts(summary).join(', '),
    tone: summary.errors > 0 ? ('danger' as BadgeTone) : summary.warnings > 0 ? ('warning' as BadgeTone) : ('info' as BadgeTone),
  };
};
const diagnosticCounts = (diagnostics: LspDiagnostic[]) => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  return {
    errors,
    warnings,
    other: diagnostics.length - errors - warnings,
    total: diagnostics.length,
  };
};
const diagnosticParts = (summary: { errors: number; warnings: number; other: number; total?: number; unavailable?: number; failed?: number }) => {
  return [
    summary.errors > 0 ? `${summary.errors} error${summary.errors === 1 ? '' : 's'}` : undefined,
    summary.warnings > 0 ? `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : undefined,
    summary.other > 0 ? `${summary.other} info` : undefined,
    summary.unavailable && summary.unavailable > 0 ? `${summary.unavailable} unavailable` : undefined,
    summary.failed && summary.failed > 0 ? `${summary.failed} failed` : undefined,
  ].filter((part): part is string => Boolean(part));
};

const loadDiagnostics = async () => {
  const generation = ++diagnosticGeneration;
  const files = props.changedFiles.filter(shouldCheckDiagnostics);
  diagnosticsByFile.value = {};
  diagnosticStateByFile.value = {};
  diagnosticScan.value = { running: files.length > 0, checked: 0, total: files.length };

  if (files.length === 0) return;

  for (const file of files) {
    try {
      const diagnostics = await client.getLspDiagnostics(file.id, 'new', props.target);
      if (generation !== diagnosticGeneration) return;

      diagnosticsByFile.value = {
        ...diagnosticsByFile.value,
        [file.id]: diagnostics.status === 'ok' ? diagnostics.diagnostics : [],
      };
      diagnosticStateByFile.value = {
        ...diagnosticStateByFile.value,
        [file.id]: diagnostics.status === 'ok' ? { status: 'checked' } : { status: 'unavailable', message: diagnostics.message ?? diagnostics.status },
      };
    } catch (error) {
      if (generation !== diagnosticGeneration) return;

      diagnosticStateByFile.value = {
        ...diagnosticStateByFile.value,
        [file.id]: { status: 'failed', message: error instanceof Error ? error.message : String(error) },
      };
    }

    if (generation !== diagnosticGeneration) return;
    diagnosticScan.value = { ...diagnosticScan.value, checked: diagnosticScan.value.checked + 1 };
  }

  if (generation === diagnosticGeneration) diagnosticScan.value = { ...diagnosticScan.value, running: false };
};

watch(diagnosticScanKey, () => void loadDiagnostics(), { immediate: true });

onBeforeUnmount(() => {
  diagnosticGeneration += 1;
});
</script>

<style scoped lang="scss">
.review-overview {
  display: grid;
  align-content: start;
  gap: var(--space-7);
  min-width: 0;
  min-height: 0;
  padding: var(--space-8);
  overflow: auto;
  color: var(--color-text-secondary);
  background: var(--color-bg-app);
}

.overview-hero,
.panel-header,
.metric-line,
.thread-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  min-width: 0;
}

.overview-hero {
  align-items: flex-start;
}

.hero-copy,
.summary-card,
.panel-header > div,
.file-copy {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}

.hero-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-4);
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-lg);
  line-height: 1.1;
}

h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

p {
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  line-height: 1.45;
}

.error-callout {
  padding: var(--space-5) var(--space-6);
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  font-size: var(--font-size-body);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-6);
}

.summary-card {
  align-content: start;
  min-height: 152px;
}

.card-kicker {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.metric-value {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-md);
  font-weight: 800;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.compact {
    font-size: var(--font-size-heading-sm);
    text-transform: capitalize;
  }
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

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
  gap: var(--space-7);
  align-items: start;
}

.files-panel,
.threads-panel {
  display: grid;
  min-width: 0;
  overflow: hidden;
}

.panel-header {
  padding: var(--space-7);
  border-bottom: 1px solid var(--color-border-subtle);
}

.panel-empty {
  margin: var(--space-7);
}

.file-overview-list,
.thread-list {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
}

.file-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-5);
  align-items: center;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-4);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
    border-color: var(--color-border-default);
  }

  &.reviewed .file-path {
    color: var(--color-success);
  }
}

.file-target,
.thread-target {
  min-width: 0;
  padding: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  font: inherit;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 3px;
  }
}

.file-target {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: var(--space-4);
  align-items: center;
}

.file-status {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--color-text-muted);
  background: var(--color-bg-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-2);
  font-size: var(--font-size-caption);
  font-weight: 800;
}

.status-added {
  color: var(--color-success);
  background: var(--color-success-muted);
}

.status-modified,
.status-renamed {
  color: var(--color-ai);
  background: var(--color-ai-muted);
}

.status-deleted {
  color: var(--color-danger);
  background: var(--color-danger-muted);
}

.file-path,
.file-stats,
.thread-file,
.thread-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-path,
.thread-file {
  color: var(--color-text-primary);
  font-weight: 700;
}

.file-stats,
.thread-line,
.thread-meta span {
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.file-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: end;
  gap: var(--space-3);
}

.thread-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-7) 0;
}

.thread-card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);

  &.resolved {
    opacity: 0.74;
  }
}

.thread-target {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
}

.thread-line {
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.thread-card p {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.thread-meta {
  justify-content: start;
  flex-wrap: wrap;
}

@media (max-width: 1180px) {
  .summary-grid,
  .content-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 820px) {
  .review-overview {
    padding: var(--space-6);
  }

  .overview-hero,
  .file-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .overview-hero,
  .metric-line,
  .panel-header {
    align-items: flex-start;
  }

  .hero-actions,
  .metric-line,
  .panel-header,
  .file-meta {
    justify-content: start;
  }

  .summary-grid,
  .content-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
