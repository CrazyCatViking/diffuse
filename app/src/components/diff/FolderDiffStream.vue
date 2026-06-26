<template>
  <EmptyState v-if="loading" class="folder-state" title="Loading folder diff" description="Reading changed files in this folder." />

  <EmptyState v-else-if="error" class="folder-state error-state" title="Could not load folder diff" :description="error" bordered />

  <EmptyState
    v-else-if="modelsLength === 0"
    class="folder-state"
    title="No diffs in this folder"
    description="The selected compare target has no visible changes here."
  />

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
              <div class="file-title-group">
                <span class="file-index">File {{ (entry.item.fileIndex ?? 0) + 1 }} of {{ modelsLength }}</span>

                <span class="file-path">{{ entry.model.fileId }}</span>
              </div>

              <div class="file-pills">
                <span class="file-row-count">{{ entry.model.rows.length }} rows</span>

                <span v-if="reviewSummary(entry.model.fileId)" class="review-summary" :class="reviewSummary(entry.model.fileId)?.className">
                  {{ reviewSummary(entry.model.fileId)?.label }}
                </span>

                <span
                  v-if="diagnosticSummary(entry.model.fileId)"
                  class="diagnostic-summary"
                  :class="diagnosticSummary(entry.model.fileId)?.className"
                >
                  {{ diagnosticSummary(entry.model.fileId)?.label }}
                </span>
              </div>
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
import EmptyState from '../ui/EmptyState.vue';
import DiffComposedRow from './DiffComposedRow.vue';
import DiffScrollbar, { type DiffScrollMarker } from './DiffScrollbar.vue';
import DiffViewerOverlays from './DiffViewerOverlays.vue';
import type { DiffPaneActions, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';

type RenderedEntry = DiffRenderedEntry & {
  fileId: string;
  item: { kind: 'file' | 'empty' | 'row'; fileIndex?: number };
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
  reviewSummary: (fileId: string) => { label: string; className: string } | undefined;
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
    comment: (payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }) =>
      emit('comment', entry.fileId, payload),
    toggleComments: (payload: { side: SyntaxSide; line: number }) => emit('toggleComments', payload),
  } satisfies Pick<DiffPaneActions, 'comment' | 'toggleComments'>,
});
</script>

<style scoped lang="scss">
.folder-state {
  min-height: 0;
  height: 100%;
  background: var(--color-bg-app);
}

.error-state {
  color: var(--color-danger);

  :deep(h1) {
    color: var(--color-danger);
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
    background: var(--color-scrollbar-track);
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-scrollbar-thumb);
    border: 4px solid var(--color-scrollbar-track);
    border-radius: var(--radius-pill);
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-6);
  height: 44px;
  padding: 0 var(--space-7);
  color: var(--color-text-primary);
  background: linear-gradient(90deg, var(--color-bg-panel-raised), var(--color-bg-panel));
  border-top: 1px solid var(--color-border-default);
  border-bottom: 1px solid var(--color-border-default);
  box-shadow: var(--shadow-inset-highlight);
  font-weight: 650;
}

.file-title-group {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.file-index {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-subtle);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-caption);
  text-transform: uppercase;
}

.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-pills {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  min-width: 0;
}

.file-row-count,
.review-summary,
.diagnostic-summary {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  color: var(--color-text-subtle);
  background: var(--color-bg-inset);
  font-size: var(--font-size-label);
  font-weight: 650;
}

.diagnostic-summary {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(143, 179, 255, 0.18);

  &.error {
    color: var(--color-danger);
    background: var(--color-danger-muted);
    border-color: rgba(255, 107, 107, 0.18);
  }

  &.warning {
    color: var(--color-warning);
    background: var(--color-warning-muted);
    border-color: rgba(240, 184, 106, 0.18);
  }
}

.review-summary {
  color: var(--color-success);
  background: var(--color-success-muted);
  border-color: rgba(91, 184, 119, 0.18);

  &.open {
    color: var(--color-review);
    background: var(--color-review-muted);
    border-color: rgba(240, 195, 106, 0.2);
  }
}

.empty-file {
  margin: var(--space-5) var(--space-7);
  padding: var(--space-7) var(--space-8);
  color: var(--color-text-subtle);
  background: var(--color-bg-panel);
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-4);
}
</style>
