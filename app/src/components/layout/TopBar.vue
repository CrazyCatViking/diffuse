<script setup lang="ts">
defineProps<{
  repoPath: string | null
  version: string | null
  loading: boolean
  error: string | null
}>()

defineEmits<{
  openRepository: []
}>()
</script>

<template>
  <header class="top-bar">
    <div class="brand">Diffuse</div>
    <button class="open-button" :disabled="loading" @click="$emit('openRepository')">
      {{ loading ? 'Opening...' : 'Open Repository' }}
    </button>
    <div class="repo-path" :title="repoPath ?? ''">{{ repoPath ?? 'No repository selected' }}</div>
    <div class="status" :class="{ error }">
      {{ error ?? (version ? `core ${version}` : 'connecting') }}
    </div>
  </header>
</template>

<style scoped lang="scss">
.top-bar {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid #252a35;
  background: #151821;
}

.brand {
  color: #f5f7fb;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.open-button {
  color: #f5f7fb;
  background: #2d63d8;
  border: 0;
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}

.repo-path {
  min-width: 0;
  overflow: hidden;
  color: #98a2b3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  color: #8bd5a3;
  font-size: 12px;

  &.error {
    max-width: 360px;
    overflow: hidden;
    color: #ff8d8d;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
