<template>
  <div v-if="status.loading" class="message">Loading diff...</div>

  <div v-else-if="status.error" class="message error">{{ status.error }}</div>

  <div v-else-if="!status.hasModel" class="message">Select a changed file to view its diff.</div>

  <div v-else-if="status.rowsLength === 0" class="message">No unstaged diff for this file.</div>

  <div v-else-if="status.initialSyntaxGateActive" class="syntax-gate" />

  <DiffPane
    v-else-if="viewMode === 'split' && syncScroll"
    :pane="panes.syncedSplit"
    :comment-hover-disabled="commentHoverDisabled"
    :review="review"
    :review-actions="reviewActions"
    :actions="actions"
  />

  <div v-else-if="viewMode === 'split'" class="split-view">
    <DiffPane
      :pane="panes.left"
      :comment-hover-disabled="commentHoverDisabled"
      :review="review"
      :review-actions="reviewActions"
      :actions="actions"
    />

    <DiffPane
      :pane="panes.right"
      :comment-hover-disabled="commentHoverDisabled"
      :review="review"
      :review-actions="reviewActions"
      :actions="actions"
    />
  </div>

  <DiffPane
    v-else
    :pane="panes.inline"
    :comment-hover-disabled="commentHoverDisabled"
    :review="review"
    :review-actions="reviewActions"
    :actions="actions"
  />
</template>

<script setup lang="ts">
import type { DiffViewMode } from '../../lib/protocol';
import DiffPane from './DiffPane.vue';
import type { DiffPaneActions, DiffPaneKey, DiffPaneModel, DiffReviewActions, DiffReviewUi } from './diffViewModels';

defineProps<{
  status: {
    loading: boolean;
    error?: string;
    hasModel: boolean;
    rowsLength: number;
    initialSyntaxGateActive: boolean;
  };
  viewMode: DiffViewMode;
  syncScroll: boolean;
  panes: Record<DiffPaneKey, DiffPaneModel>;
  commentHoverDisabled: boolean;
  review: DiffReviewUi;
  reviewActions: DiffReviewActions;
  actions: DiffPaneActions;
}>();
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
</style>
