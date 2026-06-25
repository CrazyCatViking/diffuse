<template>
  <div class="overlay" @click.self="$emit('close')">
    <Panel class="dialog" elevated padding="lg" role="dialog" aria-modal="true" aria-labelledby="recent-repositories-title">
      <div class="header">
        <div>
          <h1 id="recent-repositories-title">Open Repository</h1>

          <p>Choose a recent repository or open a new folder.</p>
        </div>

        <div class="header-actions">
          <Button variant="ghost" size="sm" @click="$emit('close')">Close</Button>

          <Button size="sm" :disabled="loading" @click="$emit('openNew')">
            {{ loading ? 'Opening...' : 'Open New' }}
          </Button>
        </div>
      </div>

      <div v-if="repositories.length > 0" class="recent-list">
        <button
          v-for="repository in repositories"
          :key="repository.path"
          class="recent-item"
          type="button"
          :disabled="loading"
          @click="$emit('openRecent', repository.path)"
        >
          <span class="repo-name">{{ repository.name }}</span>

          <span class="repo-path">{{ repository.path }}</span>
        </button>
      </div>

      <div v-else class="empty">
        <div class="empty-title">No recent repositories</div>

        <div class="empty-copy">Use Open New to pick your first repository.</div>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import type { RecentRepository } from '../../stores/repo';
import Button from '../Button.vue';
import Panel from '../ui/Panel.vue';

defineProps<{
  repositories: RecentRepository[];
  loading: boolean;
}>();

defineEmits<{
  close: [];
  openNew: [];
  openRecent: [path: string];
}>();
</script>

<style scoped lang="scss">
.overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  padding: var(--space-9);
  background: var(--color-bg-overlay);
}

.dialog {
  width: min(680px, 100%);
  max-height: min(680px, 100%);
  overflow: auto;
}

.header {
  display: flex;
  gap: var(--space-8);
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-8);
}

.header-actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-4);
}

h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 22px;
  line-height: 1.2;
}

p {
  margin: 6px 0 0;
  color: var(--color-text-muted);
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
  font-weight: 650;
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

.empty {
  padding: 42px var(--space-8);
  color: var(--color-text-subtle);
  text-align: center;
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-6);
}

.empty-title {
  color: var(--color-text-secondary);
  font-weight: 650;
}

.empty-copy {
  margin-top: 6px;
  font-size: 13px;
}

@media (max-width: 640px) {
  .overlay {
    align-items: stretch;
    padding: var(--space-6);
  }

  .dialog {
    max-height: 100%;
  }

  .header,
  .header-actions {
    display: grid;
  }
}
</style>
