<template>
  <div v-if="loading" class="message">Loading diff...</div>
  <div v-else-if="error" class="message error">{{ error }}</div>
  <div v-else-if="!model" class="message">Select a changed file to view its diff.</div>
  <div v-else-if="rowsLength === 0" class="message">No unstaged diff for this file.</div>
  <div v-else-if="initialSyntaxGateActive" class="syntax-gate" />
  <div v-else-if="viewMode === 'split' && syncScroll" class="pane-shell" :class="{ 'has-diff-scroll': hasSyncedSplitScroll }">
    <div
      :ref="(element) => setPaneRef('syncedSplit', element)"
      class="pane synced-split-view"
      @scroll="emit('scroll', 'syncedSplit', $event)"
      @pointermove="emit('pointerMove', $event)"
      @mouseleave="emit('mouseLeave')"
      @mouseup="emit('mouseUp')"
    >
      <div class="spacer synced-split-spacer" :style="{ height: `${syncedSplitTotalSize}px` }">
        <div
          v-for="entry in syncedSplitRenderedRows"
          :key="String(entry.virtualRow.key)"
          class="virtual-row"
          :data-index="entry.virtualRow.index"
          :ref="entry.diffRow ? undefined : measureSyncedSplitElement"
          :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
        >
          <DiffRenderedRow
            mode="split"
            :row="entry.diffRow"
            :review-row="entry.reviewRow"
            :review-class="entry.reviewRow ? ['synced-split', entry.reviewRow.anchor.side] : 'synced-split'"
            :file-id="model.fileId"
            :old-syntax-spans="entry.oldSyntaxSpans"
            :new-syntax-spans="entry.newSyntaxSpans"
            :old-comment-count="entry.oldCommentCount"
            :new-comment-count="entry.newCommentCount"
            :old-comments-expanded="entry.oldCommentsExpanded"
            :new-comments-expanded="entry.newCommentsExpanded"
            :old-review-highlights="entry.oldReviewHighlights"
            :new-review-highlights="entry.newReviewHighlights"
            :old-search-highlights="entry.oldSearchHighlights"
            :new-search-highlights="entry.newSearchHighlights"
            :old-diagnostics="[]"
            :new-diagnostics="entry.newDiagnostics"
            :comment-hover-disabled="commentHoverDisabled"
            :draft-body="draftBody"
            :chat-messages="chatMessagesForEntry(entry)"
            :agent-responding="agentRespondingForEntry(entry)"
            :error="reviewError"
            @comment="emit('comment', $event)"
            @toggle-comments="emit('toggleComments', $event)"
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
      </div>
    </div>
    <DiffScrollbar
      v-if="hasSyncedSplitScroll"
      :markers="syncedSplitMarkers"
      :thumb-style="syncedSplitThumbStyle"
      @track-pointer-down="emit('scrollbarTrackPointerDown', $event, 'syncedSplit')"
      @thumb-pointer-down="emit('scrollbarThumbPointerDown', $event, 'syncedSplit')"
    />
  </div>
  <div v-else-if="viewMode === 'split'" class="split-view">
    <div class="pane-shell old-pane-shell" :class="{ 'has-diff-scroll': hasLeftScroll }">
      <div
        :ref="(element) => setPaneRef('left', element)"
        class="pane old-pane"
        @scroll="emit('scroll', 'left', $event)"
        @pointermove="emit('pointerMove', $event)"
        @mouseleave="emit('mouseLeave')"
        @mouseup="emit('mouseUp')"
      >
        <div class="spacer" :style="{ height: `${leftTotalSize}px` }">
          <div
            v-for="entry in leftRenderedRows"
            :key="`old-${String(entry.virtualRow.key)}`"
            class="virtual-row"
            :data-index="entry.virtualRow.index"
            :ref="entry.diffRow ? undefined : measureLeftElement"
            :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
          >
            <DiffRenderedRow
              mode="pane"
              pane-side="old"
              :row="entry.diffRow"
              :review-row="entry.reviewRow"
              review-class="old"
              :file-id="model.fileId"
              :old-syntax-spans="entry.oldSyntaxSpans"
              :old-comment-count="entry.oldCommentCount"
              :old-comments-expanded="entry.oldCommentsExpanded"
              :old-review-highlights="entry.oldReviewHighlights"
              :old-search-highlights="entry.oldSearchHighlights"
              :old-diagnostics="[]"
              :comment-hover-disabled="commentHoverDisabled"
              :draft-body="draftBody"
              :chat-messages="chatMessagesForEntry(entry)"
              :agent-responding="agentRespondingForEntry(entry)"
              :error="reviewError"
              @comment="emit('comment', $event)"
              @toggle-comments="emit('toggleComments', $event)"
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
        </div>
      </div>
      <DiffScrollbar
        v-if="hasLeftScroll"
        :markers="leftMarkers"
        :thumb-style="leftThumbStyle"
        @track-pointer-down="emit('scrollbarTrackPointerDown', $event, 'left')"
        @thumb-pointer-down="emit('scrollbarThumbPointerDown', $event, 'left')"
      />
    </div>
    <div class="pane-shell" :class="{ 'has-diff-scroll': hasRightScroll }">
      <div
        :ref="(element) => setPaneRef('right', element)"
        class="pane new-pane"
        @scroll="emit('scroll', 'right', $event)"
        @pointermove="emit('pointerMove', $event)"
        @mouseleave="emit('mouseLeave')"
        @mouseup="emit('mouseUp')"
      >
        <div class="spacer" :style="{ height: `${rightTotalSize}px` }">
          <div
            v-for="entry in rightRenderedRows"
            :key="`new-${String(entry.virtualRow.key)}`"
            class="virtual-row"
            :data-index="entry.virtualRow.index"
            :ref="entry.diffRow ? undefined : measureRightElement"
            :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
          >
            <DiffRenderedRow
              mode="pane"
              pane-side="new"
              :row="entry.diffRow"
              :review-row="entry.reviewRow"
              review-class="new"
              :file-id="model.fileId"
              :new-syntax-spans="entry.newSyntaxSpans"
              :new-comment-count="entry.newCommentCount"
              :new-comments-expanded="entry.newCommentsExpanded"
              :new-review-highlights="entry.newReviewHighlights"
              :new-search-highlights="entry.newSearchHighlights"
              :new-diagnostics="entry.newDiagnostics"
              :comment-hover-disabled="commentHoverDisabled"
              :draft-body="draftBody"
              :chat-messages="chatMessagesForEntry(entry)"
              :agent-responding="agentRespondingForEntry(entry)"
              :error="reviewError"
              @comment="emit('comment', $event)"
              @toggle-comments="emit('toggleComments', $event)"
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
        </div>
      </div>
      <DiffScrollbar
        v-if="hasRightScroll"
        :markers="rightMarkers"
        :thumb-style="rightThumbStyle"
        @track-pointer-down="emit('scrollbarTrackPointerDown', $event, 'right')"
        @thumb-pointer-down="emit('scrollbarThumbPointerDown', $event, 'right')"
      />
    </div>
  </div>
  <div v-else class="pane-shell" :class="{ 'has-diff-scroll': hasInlineScroll }">
    <div
      :ref="(element) => setPaneRef('inline', element)"
      class="pane inline-view"
      @scroll="emit('scroll', 'inline', $event)"
      @pointermove="emit('pointerMove', $event)"
      @mouseleave="emit('mouseLeave')"
      @mouseup="emit('mouseUp')"
    >
      <div class="spacer inline-spacer" :style="{ height: `${inlineTotalSize}px` }">
        <div
          v-for="entry in inlineRenderedRows"
          :key="String(entry.virtualRow.key)"
          class="virtual-row"
          :data-index="entry.virtualRow.index"
          :ref="entry.diffRow ? undefined : measureInlineElement"
          :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
        >
          <DiffRenderedRow
            mode="inline"
            :row="entry.diffRow"
            :review-row="entry.reviewRow"
            review-class="inline"
            :file-id="model.fileId"
            :inline-syntax-spans="entry.inlineSyntaxSpans"
            :old-comment-count="entry.oldCommentCount"
            :new-comment-count="entry.newCommentCount"
            :old-comments-expanded="entry.oldCommentsExpanded"
            :new-comments-expanded="entry.newCommentsExpanded"
            :inline-review-highlights="entry.inlineReviewHighlights"
            :inline-search-highlights="entry.inlineSearchHighlights"
            :old-diagnostics="[]"
            :new-diagnostics="entry.newDiagnostics"
            :comment-hover-disabled="commentHoverDisabled"
            :draft-body="draftBody"
            :chat-messages="chatMessagesForEntry(entry)"
            :agent-responding="agentRespondingForEntry(entry)"
            :error="reviewError"
            @comment="emit('comment', $event)"
            @toggle-comments="emit('toggleComments', $event)"
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
      </div>
    </div>
    <DiffScrollbar
      v-if="hasInlineScroll"
      :markers="inlineMarkers"
      :thumb-style="inlineThumbStyle"
      @track-pointer-down="emit('scrollbarTrackPointerDown', $event, 'inline')"
      @thumb-pointer-down="emit('scrollbarThumbPointerDown', $event, 'inline')"
    />
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import type { DiffRenderModel, DiffViewMode, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide } from '../../lib/protocol';
import DiffRenderedRow from './DiffRenderedRow.vue';
import DiffScrollbar, { type DiffScrollMarker } from './DiffScrollbar.vue';
import type { InlineReviewEntry } from './InlineReviewBox.vue';

type PaneKey = 'left' | 'right' | 'syncedSplit' | 'inline';
type RenderedEntry = Record<string, any>;
type ReviewReplyPayload = { thread: ReviewThread; body: string };

const props = defineProps<{
  loading: boolean;
  error?: string;
  model?: DiffRenderModel;
  rowsLength: number;
  initialSyntaxGateActive: boolean;
  viewMode: DiffViewMode;
  syncScroll: boolean;
  leftRenderedRows: RenderedEntry[];
  rightRenderedRows: RenderedEntry[];
  syncedSplitRenderedRows: RenderedEntry[];
  inlineRenderedRows: RenderedEntry[];
  leftTotalSize: number;
  rightTotalSize: number;
  syncedSplitTotalSize: number;
  inlineTotalSize: number;
  hasLeftScroll: boolean;
  hasRightScroll: boolean;
  hasSyncedSplitScroll: boolean;
  hasInlineScroll: boolean;
  leftMarkers: DiffScrollMarker[];
  rightMarkers: DiffScrollMarker[];
  syncedSplitMarkers: DiffScrollMarker[];
  inlineMarkers: DiffScrollMarker[];
  leftThumbStyle: CSSProperties;
  rightThumbStyle: CSSProperties;
  syncedSplitThumbStyle: CSSProperties;
  inlineThumbStyle: CSSProperties;
  commentHoverDisabled: boolean;
  draftBody: string;
  reviewError?: string;
  chatMessagesForEntry: (entry: InlineReviewEntry) => ReviewChatMessage[];
  agentRespondingForEntry: (entry: InlineReviewEntry) => boolean;
  measureLeftElement: (element: unknown) => void;
  measureRightElement: (element: unknown) => void;
  measureSyncedSplitElement: (element: unknown) => void;
  measureInlineElement: (element: unknown) => void;
}>();

const emit = defineEmits<{
  paneRef: [pane: PaneKey, element: Element | null];
  scroll: [pane: PaneKey, event: Event];
  pointerMove: [event: PointerEvent];
  mouseLeave: [];
  mouseUp: [];
  scrollbarTrackPointerDown: [event: PointerEvent, pane: PaneKey];
  scrollbarThumbPointerDown: [event: PointerEvent, pane: PaneKey];
  comment: [payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: SyntaxSide; line: number }];
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

const renderedEntry = (entry: RenderedEntry) => entry.reviewRow as InlineReviewEntry | undefined;

const chatMessagesForEntry = (entry: RenderedEntry) => {
  const reviewRow = renderedEntry(entry);
  return reviewRow ? props.chatMessagesForEntry(reviewRow) : [];
};

const agentRespondingForEntry = (entry: RenderedEntry) => {
  const reviewRow = renderedEntry(entry);
  return reviewRow ? props.agentRespondingForEntry(reviewRow) : false;
};

const setPaneRef = (pane: PaneKey, element: unknown) => {
  emit('paneRef', pane, element instanceof Element ? element : null);
};
</script>

<style scoped lang="scss">
.message {
  padding: 24px;
  color: #7e8aa0;

  &.error {
    color: #ff8d8d;
  }
}

.syntax-gate {
  min-height: 0;
  background: #111318;
}

.split-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}

.pane-shell {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  &.has-diff-scroll {
    grid-template-columns: minmax(0, 1fr) 18px;
  }
}

.old-pane-shell {
  border-right: 1px solid #252a35;
}

.pane {
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;

  &::-webkit-scrollbar {
    width: 0;
    height: 14px;
  }

  &::-webkit-scrollbar-track {
    background: #151923;
  }

  &::-webkit-scrollbar-thumb {
    background: #4b5568;
    border: 4px solid #151923;
    border-radius: 999px;
  }
}

.inline-view,
.synced-split-view {
  min-width: 0;
}

.spacer {
  position: relative;
  min-width: 560px;
}

.synced-split-spacer {
  min-width: 1120px;
}

.inline-spacer {
  min-width: 900px;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 1;
  contain: layout paint style;
  overflow: hidden;
}
</style>
