<template>
  <label class="agent-picker"
    >Review agent
    <select v-model="review.agentAdapter" aria-label="Review agent adapter" :disabled="review.acpReview.busy" @focus="load(true)">
      <option value="" disabled>Select a configured adapter</option>

      <option
        v-for="item in review.acpReview.adapters"
        :key="item.adapter.id"
        :value="`acp:${item.adapter.id}`"
        :disabled="!item.available || !item.platformSupported"
      >
        {{ item.adapter.id }}{{ !item.platformSupported ? ' (unsupported)' : !item.available ? ' (unavailable)' : '' }}
      </option>
    </select>

    <span v-if="error" role="status">{{ error }}</span>

    <span
      >Legacy provider/model/agent overrides are retained in review configuration but are not used by ACP. Configure the equivalent
      supported adapter arguments explicitly. Existing review history is retained.</span
    >
  </label>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useReviewStore } from '../../stores/review';
const review = useReviewStore();
const error = ref('');
async function load(refresh = false) {
  try {
    await review.acpReview.loadAdapters(refresh);
    error.value = '';
  } catch {
    error.value = 'ACP discovery unavailable. Configure an adapter in Settings. RPC rollback does not support agent execution.';
  }
}
void load();
</script>

<style scoped lang="scss">
.agent-picker {
  display: grid;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-label);
  min-width: 0;
}
select {
  min-width: 0;
  padding: var(--space-3);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}
select:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
</style>
