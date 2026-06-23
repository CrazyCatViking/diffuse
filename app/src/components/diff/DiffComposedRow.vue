<template>
  <template v-if="row">
    <DiffRenderedRow
      v-if="compositionMode === 'inline' || row.kind === 'hunk'"
      mode="neutral"
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
    <div v-else-if="compositionMode === 'split'" class="split-composed-row">
      <DiffRenderedRow
        mode="old"
        :row="row"
        :file-id="fileId"
        :syntax-spans="oldSyntaxSpans"
        :old-comment-count="oldCommentCount"
        :old-comments-expanded="oldCommentsExpanded"
        :review-highlights="oldReviewHighlights"
        :search-highlights="oldSearchHighlights"
        :old-diagnostics="oldDiagnostics"
        :comment-hover-disabled="commentHoverDisabled"
        @comment="emit('comment', $event)"
        @toggle-comments="emit('toggleComments', $event)"
      />
      <DiffRenderedRow
        mode="new"
        :row="row"
        :file-id="fileId"
        :syntax-spans="newSyntaxSpans"
        :new-comment-count="newCommentCount"
        :new-comments-expanded="newCommentsExpanded"
        :review-highlights="newReviewHighlights"
        :search-highlights="newSearchHighlights"
        :new-diagnostics="newDiagnostics"
        :comment-hover-disabled="commentHoverDisabled"
        @comment="emit('comment', $event)"
        @toggle-comments="emit('toggleComments', $event)"
      />
    </div>
    <DiffRenderedRow
      v-else-if="paneSide"
      :mode="paneSide"
      :row="row"
      :file-id="fileId"
      :syntax-spans="paneSide === 'old' ? oldSyntaxSpans : newSyntaxSpans"
      :old-comment-count="oldCommentCount"
      :new-comment-count="newCommentCount"
      :old-comments-expanded="oldCommentsExpanded"
      :new-comments-expanded="newCommentsExpanded"
      :review-highlights="paneSide === 'old' ? oldReviewHighlights : newReviewHighlights"
      :search-highlights="paneSide === 'old' ? oldSearchHighlights : newSearchHighlights"
      :old-diagnostics="oldDiagnostics"
      :new-diagnostics="newDiagnostics"
      :comment-hover-disabled="commentHoverDisabled"
      @comment="emit('comment', $event)"
      @toggle-comments="emit('toggleComments', $event)"
    />
  </template>
  <DiffReviewRow
    v-else-if="reviewRow"
    :mode="compositionMode"
    :review-row="reviewRow"
    :review-class="reviewClass"
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
</template>

<script setup lang="ts">
import type { DiffRow, LspDiagnostic, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { InlineReviewEntry } from './InlineReviewBox.vue';
import DiffRenderedRow from './DiffRenderedRow.vue';
import DiffReviewRow from './DiffReviewRow.vue';

withDefaults(
  defineProps<{
    compositionMode: 'split' | 'inline' | 'pane';
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
  comment: [payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: SyntaxSide; line: number }];
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
</script>

<style scoped lang="scss">
.split-composed-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-width: 1120px;
}
</style>
