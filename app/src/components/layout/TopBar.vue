<template>
  <Toolbar class="top-bar">
    <Row justify="between">
      <Row justify="start">
        <div class="brand">
          <span class="brand-mark">D</span>

          <span>Diffuse</span>
        </div>

        <Button size="sm" :disabled="loading" @click="$emit('openRepository')">
          {{ loading ? 'Opening...' : 'Open Repository' }}
        </Button>

        <div v-if="$slots['repository-controls']" class="repository-controls">
          <slot name="repository-controls" />
        </div>

        <div class="repo-path" :title="repoPath ?? ''">{{ repoPath ?? 'No repository selected' }}</div>
      </Row>

      <Row justify="end">
        <Button v-if="repoPath" variant="secondary" size="sm" :disabled="loading" @click="$emit('openSearch')">Search</Button>

        <Button v-if="repoPath" variant="secondary" size="sm" :disabled="loading" @click="$emit('refresh')">Refresh</Button>

        <Button variant="ghost" size="sm" @click="$emit('openSettings')">Settings</Button>

        <Badge :tone="error ? 'danger' : version ? 'success' : 'neutral'" :title="error ?? undefined">
          {{ error ?? (version ? `core ${version}` : 'connecting') }}
        </Badge>
      </Row>
    </Row>
  </Toolbar>
</template>

<script setup lang="ts">
import Button from '../Button.vue';
import Row from '../Row.vue';
import Badge from '../ui/Badge.vue';
import Toolbar from '../ui/Toolbar.vue';

defineProps<{
  repoPath?: string;
  version?: string;
  loading: boolean;
  error?: string;
}>();

defineEmits<{
  openRepository: [];
  openSearch: [];
  refresh: [];
  openSettings: [];
}>();
</script>

<style scoped lang="scss">
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--color-text-primary);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--color-text-on-accent);
  background: linear-gradient(135deg, var(--color-accent), #745cff);
  border-radius: var(--radius-2);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0;
}

.repo-path {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-controls {
  flex: 0 0 auto;
  min-width: 0;
}
</style>
