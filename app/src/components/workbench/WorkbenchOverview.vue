<template>
  <main class="workbench-overview" aria-labelledby="workbench-heading">
    <header class="overview-header">
      <div>
        <p class="eyebrow">Workspace control</p>
        <h1 id="workbench-heading">Workbench Overview</h1>
        <p>Review every open workspace without changing its stable rail position.</p>
      </div>

      <Button @click="openNewWorkspace">Open Workspace</Button>
    </header>

    <section v-if="workbench.restoreDiagnostics.length > 0" aria-labelledby="restore-failures-heading">
      <div class="section-heading">
        <h2 id="restore-failures-heading">Restore Failures</h2>
        <span>Retry or dismiss workspaces that could not be reopened</span>
      </div>

      <Panel padding="none" class="restore-list">
        <article v-for="diagnostic in workbench.restoreDiagnostics" :key="diagnostic.workspaceId" class="restore-row">
          <span class="workspace-identity">
            <strong>{{ diagnostic.displayName }}</strong>
            <small>{{ diagnostic.root }}</small>
            <span class="restore-message">{{ diagnostic.message }}</span>
          </span>

          <span class="restore-actions">
            <Button size="sm" :disabled="restoreBusy === diagnostic.workspaceId" @click="retryRestore(diagnostic.workspaceId)"
              >Retry</Button
            >

            <Button
              variant="secondary"
              size="sm"
              :disabled="restoreBusy === diagnostic.workspaceId"
              @click="dismissRestore(diagnostic.workspaceId)"
            >
              Dismiss
            </Button>
          </span>
        </article>
      </Panel>

      <p v-if="restoreError" class="restore-error" role="alert">{{ restoreError }}</p>
    </section>

    <EmptyState
      v-if="workbench.workspaces.length === 0 && repo.recentRepositories.length === 0"
      bordered
      title="Open your first workspace"
      description="Choose a Git repository to begin reviewing changes."
    >
      <template #actions>
        <Button size="lg" @click="openNewWorkspace">Open Workspace</Button>
      </template>
    </EmptyState>

    <section v-for="group in groups" :key="group.state" :aria-labelledby="`workspace-group-${group.state}`">
      <div class="section-heading">
        <h2 :id="`workspace-group-${group.state}`">{{ group.label }}</h2>
        <span>{{ group.workspaces.length }} {{ group.workspaces.length === 1 ? 'workspace' : 'workspaces' }}</span>
      </div>

      <Panel padding="none" class="workspace-list">
        <article v-for="workspace in group.workspaces" :key="workspace.workspaceId" class="workspace-row">
          <button class="workspace-main" type="button" @click="workbench.activateWorkspace(workspace.workspaceId)">
            <span class="workspace-identity">
              <strong>{{ workspace.displayName }}</strong>
              <small>{{ workspace.root }}</small>
            </span>
            <span class="workspace-counts">
              <span v-if="workspace.attention.inputRequired">{{ workspace.attention.inputRequired }} input</span>
              <span v-if="workspace.attention.errors">{{ workspace.attention.errors }} errors</span>
              <span v-if="workspace.attention.unread">{{ workspace.attention.unread }} unread</span>
              <span v-if="workspace.attention.running">{{ workspace.attention.running }} running</span>
            </span>
            <WorkspaceAttentionBadge :attention="workspace.attention" :state="workspace.state" />
          </button>

          <div v-if="attentionForWorkspace(workspace.workspaceId).length > 0" class="attention-actions" aria-label="Attention items">
            <Button
              v-for="item in attentionForWorkspace(workspace.workspaceId)"
              :key="`${item.id}:${item.revision}`"
              variant="ghost"
              size="sm"
              @click="openAttention(item)"
            >
              {{ attentionActionLabel(item) }}
            </Button>
          </div>
        </article>
      </Panel>
    </section>

    <section v-if="recentClosed.length > 0" aria-labelledby="recent-workspaces-heading">
      <div class="section-heading">
        <h2 id="recent-workspaces-heading">Ready and Recent</h2>
        <span>Reopen a local repository</span>
      </div>

      <Panel padding="none" class="recent-list">
        <button v-for="recent in recentClosed" :key="recent.path" class="recent-row" type="button" @click="openPath(recent.path)">
          <span>
            <strong>{{ recent.name }}</strong>
            <small>{{ recent.path }}</small>
          </span>
          <span aria-hidden="true">＋</span>
        </button>
      </Panel>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { dispatchWorkspaceNavigation } from '../../lib/workspaceNavigation';
import type { AttentionItem, WorkspaceAttentionState } from '../../lib/workbenchContract';
import { useRepoStore } from '../../stores/repo';
import { useReviewStore } from '../../stores/review';
import { useWorkbenchStore } from '../../stores/workbench';
import Button from '../Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import WorkspaceAttentionBadge from './WorkspaceAttentionBadge.vue';

const workbench = useWorkbenchStore();
const repo = useRepoStore();
const review = useReviewStore();
const router = useRouter();
const restoreBusy = ref<string>();
const restoreError = ref('');
const groupOrder: { state: WorkspaceAttentionState; label: string }[] = [
  { state: 'input-required', label: 'Needs Input' },
  { state: 'error', label: 'Errors Requiring Attention' },
  { state: 'unread', label: 'Unread Completions' },
  { state: 'running', label: 'Running' },
  { state: 'idle', label: 'Ready' },
];
const groups = computed(() =>
  groupOrder
    .map((group) => ({ ...group, workspaces: workbench.workspaces.filter((workspace) => workspace.attention.state === group.state) }))
    .filter((group) => group.workspaces.length > 0),
);
const recentClosed = computed(() => {
  const roots = new Set(workbench.workspaces.map((workspace) => workspace.root));
  return repo.recentRepositories.filter((recent) => !roots.has(recent.path));
});

const attentionForWorkspace = (workspaceId: string) =>
  Object.values(workbench.attentionItems)
    .filter(
      (item) => item.workspaceId === workspaceId && item.status !== 'resolved' && item.status !== 'expired' && item.status !== 'superseded',
    )
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));

const attentionActionLabel = (item: AttentionItem) => {
  if (item.kind === 'input') return `Respond to ${item.sourceId}`;
  if (item.kind === 'error') return `Inspect error from ${item.sourceId}`;
  return `View completion from ${item.sourceId}`;
};

const openAttention = async (item: AttentionItem) => {
  await dispatchWorkspaceNavigation(item.workspaceId, item.target, {
    activateWorkspace: workbench.activateWorkspace,
    router,
    selectReviewSession: review.selectSession,
  });
  if (item.target.kind !== 'agent') await workbench.acknowledgeAttention(item.id, item.revision);
};

const retryRestore = async (workspaceId: string) => {
  restoreBusy.value = workspaceId;
  restoreError.value = '';
  try {
    await workbench.retryRestoreFailure(workspaceId);
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : String(error);
  } finally {
    restoreBusy.value = undefined;
  }
};

const dismissRestore = async (workspaceId: string) => {
  restoreBusy.value = workspaceId;
  restoreError.value = '';
  try {
    await workbench.dismissRestoreFailure(workspaceId);
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : String(error);
  } finally {
    restoreBusy.value = undefined;
  }
};

const openNewWorkspace = async () => {
  const path = await window.diffuse.pickRepository();
  if (path) await openPath(path);
};

const openPath = async (path: string) => {
  await workbench.openWorkspace(path);
};
</script>

<style scoped lang="scss">
.workbench-overview {
  display: grid;
  gap: var(--space-10);
  align-content: start;
  min-width: 0;
  min-height: 0;
  padding: clamp(var(--space-7), 4vw, 48px);
  overflow: auto;
  background: radial-gradient(circle at 92% 8%, var(--color-accent-muted), transparent 28%), var(--color-bg-app);
}

.overview-header,
.section-heading,
.workspace-main,
.recent-row {
  display: flex;
  gap: var(--space-7);
  align-items: center;
  justify-content: space-between;
}

.overview-header {
  align-items: end;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  margin-top: var(--space-2);
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-lg);
}

h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

.overview-header p:not(.eyebrow),
.section-heading span {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.eyebrow {
  color: var(--color-info);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

section {
  display: grid;
  gap: var(--space-6);
}

.workspace-list,
.recent-list,
.restore-list {
  overflow: hidden;
}

.workspace-row {
  border-top: 1px solid var(--color-border-hairline);

  &:first-child {
    border-top: 0;
  }
}

.restore-row {
  display: flex;
  gap: var(--space-6);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6) var(--space-7);
  border-top: 1px solid var(--color-border-hairline);

  &:first-child {
    border-top: 0;
  }
}

.restore-actions {
  display: flex;
  gap: var(--space-3);
}

.restore-message,
.restore-error {
  color: var(--color-danger);
  font-size: var(--font-size-caption);
}

.workspace-main,
.recent-row {
  width: 100%;
  padding: var(--space-6) var(--space-7);
  color: var(--color-text-secondary);
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;

  &:hover {
    background: var(--color-bg-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.workspace-identity,
.recent-row span:first-child {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.workspace-identity small,
.recent-row small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-counts,
.attention-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.workspace-counts {
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
}

.attention-actions {
  padding: 0 var(--space-7) var(--space-5);
}

@media (max-width: 720px) {
  .overview-header,
  .workspace-main,
  .restore-row {
    display: grid;
    align-items: start;
  }
}
</style>
