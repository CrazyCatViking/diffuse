<template>
  <div class="repository-start">
    <EmptyState
      title="Review local changes before they become a pull request"
      description="Open a Git repository to inspect changed files, add line comments, check diagnostics, and ask an AI reviewer for focused assistance."
    >
      <template #visual>
        <span class="diff-mark">±</span>
      </template>

      <template #actions>
        <Button size="lg" :disabled="loading" @click="emit('openNew')">
          {{ loading ? 'Opening...' : 'Open Repository' }}
        </Button>
      </template>
    </EmptyState>

    <Panel v-if="error || repositories.length > 0" class="recent-panel" padding="lg">
      <div class="panel-heading">
        <div>
          <Badge tone="review">Review desk</Badge>

          <h2>Recent repositories</h2>
        </div>

        <span class="panel-note">Local-first review sessions stay in each repository.</span>
      </div>

      <div v-if="error" class="error-callout" role="alert">{{ error }}</div>

      <div v-if="repositories.length > 0" class="recent-list">
        <button
          v-for="repository in repositories"
          :key="repository.path"
          class="recent-item"
          type="button"
          :disabled="loading"
          @click="emit('openRecent', repository.path)"
        >
          <span class="repo-name">{{ repository.name }}</span>

          <span class="repo-path">{{ repository.path }}</span>
        </button>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import type { RecentRepository } from '../../stores/repo';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';

defineProps<{
  repositories: RecentRepository[];
  loading: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  openNew: [];
  openRecent: [path: string];
}>();
</script>

<style scoped lang="scss">
.repository-start {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: var(--space-9);
  min-height: 0;
  padding: min(8vh, 72px) var(--space-10) var(--space-10);
  overflow: auto;
  background:
    radial-gradient(circle at 50% 0%, rgba(75, 123, 236, 0.14), transparent 420px), linear-gradient(180deg, var(--color-bg-app), #0b0f16);
}

.diff-mark {
  color: var(--color-accent-hover);
  font-family: var(--font-mono);
  font-size: 30px;
  font-weight: 800;
  line-height: 1;
}

.recent-panel {
  width: min(840px, 100%);
}

.panel-heading {
  display: flex;
  gap: var(--space-7);
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-7);
}

h2 {
  margin: var(--space-4) 0 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

.panel-note {
  max-width: 280px;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
  line-height: 1.45;
  text-align: right;
}

.error-callout {
  margin-bottom: var(--space-7);
  padding: var(--space-5) var(--space-6);
  color: #ffd4d4;
  background: var(--color-danger-muted);
  border: 1px solid rgba(255, 107, 107, 0.28);
  border-radius: var(--radius-4);
  font-size: var(--font-size-body);
}

.recent-list {
  display: grid;
  gap: var(--space-4);
}

.recent-item {
  display: grid;
  width: 100%;
  min-width: 0;
  padding: var(--space-6) var(--space-7);
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover:not(:disabled) {
    background: var(--color-bg-hover);
    border-color: var(--color-border-strong);
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
}

.repo-name {
  overflow: hidden;
  color: var(--color-text-primary);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-path {
  margin-top: var(--space-2);
  overflow: hidden;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .repository-start {
    padding: var(--space-7);
  }

  .panel-heading {
    display: grid;
  }

  .panel-note {
    max-width: none;
    text-align: left;
  }
}
</style>
