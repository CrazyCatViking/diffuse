<template>
  <div class="inline-review-row" :class="reviewClass">
    <div v-if="mode === 'split'" class="review-cell">
      <InlineReviewBox
        v-bind="reviewProps"
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
  }>(),
  {
    draftBody: '',
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
  background: #10141c;
}

.inline-review-row.inline {
  padding: 10px 18px 12px 128px;
}

.inline-review-row.old,
.inline-review-row.new {
  padding: 10px 16px 12px 64px;
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
  padding: 10px 16px 12px 64px;
}
</style>
