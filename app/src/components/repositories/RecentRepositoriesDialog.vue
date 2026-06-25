<template>
  <div class="overlay" @click.self="$emit('close')">
    <section class="dialog" aria-labelledby="recent-repositories-title">
      <div class="header">
        <div>
          <h1 id="recent-repositories-title">Open Repository</h1>

          <p>Choose a recent repository or open a new folder.</p>
        </div>

        <Button :disabled="loading" @click="$emit('openNew')">
          {{ loading ? 'Opening...' : 'Open New' }}
        </Button>
      </div>

      <div v-if="repositories.length > 0" class="recent-list">
        <button
          v-for="repository in repositories"
          :key="repository.path"
          class="recent-item"
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
    </section>
  </div>
</template>

<script setup lang="ts">
import type { RecentRepository } from '../../stores/repo';
import Button from '../Button.vue';

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
  padding: 24px;
  background: rgb(5 7 12 / 72%);
}

.dialog {
  width: min(680px, 100%);
  max-height: min(680px, 100%);
  padding: 22px;
  overflow: auto;
  border: 1px solid #2c3445;
  border-radius: 18px;
  background: #151821;
  box-shadow: 0 24px 80px rgb(0 0 0 / 45%);
}

.header {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}

h1 {
  margin: 0;
  color: #f5f7fb;
  font-size: 22px;
  line-height: 1.2;
}

p {
  margin: 6px 0 0;
  color: #98a2b3;
  font-size: 13px;
}

.recent-list {
  display: grid;
  gap: 8px;
}

.recent-item {
  display: grid;
  width: 100%;
  min-width: 0;
  padding: 13px 14px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: #1b202b;
  border: 1px solid #2a3140;
  border-radius: 12px;

  &:hover:not(:disabled) {
    background: #222938;
    border-color: #3b465b;
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
}

.repo-name {
  overflow: hidden;
  color: #f5f7fb;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-path {
  margin-top: 4px;
  overflow: hidden;
  color: #7e8aa0;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 42px 18px;
  color: #7e8aa0;
  text-align: center;
  border: 1px dashed #2a3140;
  border-radius: 14px;
}

.empty-title {
  color: #d8dee9;
  font-weight: 650;
}

.empty-copy {
  margin-top: 6px;
  font-size: 13px;
}

@media (max-width: 640px) {
  .overlay {
    align-items: stretch;
    padding: 12px;
  }

  .dialog {
    max-height: 100%;
    padding: 16px;
    border-radius: 14px;
  }

  .header {
    display: grid;
  }
}
</style>
