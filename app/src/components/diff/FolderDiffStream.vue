<template>
  <div v-if="loading" class="message">Loading folder diff...</div>

  <div v-else-if="error" class="message error">{{ error }}</div>

  <div v-else-if="modelsLength === 0" class="message">No diffs in this folder.</div>

  <div v-else class="folder-diffs-shell" :class="{ 'has-diff-scroll': hasFolderScroll }">
    <div
      :ref="setScrollRef"
      class="folder-diffs"
      @scroll="emit('scroll')"
      @pointermove="emit('pointerMove', $event)"
      @mouseleave="emit('mouseLeave')"
      @mouseup="emit('mouseUp')"
    >
      <div class="folder-spacer" :style="{ height: `${folderTotalSize}px` }">
        <div
          v-for="entry in folderRenderedRows"
          :key="String(entry.virtualRow.key)"
          class="virtual-row"
          :data-index="entry.virtualRow.index"
          :ref="entry.diffRow ? undefined : measureFolderElement"
          :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
        >
          <template v-if="entry.item.kind === 'file'">
            <header class="file-header">
              <span>{{ entry.model.fileId }}</span>

              <span class="file-row-count">{{ entry.model.rows.length }} rows</span>

              <span
                v-if="diagnosticSummary(entry.model.fileId)"
                class="diagnostic-summary"
                :class="diagnosticSummary(entry.model.fileId)?.className"
              >
                {{ diagnosticSummary(entry.model.fileId)?.label }}
              </span>
            </header>
          </template>
          <div v-else-if="entry.item.kind === 'empty'" class="empty-file">No diff for this file.</div>
          <template v-else-if="entry.item.kind === 'row' && viewMode === 'split'">
            <DiffComposedRow
              :entry="entry"
              :layout="rowLayout(entry, 'split')"
              :review="review"
              :review-actions="reviewActions"
              :review-class="entry.reviewRow ? ['synced-split', entry.reviewRow.anchor.side] : 'synced-split'"
            />
          </template>
          <template v-else-if="entry.item.kind === 'row'">
            <DiffComposedRow
              :entry="entry"
              :layout="rowLayout(entry, 'inline')"
              :review="review"
              :review-actions="reviewActions"
              review-class="inline"
            />
          </template>
        </div>
      </div>
      <DiffViewerOverlays
        :show-selection-toolbar="showSelectionToolbar"
        :selection-style="selectionStyle"
        :lsp-hover="lspHover"
        :lsp-hover-style="lspHoverStyle"
        @comment-selection="emit('commentSelection')"
        @chat-selection="emit('chatSelection')"
      />
    </div>
    <DiffScrollbar
      v-if="hasFolderScroll"
      :markers="folderMarkers"
      :thumb-style="folderThumbStyle"
      @track-pointer-down="emit('scrollbarTrackPointerDown', $event)"
      @thumb-pointer-down="emit('scrollbarThumbPointerDown', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import type { DiffViewMode, SyntaxSide } from '../../lib/protocol';
import DiffComposedRow from './DiffComposedRow.vue';
import DiffScrollbar, { type DiffScrollMarker } from './DiffScrollbar.vue';
import DiffViewerOverlays from './DiffViewerOverlays.vue';
import type { DiffPaneActions, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';

type RenderedEntry = DiffRenderedEntry & {
  fileId: string;
  item: { kind: 'file' | 'empty' | 'row' };
  model: { fileId: string; rows: unknown[] };
};

const props = defineProps<{
  loading: boolean;
  error?: string;
  modelsLength: number;
  viewMode: DiffViewMode;
  folderRenderedRows: RenderedEntry[];
  folderTotalSize: number;
  hasFolderScroll: boolean;
  folderMarkers: DiffScrollMarker[];
  folderThumbStyle: CSSProperties;
  commentHoverDisabled: boolean;
  review: DiffReviewUi;
  reviewActions: DiffReviewActions;
  showSelectionToolbar: boolean;
  selectionStyle: CSSProperties;
  lspHover: { visible: boolean; loading: boolean; contents: string };
  lspHoverStyle: CSSProperties;
  diagnosticSummary: (fileId: string) => { label: string; className: string } | undefined;
  measureFolderElement: (element: unknown) => void;
}>();

const emit = defineEmits<{
  scrollRef: [element: Element | null];
  scroll: [];
  pointerMove: [event: PointerEvent];
  mouseLeave: [];
  mouseUp: [];
  scrollbarTrackPointerDown: [event: PointerEvent];
  scrollbarThumbPointerDown: [event: PointerEvent];
  commentSelection: [];
  chatSelection: [];
  comment: [fileId: string, payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: SyntaxSide; line: number }];
}>();

const setScrollRef = (element: unknown) => {
  emit('scrollRef', element instanceof Element ? element : null);
};

const rowLayout = (entry: RenderedEntry, compositionMode: 'split' | 'inline') => ({
  compositionMode,
  commentHoverDisabled: props.commentHoverDisabled,
  actions: {
    comment: (payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }) => emit('comment', entry.fileId, payload),
    toggleComments: (payload: { side: SyntaxSide; line: number }) => emit('toggleComments', payload),
  } satisfies Pick<DiffPaneActions, 'comment' | 'toggleComments'>,
});
</script>

<style scoped lang="scss">
.message {
  padding: 24px;
  color: #7e8aa0;

  &.error {
    color: #ff8d8d;
  }
}

.folder-diffs-shell {
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

.folder-diffs {
  position: relative;
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

.folder-spacer {
  position: relative;
  min-width: 1120px;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  contain: layout paint style;
  overflow: hidden;
}

.file-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  color: #f5f7fb;
  background: #171b25;
  border-top: 1px solid #252a35;
  border-bottom: 1px solid #252a35;
  font-weight: 650;
}

.file-row-count {
  color: #7e8aa0;
  font-size: 12px;
  font-weight: 500;
}

.diagnostic-summary {
  margin-left: auto;
  color: #8fb3ff;
  font-size: 12px;
  font-weight: 700;

  &.error {
    color: #ff8d8d;
  }
  &.warning {
    color: #f0b86a;
  }
}

.empty-file {
  padding: 18px 22px;
  color: #7e8aa0;
}
</style>
