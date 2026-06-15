<template>
  <section class="review-agent-bar">
    <div class="review-agent-copy">
      <span class="label">AI review</span>
      <span class="message">{{ message }}</span>
    </div>

    <div class="review-agent-actions">
      <span v-if="progressText" class="progress">{{ progressText }}</span>
      <Button v-if="activeRun" :disabled="loading" @click="emit('stop')">Stop review</Button>
      <Button v-else :disabled="loading || !enabled" @click="emit('start')">Start AI review</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ReviewProgress, ReviewRun } from '../../lib/protocol';
import Button from '../Button.vue';

const props = defineProps<{
  enabled: boolean;
  loading: boolean;
  progress: ReviewProgress | null;
  activeRun: ReviewRun | null;
  openThreadCount: number;
  error?: string;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
}>();

const message = computed(() => {
  if (props.error) return props.error;
  if (props.activeRun?.message) return props.activeRun.message;
  if (props.progress?.message) return props.progress.message;
  if (props.activeRun) return 'Review agent is running';
  if (!props.enabled) return 'Open a repository with changed files to start a review';
  return `${props.openThreadCount} open review thread${props.openThreadCount === 1 ? '' : 's'}`;
});

const progressText = computed(() => {
  if (!props.progress || props.progress.totalFiles === undefined || props.progress.reviewedFiles === undefined) return undefined;
  return `${props.progress.reviewedFiles}/${props.progress.totalFiles} files`;
});
</script>

<style scoped lang="scss">
.review-agent-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  padding: 0.65rem 1rem;
  border-bottom: 1px solid #252a35;
  background: #111722;
}

.review-agent-copy,
.review-agent-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.label {
  color: #f5f7fb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message {
  min-width: 0;
  overflow: hidden;
  color: #98a2b3;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  color: #8bd5a3;
  font-size: 12px;
  white-space: nowrap;
}
</style>
