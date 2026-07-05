<template>
  <Panel
    v-if="search.drawerOpen"
    ref="rootRef"
    class="search-drawer"
    padding="none"
    role="complementary"
    aria-label="Pinned search results"
    @pointerdown.capture="cursor.setActiveSurface(pinnedResultsSurfaceId)"
  >
    <header class="drawer-header">
      <div class="drawer-title">
        <Badge tone="review">Pinned search</Badge>

        <h2>{{ search.pinnedQuery || 'Search results' }}</h2>
      </div>

      <Button variant="ghost" size="sm" @click="search.closeDrawer()">Close</Button>
    </header>

    <div class="drawer-controls">
      <Button variant="secondary" size="sm" :disabled="displayedPinnedEntries.length === 0" @click="previousSelection">Previous</Button>

      <Button variant="secondary" size="sm" :disabled="displayedPinnedEntries.length === 0" @click="nextSelection">Next</Button>

      <Button variant="review" size="sm" :disabled="!search.pinnedSelectedResult" @click="openSelected">Open</Button>
    </div>

    <div class="drawer-summary">
      <Badge tone="neutral">{{ search.pinnedResultCount }} results</Badge>

      <span v-if="search.pinnedSelectedResult">{{ displayedSelectedPosition + 1 }} of {{ displayedPinnedEntries.length }}</span>
    </div>

    <div ref="drawerResultsRef" class="drawer-results">
      <EmptyState
        v-if="!search.hasPinnedSnapshot"
        align="start"
        bordered
        title="No pinned results"
        description="Run a search from the sidebar or command palette, then pin it here to walk the result list."
      />

      <EmptyState
        v-else-if="search.pinnedResultCount === 0"
        align="start"
        bordered
        title="All pinned results removed"
        description="Pin the search again to restore the full result list."
      />

      <!-- @vue-generic {PinnedTreeData} -->
      <TreeList
        v-else
        v-model:collapsed-keys="collapsedGroups"
        class="pinned-tree"
        :nodes="pinnedTreeNodes"
        :active-key="activePinnedTreeKey"
        :virtual-scroll-element="drawerResultsRef"
        :virtual-estimate-size="32"
        :virtual-overscan="16"
        aria-label="Pinned search results"
        density="compact"
      >
        <template #default="{ node }">
          <button v-if="node.data?.type === 'group'" class="group-label" type="button" @click="toggleGroup(node.key)">
            <span>{{ node.data.group.label }}</span>
          </button>

          <button
            v-else-if="node.data?.type === 'fileGroup'"
            class="file-label"
            type="button"
            :title="node.data.fileGroup.path"
            @click="toggleGroup(node.key)"
          >
            <span class="file-name">{{ fileName(node.data.fileGroup.path) }}</span>

            <span v-if="parentPath(node.data.fileGroup.path)" class="file-path">{{ parentPath(node.data.fileGroup.path) }}</span>
          </button>

          <button
            v-else-if="node.data?.type === 'entry'"
            class="entry-button"
            type="button"
            :title="entryTitle(node.data.entry)"
            @click="selectEntry(node.data.entry.index)"
            @dblclick="openResult(node.data.entry.result)"
          >
            <span class="entry-anchor" :class="entryAnchorClass(node.data.entry)">{{ entryAnchor(node.data.entry) }}</span>

            <span class="entry-text" :class="{ 'code-excerpt': node.data.entry.result.kind === 'content' }">
              <SearchMatchHighlight :text="entryText(node.data.entry)" :ranges="entryRanges(node.data.entry)" />
            </span>
          </button>
        </template>

        <template #actions="{ node }">
          <Badge v-if="node.data?.type === 'group'" tone="neutral">{{ node.data.group.count }}</Badge>

          <Badge v-else-if="node.data?.type === 'fileGroup'" tone="neutral">{{ node.data.fileGroup.entries.length }}</Badge>

          <button
            v-else-if="node.data?.type === 'entry'"
            class="remove-result"
            type="button"
            title="Remove pinned result"
            aria-label="Remove pinned result"
            @click="search.removePinnedResult(node.data.entry.result.id)"
          >
            Remove
          </button>
        </template>
      </TreeList>
    </div>
  </Panel>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import TreeList, { type TreeListNode } from '../ui/TreeList.vue';
import SearchMatchHighlight from './SearchMatchHighlight.vue';
import {
  pinnedResultsSurfaceId,
  type CursorActionContext,
  type CursorCommand,
  type CursorMotion,
  type PinnedResultsSurface,
  useCursorStore,
} from '../../stores/cursor';
import { useSearchStore } from '../../stores/search';
import type { ContentSearchResult, SearchMatchRange, SearchResult, SymbolSearchResult } from '../../lib/search/searchTypes';

type PinnedEntry = {
  result: SearchResult;
  index: number;
};

type PinnedFileGroup = {
  id: string;
  path: string;
  entries: Array<PinnedEntry & { result: ContentSearchResult }>;
};

type PinnedGroup =
  | { id: string; kind: 'file' | 'comment' | 'symbol'; label: string; count: number; entries: PinnedEntry[] }
  | { id: string; kind: 'content'; label: string; count: number; files: PinnedFileGroup[] };

type PinnedTreeData =
  | { type: 'group'; group: PinnedGroup }
  | { type: 'fileGroup'; fileGroup: PinnedFileGroup }
  | { type: 'entry'; entry: PinnedEntry };

const emit = defineEmits<{
  open: [result: SearchResult];
}>();

const search = useSearchStore();
const cursor = useCursorStore();
const collapsedGroups = ref(new Set<string>());
const drawerResultsRef = ref<HTMLElement | null>(null);
const rootRef = ref<{ $el?: Element } | null>(null);
cursor.registerSurface<PinnedResultsSurface>(
  { id: pinnedResultsSurfaceId, type: 'pinned-results', position: {} },
  {
    id: pinnedResultsSurfaceId,
    getRect: () => (rootRef.value?.$el instanceof HTMLElement ? rootRef.value.$el.getBoundingClientRect() : undefined),
    isEligible: () => search.drawerOpen,
    activate: () => (rootRef.value?.$el instanceof HTMLElement ? rootRef.value.$el.focus({ preventScroll: true }) : undefined),
    onMotion: handleSurfaceMotion,
    onCommand: handleSurfaceCommand,
  },
);

const pinnedGroups = computed<PinnedGroup[]>(() => {
  const fileEntries = search.pinnedResultEntries.filter((entry) => entry.result.kind === 'file');
  const commentEntries = search.pinnedResultEntries.filter((entry) => entry.result.kind === 'comment');
  const symbolEntries = search.pinnedResultEntries.filter(
    (entry): entry is PinnedEntry & { result: SymbolSearchResult } => entry.result.kind === 'symbol',
  );
  const contentEntries = search.pinnedResultEntries.filter(
    (entry): entry is PinnedEntry & { result: ContentSearchResult } => entry.result.kind === 'content',
  );
  const groups: PinnedGroup[] = [];

  if (fileEntries.length > 0)
    groups.push({ id: 'files', kind: 'file', label: 'File names and paths', count: fileEntries.length, entries: fileEntries });
  if (contentEntries.length > 0) {
    groups.push({
      id: 'content',
      kind: 'content',
      label: 'File contents',
      count: contentEntries.length,
      files: contentGroupsByFile(contentEntries),
    });
  }
  if (commentEntries.length > 0)
    groups.push({ id: 'comments', kind: 'comment', label: 'Comments', count: commentEntries.length, entries: commentEntries });
  if (symbolEntries.length > 0)
    groups.push({ id: 'symbols', kind: 'symbol', label: 'Symbols', count: symbolEntries.length, entries: symbolEntries });

  return groups;
});

const pinnedTreeNodes = computed<TreeListNode<PinnedTreeData>[]>(() => pinnedGroups.value.map(pinnedGroupToTreeNode));
const displayedPinnedEntries = computed(() => pinnedGroups.value.flatMap(pinnedGroupEntries));
const pinnedCursorActive = computed(() => cursor.isActiveSurface(pinnedResultsSurfaceId));
const activePinnedTreeKey = computed(() => (pinnedCursorActive.value ? search.pinnedSelectedResult?.id : undefined));
const visiblePinnedTreeKeys = computed(() => {
  const keys: string[] = [];
  const collect = (nodes: TreeListNode<PinnedTreeData>[]) => {
    for (const node of nodes) {
      keys.push(node.key);
      if (node.children?.length && !collapsedGroups.value.has(node.key)) collect(node.children);
    }
  };
  collect(pinnedTreeNodes.value);
  return keys;
});
const displayedSelectedPosition = computed(() => {
  const position = displayedPinnedEntries.value.findIndex((entry) => entry.index === search.pinnedSelectedIndex);
  return position >= 0 ? position : 0;
});

const selectEntry = (index: number) => {
  search.selectPinnedResult(index);
  void revealSelectedPinnedResult('nearest');
};

const previousSelection = (count = 1) => {
  moveDisplayedSelection(-1, count);
  void revealSelectedPinnedResult('previous');
};

const nextSelection = (count = 1) => {
  moveDisplayedSelection(1, count);
  void revealSelectedPinnedResult('next');
};

const moveDisplayedSelection = (direction: 1 | -1, count = 1) => {
  const entries = displayedPinnedEntries.value;
  if (entries.length === 0) return;

  const currentPosition = entries.findIndex((entry) => entry.index === search.pinnedSelectedIndex);
  const startPosition = currentPosition === -1 ? (direction > 0 ? -1 : 0) : currentPosition;
  const nextPosition = positiveModulo(startPosition + direction * Math.max(1, count), entries.length);
  search.selectPinnedResult(entries[nextPosition]?.index ?? entries[0].index);
};

const positiveModulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

const moveSelectionToBoundary = (boundary: 'start' | 'end') => {
  const entries = displayedPinnedEntries.value;
  const entry = boundary === 'start' ? entries[0] : entries[entries.length - 1];
  if (entry) search.selectPinnedResult(entry.index);
};

const pinnedPageSize = () => Math.max(4, Math.floor((drawerResultsRef.value?.clientHeight ?? 240) / 32 / 2));

const openSelected = () => {
  if (search.pinnedSelectedResult) openResult(search.pinnedSelectedResult);
};

const openResult = (result: SearchResult) => {
  search.rememberQuery();
  emit('open', result);
};

const toggleGroup = (id: string) => {
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
};

const revealSelectedPinnedResult = async (direction: 'next' | 'previous' | 'nearest') => {
  expandSelectedPinnedGroups();
  await nextTick();

  const container = drawerResultsRef.value;
  let selected = container?.querySelector<HTMLElement>('.tree-row.active.entry-row');
  if (!container) return;

  if (!selected) {
    const selectedRowIndex = visiblePinnedTreeKeys.value.indexOf(search.pinnedSelectedResult?.id ?? '');
    if (selectedRowIndex >= 0) {
      container.scrollTo({ top: selectedRowIndex * 32, behavior: 'auto' });
      await nextTick();
      selected = container.querySelector<HTMLElement>('.tree-row.active.entry-row');
    }
  }
  if (!selected) return;

  const containerRect = container.getBoundingClientRect();
  const selectedRect = selected.getBoundingClientRect();
  const forwardMargin = Math.min(180, Math.max(72, container.clientHeight * 0.32));
  const backwardMargin = Math.min(120, Math.max(48, container.clientHeight * 0.22));
  const bottomMargin = direction === 'next' ? forwardMargin : 48;
  const topMargin = direction === 'previous' ? backwardMargin : 40;

  if (selectedRect.bottom > containerRect.bottom - bottomMargin) {
    container.scrollTo({
      top: container.scrollTop + selectedRect.bottom - (containerRect.bottom - bottomMargin),
      behavior: direction === 'nearest' ? 'smooth' : 'auto',
    });
    return;
  }

  if (selectedRect.top < containerRect.top + topMargin) {
    container.scrollTo({
      top: container.scrollTop + selectedRect.top - (containerRect.top + topMargin),
      behavior: direction === 'nearest' ? 'smooth' : 'auto',
    });
  }
};

const expandSelectedPinnedGroups = () => {
  const result = search.pinnedSelectedResult;
  if (!result) return;

  const next = new Set(collapsedGroups.value);
  let changed = false;
  const expand = (key: string) => {
    if (next.delete(key)) changed = true;
  };
  if (result.kind === 'content') {
    expand('content');
    expand(`content:${result.path}`);
  } else if (result.kind === 'comment') {
    expand('comments');
  } else if (result.kind === 'symbol') {
    expand('symbols');
  } else {
    expand('files');
  }
  if (changed) collapsedGroups.value = next;
};

const contentGroupsByFile = (entries: Array<PinnedEntry & { result: ContentSearchResult }>): PinnedFileGroup[] => {
  const groups = new Map<string, PinnedFileGroup>();
  for (const entry of entries) {
    const path = entry.result.path;
    const id = `content:${path}`;
    const group = groups.get(path) ?? { id, path, entries: [] };
    group.entries.push(entry);
    groups.set(path, group);
  }
  return [...groups.values()];
};

const pinnedGroupToTreeNode = (group: PinnedGroup): TreeListNode<PinnedTreeData> => ({
  key: group.id,
  label: group.label,
  title: group.label,
  rowClass: { 'group-row': true },
  data: { type: 'group', group },
  children:
    group.kind === 'content'
      ? group.files.map((fileGroup) => ({
          key: fileGroup.id,
          label: fileGroup.path,
          title: fileGroup.path,
          rowClass: { 'file-group-row': true },
          data: { type: 'fileGroup', fileGroup },
          children: fileGroup.entries.map(pinnedEntryToTreeNode),
        }))
      : group.entries.map(pinnedEntryToTreeNode),
});

const pinnedGroupEntries = (group: PinnedGroup): PinnedEntry[] => {
  if (group.kind !== 'content') return group.entries;
  return group.files.flatMap((fileGroup) => fileGroup.entries);
};

const pinnedEntryToTreeNode = (entry: PinnedEntry): TreeListNode<PinnedTreeData> => ({
  key: entry.result.id,
  label: entry.result.title,
  title: entry.result.subtitle ?? entry.result.title,
  rowClass: { 'entry-row': true },
  data: { type: 'entry', entry },
});

const fileName = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

const parentPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
};

const entryTitle = (entry: PinnedEntry) => {
  if (entry.result.kind === 'content') return `${entry.result.path}:${entry.result.line}`;
  return entry.result.subtitle ?? entry.result.title;
};

const entryAnchor = (entry: PinnedEntry) => {
  if (entry.result.kind === 'content') return `${entry.result.side}:${entry.result.line}`;
  if (entry.result.kind === 'comment') return `${entry.result.thread.anchor.side}:${entry.result.thread.anchor.startLine}`;
  if (entry.result.kind === 'symbol') return `${entry.result.side}:${entry.result.line}`;
  return {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[entry.result.file.status];
};

const entryAnchorClass = (entry: PinnedEntry) => {
  if (entry.result.kind === 'file') return `anchor-${entry.result.file.status}`;
  return `anchor-${entry.result.kind}`;
};

const entryText = (entry: PinnedEntry) => {
  if (entry.result.kind === 'content') return entry.result.preview;
  if (entry.result.kind === 'comment') return entry.result.body;
  if (entry.result.kind === 'symbol') return entry.result.symbolName;
  return entry.result.matches.some((match) => match.field === 'name') ? entry.result.title : (entry.result.subtitle ?? entry.result.title);
};

const entryRanges = (entry: PinnedEntry): SearchMatchRange[] => {
  if (entry.result.kind === 'file') {
    const field = entry.result.matches.some((match) => match.field === 'name') ? 'name' : 'path';
    return entry.result.matches.find((match) => match.field === field)?.ranges ?? [];
  }
  if (entry.result.kind === 'symbol') return entry.result.matches.find((match) => match.field === 'symbol')?.ranges ?? [];
  return entry.result.matches.find((match) => match.field === 'body')?.ranges ?? [];
};

function handleSurfaceMotion(motion: CursorMotion, context: CursorActionContext) {
  if (motion === 'moveDown') {
    nextSelection(context.count);
    return true;
  }
  if (motion === 'moveUp') {
    previousSelection(context.count);
    return true;
  }
  if (motion === 'pageDown') {
    nextSelection(pinnedPageSize() * context.count);
    return true;
  }
  if (motion === 'pageUp') {
    previousSelection(pinnedPageSize() * context.count);
    return true;
  }
  if (motion === 'fileStart') {
    moveSelectionToBoundary('start');
    void revealSelectedPinnedResult('nearest');
    return true;
  }
  if (motion === 'fileEnd') {
    moveSelectionToBoundary('end');
    void revealSelectedPinnedResult('nearest');
    return true;
  }
  return false;
}

function handleSurfaceCommand(command: CursorCommand) {
  if (command === 'activate') {
    openSelected();
    return true;
  }
  if (command === 'clear') {
    search.closeDrawer();
    return true;
  }
  return false;
}

onBeforeUnmount(() => {
  cursor.unregisterSurface(pinnedResultsSurfaceId);
});
</script>

<style scoped lang="scss">
.search-drawer {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: var(--space-4);
  width: 100%;
  height: 100%;
  padding: var(--space-5);
  background: var(--color-bg-panel-raised);
  border-width: 0 0 0 1px;
  border-radius: 0;
  box-shadow: var(--shadow-inset-highlight);
}

.drawer-header,
.drawer-controls,
.drawer-summary {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.drawer-header {
  justify-content: space-between;
}

.drawer-title {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-body-lg);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.drawer-summary {
  justify-content: space-between;
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.drawer-results {
  min-height: 0;
  overflow: auto;
  padding-right: var(--space-2);
}

.pinned-tree {
  min-width: 0;
}

.pinned-tree :deep(.tree-row.group-row) {
  color: var(--color-text-subtle);
}

.pinned-tree :deep(.tree-row.file-group-row) {
  color: var(--color-text-muted);
}

.group-label,
.file-label {
  width: 100%;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:hover {
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.group-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.file-label {
  display: grid;
  gap: 1px;
  font-size: var(--font-size-caption);
  font-weight: 650;
}

.group-label span,
.file-name,
.file-path,
.entry-text {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-name {
  color: var(--color-text-primary);
  font-size: var(--font-size-label);
  font-weight: 750;
}

.file-path {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 500;
}

.entry-button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 22px;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.entry-anchor {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  max-width: 58px;
  height: 18px;
  padding: 0 var(--space-2);
  overflow: hidden;
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.anchor-added {
  color: var(--color-success);
  background: var(--color-success-muted);
  border-color: rgba(91, 184, 119, 0.25);
}

.anchor-modified,
.anchor-renamed {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(143, 179, 255, 0.25);
}

.anchor-deleted {
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border-color: rgba(255, 107, 107, 0.25);
}

.anchor-content {
  color: var(--color-info);
  background: var(--color-info-muted);
  border-color: rgba(77, 166, 255, 0.25);
}

.anchor-comment {
  color: var(--color-review);
  background: var(--color-review-muted);
  border-color: rgba(240, 195, 106, 0.25);
}

.entry-text {
  color: var(--color-text-secondary);
  font-size: var(--font-size-label);
}

.code-excerpt {
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.pinned-tree :deep(.tree-row.entry-row.active) {
  box-shadow: inset 3px 0 0 var(--color-border-focus);
}

.remove-result {
  padding: 0 var(--space-2);
  color: var(--color-text-subtle);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  opacity: 0;
  pointer-events: none;
  transition:
    color var(--transition-fast),
    opacity var(--transition-fast);

  &:hover {
    color: var(--color-danger);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.pinned-tree :deep(.tree-row.entry-row:hover) .remove-result,
.pinned-tree :deep(.tree-row.entry-row:focus-within) .remove-result {
  opacity: 1;
  pointer-events: auto;
}

@media (max-width: 900px) {
  .search-drawer {
    padding: var(--space-4);
  }
}
</style>
