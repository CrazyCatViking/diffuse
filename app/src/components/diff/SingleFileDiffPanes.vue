<template>
  <EmptyState v-if="status.loading" class="diff-state" title="Loading diff" description="Reading file changes and syntax context." />

  <EmptyState v-else-if="status.error" class="diff-state error-state" title="Could not load diff" :description="status.error" bordered />

  <EmptyState
    v-else-if="!status.hasModel"
    class="diff-state"
    title="Select a changed file"
    description="Choose a file or folder from the review workspace."
  />

  <EmptyState
    v-else-if="status.rowsLength === 0"
    class="diff-state"
    title="No diff for this file"
    description="The selected compare target has no visible changes for this file."
  />

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
import EmptyState from '../ui/EmptyState.vue';
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
.diff-state {
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

.syntax-gate {
  min-height: 0;
  background: var(--color-bg-app);
}

.split-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}
</style>
