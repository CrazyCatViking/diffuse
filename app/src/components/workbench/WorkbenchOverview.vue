<template>
  <main class="workbench-overview" aria-labelledby="workbench-heading">
    <header class="overview-header">
      <div>
        <p class="eyebrow">Workspace control</p>
        <h1 id="workbench-heading">Workbench Overview</h1>
        <p>Open repositories stay available while you move between review contexts.</p>
      </div>

      <Button @click="openNewWorkspace">Open Workspace</Button>
    </header>

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

    <section v-if="workbench.workspaces.length > 0" aria-labelledby="open-workspaces-heading">
      <div class="section-heading">
        <h2 id="open-workspaces-heading">Open Workspaces</h2>
        <span>{{ workbench.workspaces.length }} available</span>
      </div>

      <div class="workspace-cards">
        <button
          v-for="workspace in workbench.workspaces"
          :key="workspace.workspaceId"
          class="workspace-card"
          type="button"
          @click="workbench.activateWorkspace(workspace.workspaceId)"
        >
          <span class="card-topline">
            <strong>{{ workspace.displayName }}</strong>
            <WorkspaceAttentionBadge :state="workspace.state" />
          </span>
          <span class="workspace-path">{{ workspace.root }}</span>
          <span class="workspace-action">Return to last view →</span>
        </button>
      </div>
    </section>

    <section v-if="recentClosed.length > 0" aria-labelledby="recent-workspaces-heading">
      <div class="section-heading">
        <h2 id="recent-workspaces-heading">Recent Workspaces</h2>
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
import { computed } from 'vue';
import { useRepoStore } from '../../stores/repo';
import { useWorkbenchStore } from '../../stores/workbench';
import Button from '../Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import WorkspaceAttentionBadge from './WorkspaceAttentionBadge.vue';

const workbench = useWorkbenchStore();
const repo = useRepoStore();
const recentClosed = computed(() => {
  const roots = new Set(workbench.workspaces.map((workspace) => workspace.root));
  return repo.recentRepositories.filter((recent) => !roots.has(recent.path));
});

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
.card-topline,
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

.workspace-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: var(--space-6);
}

.workspace-card {
  display: grid;
  gap: var(--space-6);
  min-width: 0;
  padding: var(--space-8);
  color: var(--color-text-secondary);
  text-align: left;
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);
  cursor: pointer;

  &:hover {
    background: var(--color-bg-panel-raised);
    border-color: var(--color-border-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.workspace-path,
.recent-row small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-action {
  color: var(--color-info);
  font-size: var(--font-size-label);
  font-weight: 700;
}

.recent-list {
  overflow: hidden;
}

.recent-row {
  width: 100%;
  padding: var(--space-6) var(--space-7);
  color: var(--color-text-secondary);
  text-align: left;
  background: transparent;
  border: 0;
  border-top: 1px solid var(--color-border-hairline);
  cursor: pointer;

  &:first-child {
    border-top: 0;
  }

  &:hover {
    background: var(--color-bg-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  span:first-child {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
}

@media (max-width: 720px) {
  .overview-header {
    display: grid;
    align-items: start;
  }
}
</style>
