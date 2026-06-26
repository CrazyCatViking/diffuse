<template>
  <div class="inline-review-row" :class="[reviewClass, { flashing }]">
    <div v-if="mode === 'split'" class="review-cell">
      <InlineReviewBox
        v-bind="reviewProps"
        :flashing="flashing"
        @update:draft-body="emit('update:draftBody', $event)"
        @submit="emit('submit')"
        @submit-chat-draft="emit('submitChatDraft')"
        @cancel="emit('cancel')"
        @reply="emit('reply', $event)"
        @chat="emit('chat', $event)"
        @collapse="emit('collapse', $event)"
        @resolve="emit('resolve', $event)"
        @reopen="emit('reopen', $event)"
      />
    </div>

    <InlineReviewBox
      v-else
      v-bind="reviewProps"
      :flashing="flashing"
      @update:draft-body="emit('update:draftBody', $event)"
      @submit="emit('submit')"
      @submit-chat-draft="emit('submitChatDraft')"
      @cancel="emit('cancel')"
      @reply="emit('reply', $event)"
      @chat="emit('chat', $event)"
      @collapse="emit('collapse', $event)"
      @resolve="emit('resolve', $event)"
      @reopen="emit('reopen', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ReviewAnchor, ReviewChatMessage, ReviewThread } from '../../lib/protocol';
import InlineReviewBox, { type InlineReviewEntry } from './InlineReviewBox.vue';

const props = withDefaults(
  defineProps<{
    mode: 'split' | 'inline' | 'pane';
    reviewRow: InlineReviewEntry;
    reviewClass?: string | string[] | Record<string, boolean>;
    draftBody?: string;
    chatMessages?: ReviewChatMessage[];
    agentResponding?: boolean;
    error?: string;
    flashing?: boolean;
  }>(),
  {
    draftBody: '',
    flashing: false,
  },
);

const emit = defineEmits<{
  'update:draftBody': [value: string];
  submit: [];
  submitChatDraft: [];
  cancel: [];
  reply: [payload: { thread: ReviewThread; body: string }];
  chat: [payload: { thread: ReviewThread; body: string }];
  collapse: [anchor: ReviewAnchor];
  resolve: [thread: ReviewThread];
  reopen: [thread: ReviewThread];
}>();

const reviewProps = computed(() => ({
  entry: props.reviewRow,
  draftBody: props.draftBody,
  chatMessages: props.chatMessages,
  agentResponding: props.agentResponding,
  error: props.error,
}));
</script>

<style scoped lang="scss">
.inline-review-row {
  min-height: 0;
  background: var(--color-bg-code);
}

.inline-review-row.flashing {
  animation: review-row-flash 1800ms ease-out;
}

.inline-review-row.inline {
  padding: var(--space-3) 12px var(--space-4) 96px;
}

.inline-review-row.old,
.inline-review-row.new {
  padding: var(--space-3) var(--space-5) var(--space-4) 48px;
}

.inline-review-row.synced-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-width: 1120px;
}

.inline-review-row.synced-split.old .review-cell {
  grid-column: 1;
}

.inline-review-row.synced-split.new .review-cell {
  grid-column: 2;
}

.review-cell {
  padding: var(--space-3) var(--space-5) var(--space-4) 48px;
}

@keyframes review-row-flash {
  0%,
  22% {
    background: linear-gradient(90deg, var(--color-review-muted), var(--color-bg-code) 120px);
  }

  100% {
    background: var(--color-bg-code);
  }
}
</style>
