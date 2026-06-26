<template>
  <template v-if="entry.diff">
    <DiffRenderedRow
      v-if="layout.compositionMode === 'inline' || entry.diff.kind === 'hunk'"
      mode="neutral"
      :row="entry.diff"
      :comment-hover-disabled="layout.commentHoverDisabled"
      @comment="layout.actions.comment"
      @toggle-comments="layout.actions.toggleComments"
    />

    <div v-else-if="layout.compositionMode === 'split'" class="split-composed-row">
      <DiffRenderedRow
        mode="old"
        :row="entry.diff"
        :comment-hover-disabled="layout.commentHoverDisabled"
        @comment="layout.actions.comment"
        @toggle-comments="layout.actions.toggleComments"
      />

      <DiffRenderedRow
        mode="new"
        :row="entry.diff"
        :comment-hover-disabled="layout.commentHoverDisabled"
        @comment="layout.actions.comment"
        @toggle-comments="layout.actions.toggleComments"
      />
    </div>

    <DiffRenderedRow
      v-else-if="layout.paneSide"
      :mode="layout.paneSide"
      :row="entry.diff"
      :comment-hover-disabled="layout.commentHoverDisabled"
      @comment="layout.actions.comment"
      @toggle-comments="layout.actions.toggleComments"
    />
  </template>

  <DiffReviewRow
    v-else-if="entry.reviewRow"
    :mode="layout.compositionMode"
    :review-row="entry.reviewRow"
    :review-class="reviewClass"
    :flashing="entry.reviewRow.kind === 'thread' && entry.reviewRow.thread.id === review.flashingThreadId"
    :draft-body="review.draftBody"
    :chat-messages="review.chatMessagesForEntry(entry.reviewRow)"
    :agent-responding="review.agentRespondingForEntry(entry.reviewRow)"
    :error="review.error"
    @update:draft-body="reviewActions.updateDraftBody"
    @submit="reviewActions.submit"
    @submit-chat-draft="reviewActions.submitChatDraft"
    @cancel="reviewActions.cancel"
    @reply="reviewActions.reply"
    @chat="reviewActions.chat"
    @collapse="reviewActions.collapse"
    @resolve="reviewActions.resolve"
    @reopen="reviewActions.reopen"
  />
</template>

<script setup lang="ts">
import type { SyntaxSide } from '../../lib/protocol';
import type { DiffPaneActions, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';
import DiffRenderedRow from './DiffRenderedRow.vue';
import DiffReviewRow from './DiffReviewRow.vue';

defineProps<{
  entry: DiffRenderedEntry;
  layout: {
    compositionMode: 'split' | 'inline' | 'pane';
    paneSide?: SyntaxSide;
    commentHoverDisabled: boolean;
    actions: Pick<DiffPaneActions, 'comment' | 'toggleComments'>;
  };
  review: DiffReviewUi;
  reviewActions: DiffReviewActions;
  reviewClass?: string | string[] | Record<string, boolean>;
}>();
</script>

<style scoped lang="scss">
.split-composed-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-width: 1120px;
}
</style>
