<template>
  <div class="pane-shell" :class="[pane.shellClass, { 'has-diff-scroll': pane.hasScroll }]">
    <div
      :ref="setPaneRef"
      class="pane"
      :class="pane.paneClass"
      @scroll="actions.scroll(pane.key, $event)"
      @pointermove="actions.pointerMove"
      @mouseleave="actions.mouseLeave"
      @mouseup="actions.mouseUp"
    >
      <div class="spacer" :class="pane.spacerClass" :style="{ height: `${pane.totalSize}px` }">
        <div
          v-for="entry in pane.rows"
          :key="rowKey(entry)"
          class="virtual-row"
          :data-index="entry.virtualRow.index"
          :ref="entry.diffRow ? undefined : pane.measureElement"
          :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
        >
          <DiffComposedRow
            :entry="entry"
            :layout="rowLayout"
            :review="review"
            :review-actions="reviewActions"
            :review-class="reviewClass(entry)"
          />
        </div>
      </div>
    </div>

    <DiffScrollbar
      v-if="pane.hasScroll"
      :markers="pane.markers"
      :thumb-style="pane.thumbStyle"
      @track-pointer-down="actions.scrollbarTrackPointerDown($event, pane.key)"
      @thumb-pointer-down="actions.scrollbarThumbPointerDown($event, pane.key)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import DiffComposedRow from './DiffComposedRow.vue';
import DiffScrollbar from './DiffScrollbar.vue';
import type { DiffPaneActions, DiffPaneModel, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';

const props = defineProps<{
  pane: DiffPaneModel;
  commentHoverDisabled: boolean;
  review: DiffReviewUi;
  reviewActions: DiffReviewActions;
  actions: DiffPaneActions;
}>();

const rowLayout = computed(() => ({
  compositionMode: props.pane.compositionMode,
  paneSide: props.pane.paneSide,
  commentHoverDisabled: props.commentHoverDisabled,
  actions: props.actions,
}));

const setPaneRef = (element: unknown) => {
  props.actions.paneRef(props.pane.key, element instanceof Element ? element : null);
};

const rowKey = (entry: DiffRenderedEntry) => `${props.pane.keyPrefix ?? ''}${String(entry.virtualRow.key)}`;

const reviewClass = (entry: DiffRenderedEntry) => {
  if (!entry.reviewRow) return props.pane.compositionMode === 'split' ? 'synced-split' : props.pane.paneSide ?? 'inline';
  if (props.pane.compositionMode === 'split') return ['synced-split', entry.reviewRow.anchor.side];
  return props.pane.paneSide ?? 'inline';
};
</script>

<style scoped lang="scss">
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

.pane {
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

.spacer {
  position: relative;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  contain: layout paint style;
  overflow: hidden;
}
</style>
