<template>
  <header class="top-bar">
    <Row justify="between">
      <Row justify="start">
        <div class="brand">Diffuse</div>

        <Button :disabled="loading" @click="$emit('openRepository')">
          {{ loading ? 'Opening...' : 'Open Repository' }}
        </Button>

        <div class="repo-path" :title="repoPath ?? ''">{{ repoPath ?? 'No repository selected' }}</div>
      </Row>

      <Row justify="end">
        <Button @click="$emit('openSettings')"> Settings </Button>

        <div class="status" :class="{ error }">
          {{ error ?? (version ? `core ${version}` : 'connecting') }}
        </div>
      </Row>
    </Row>
  </header>
</template>

<script setup lang="ts">
import Button from '../Button.vue';
import Row from '../Row.vue';

defineProps<{
  repoPath?: string;
  version?: string;
  loading: boolean;
  error?: string;
}>();

defineEmits<{
  openRepository: [];
  refresh: [];
  openSettings: [];
}>();
</script>

<style scoped lang="scss">
.top-bar {
  height: auto;
  padding: 1rem;
  border-bottom: 1px solid #252a35;
  background: #151821;
}

.brand {
  color: #f5f7fb;
  font-weight: 700;
  letter-spacing: 0.02em;
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
