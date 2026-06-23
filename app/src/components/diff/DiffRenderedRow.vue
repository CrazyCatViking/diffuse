<template>
  <template v-if="row">
    <SplitDiffRow
      v-if="mode === 'split'"
      :row="row"
      :file-id="fileId"
      :old-syntax-spans="oldSyntaxSpans"
      :new-syntax-spans="newSyntaxSpans"
      :old-comment-count="oldCommentCount"
      :new-comment-count="newCommentCount"
      :old-comments-expanded="oldCommentsExpanded"
      :new-comments-expanded="newCommentsExpanded"
      :old-review-highlights="oldReviewHighlights"
      :new-review-highlights="newReviewHighlights"
      :old-search-highlights="oldSearchHighlights"
      :new-search-highlights="newSearchHighlights"
      :old-diagnostics="oldDiagnostics"
      :new-diagnostics="newDiagnostics"
      :comment-hover-disabled="commentHoverDisabled"
      @comment="emit('comment', $event)"
      @toggle-comments="emit('toggleComments', $event)"
    />
    <SplitDiffPaneRow
      v-else-if="mode === 'pane' && paneSide"
      :row="row"
      :side="paneSide"
      :file-id="fileId"
      :syntax-spans="paneSide === 'old' ? oldSyntaxSpans : newSyntaxSpans"
      :comment-count="paneSide === 'old' ? oldCommentCount : newCommentCount"
      :comments-expanded="paneSide === 'old' ? oldCommentsExpanded : newCommentsExpanded"
      :review-highlights="paneSide === 'old' ? oldReviewHighlights : newReviewHighlights"
      :search-highlights="paneSide === 'old' ? oldSearchHighlights : newSearchHighlights"
      :diagnostics="paneSide === 'old' ? oldDiagnostics : newDiagnostics"
      :comment-hover-disabled="commentHoverDisabled"
      @comment="emit('comment', $event)"
      @toggle-comments="emit('toggleComments', $event)"
    />
    <InlineDiffRow
      v-else
      :row="row"
      :file-id="fileId"
      :syntax-spans="inlineSyntaxSpans"
      :old-comment-count="oldCommentCount"
      :new-comment-count="newCommentCount"
      :old-comments-expanded="oldCommentsExpanded"
      :new-comments-expanded="newCommentsExpanded"
      :review-highlights="inlineReviewHighlights"
      :search-highlights="inlineSearchHighlights"
      :old-diagnostics="oldDiagnostics"
      :new-diagnostics="newDiagnostics"
      :comment-hover-disabled="commentHoverDisabled"
      @comment="emit('comment', $event)"
      @toggle-comments="emit('toggleComments', $event)"
    />
  </template>
  <div v-else-if="reviewRow" class="inline-review-row" :class="reviewClass">
    <div v-if="mode === 'split'" class="review-cell">
      <InlineReviewBox
        :entry="reviewRow"
        :draft-body="draftBody"
        :chat-messages="chatMessages"
        :agent-responding="agentResponding"
        :error="error"
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
      :entry="reviewRow"
      :draft-body="draftBody"
      :chat-messages="chatMessages"
      :agent-responding="agentResponding"
      :error="error"
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
import type { DiffRow, LspDiagnostic, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import InlineDiffRow from './InlineDiffRow.vue';
import InlineReviewBox, { type InlineReviewEntry } from './InlineReviewBox.vue';
import SplitDiffPaneRow from './SplitDiffPaneRow.vue';
import SplitDiffRow from './SplitDiffRow.vue';

type CommentPayload = { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number };
type ToggleCommentsPayload = { side: SyntaxSide; line: number };
type ReviewReplyPayload = { thread: ReviewThread; body: string };

withDefaults(
  defineProps<{
    mode: 'split' | 'inline' | 'pane';
    paneSide?: SyntaxSide;
    fileId?: string;
    row?: DiffRow;
    reviewRow?: InlineReviewEntry;
    reviewClass?: string | string[] | Record<string, boolean>;
    oldSyntaxSpans?: SyntaxSpan[];
    newSyntaxSpans?: SyntaxSpan[];
    inlineSyntaxSpans?: SyntaxSpan[];
    oldCommentCount?: number;
    newCommentCount?: number;
    oldCommentsExpanded?: boolean;
    newCommentsExpanded?: boolean;
    oldReviewHighlights?: ReviewTextHighlight[];
    newReviewHighlights?: ReviewTextHighlight[];
    inlineReviewHighlights?: ReviewTextHighlight[];
    oldSearchHighlights?: SearchTextHighlight[];
    newSearchHighlights?: SearchTextHighlight[];
    inlineSearchHighlights?: SearchTextHighlight[];
    oldDiagnostics?: LspDiagnostic[];
    newDiagnostics?: LspDiagnostic[];
    commentHoverDisabled?: boolean;
    draftBody?: string;
    chatMessages?: ReviewChatMessage[];
    agentResponding?: boolean;
    error?: string;
  }>(),
  {
    oldCommentCount: 0,
    newCommentCount: 0,
    oldCommentsExpanded: false,
    newCommentsExpanded: false,
    oldDiagnostics: () => [],
    newDiagnostics: () => [],
    draftBody: '',
  },
);

const emit = defineEmits<{
  comment: [payload: CommentPayload];
  toggleComments: [payload: ToggleCommentsPayload];
  'update:draftBody': [value: string];
  submit: [];
  submitChatDraft: [];
  cancel: [];
  reply: [payload: ReviewReplyPayload];
  chat: [payload: ReviewReplyPayload];
  collapse: [anchor: ReviewAnchor];
  resolve: [thread: ReviewThread];
  reopen: [thread: ReviewThread];
}>();
</script>

<style scoped lang="scss">
.inline-review-row {
  min-height: 0;
  background: #10141c;
}

.inline-review-row.inline {
  padding: 10px 18px 12px 128px;
}

.inline-review-row.old {
  padding: 10px 16px 12px 64px;
}

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
