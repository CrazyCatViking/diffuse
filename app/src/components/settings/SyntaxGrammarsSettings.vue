<template>
  <div class="settings-section">
    <SettingsSectionHeader
      title-id="syntaxGrammars-settings-title"
      title="Syntax Grammars"
      description="Install and manage Tree-sitter grammars used for syntax-aware diff rendering."
    >
      <template #actions>
        <Button variant="secondary" :disabled="loading || syncingRegistry || operationInProgress" @click="loadGrammars">
          {{ loading ? 'Refreshing...' : 'Refresh' }}
        </Button>

        <Button :disabled="loading || syncingRegistry || operationInProgress" @click="syncRegistry">
          {{ syncingRegistry ? 'Syncing...' : 'Sync Registry' }}
        </Button>
      </template>
    </SettingsSectionHeader>

    <div v-if="error" class="message error" role="alert">{{ error }}</div>

    <div class="summary-grid" aria-label="Syntax grammar summary">
      <Panel padding="md" class="summary-card">
        <span class="stat-label">Installed</span>

        <span class="stat-value">{{ grammarSummary.installed }}</span>
      </Panel>

      <Panel padding="md" class="summary-card">
        <span class="stat-label">Available</span>

        <span class="stat-value">{{ grammarSummary.available }}</span>
      </Panel>

      <Panel padding="md" class="summary-card">
        <span class="stat-label">Needs Attention</span>

        <span class="stat-value">{{ grammarSummary.attention }}</span>
      </Panel>
    </div>

    <Panel padding="none" class="grammar-catalog">
      <header class="panel-header">
        <div>
          <h3>Grammar Catalog</h3>

          <p>{{ filteredGrammars.length }} matching {{ filteredGrammars.length === 1 ? 'grammar' : 'grammars' }}</p>
        </div>

        <Badge tone="neutral">{{ grammars.length }} total</Badge>
      </header>

      <div class="catalog-controls">
        <SearchInput v-model="search" compact placeholder="Search languages..." label="Search syntax grammars" />

        <div class="filter-buttons" role="group" aria-label="Grammar filters">
          <Button
            v-for="filter in grammarFilters"
            :key="filter.value"
            variant="secondary"
            size="sm"
            :pressed="grammarFilter === filter.value"
            :aria-pressed="grammarFilter === filter.value"
            @click="grammarFilter = filter.value"
          >
            {{ filter.label }}
          </Button>
        </div>
      </div>

      <EmptyState
        v-if="loading && grammars.length === 0"
        class="panel-empty"
        align="start"
        bordered
        title="Loading grammars"
        description="Diffuse is reading installed parsers and the grammar registry."
      />

      <EmptyState
        v-else-if="filteredGrammars.length === 0"
        class="panel-empty"
        align="start"
        bordered
        title="No matching grammars"
        description="Try another language name, dependency, or filter."
      />

      <div v-else class="grammar-list">
        <article v-for="grammar in filteredGrammars" :key="grammar.id" class="grammar-row" :class="grammarRowClass(grammar)">
          <div class="grammar-meta">
            <div class="grammar-title">
              <span class="grammar-name">{{ grammar.id }}</span>

              <Badge :tone="grammar.installed ? 'success' : 'info'">{{ grammar.installed ? 'Installed' : 'Available' }}</Badge>

              <Badge v-if="grammar.installed && !grammar.highlightsInstalled" tone="warning">No highlights</Badge>
            </div>

            <div class="grammar-details">
              <span v-if="grammar.requires.length > 0">Requires {{ grammar.requires.join(', ') }}</span>

              <span v-if="grammar.revision">Revision {{ grammar.revision }}</span>

              <span v-if="grammar.installed && grammar.grammarPath" :title="grammar.grammarPath">{{ grammar.grammarPath }}</span>

              <span v-if="grammar.url" :title="grammar.url">{{ grammar.url }}</span>
            </div>

            <div v-if="installingLanguage === grammar.id && installStep" class="install-step">{{ installStep }}</div>
          </div>

          <Button v-if="grammar.installed" variant="danger" size="sm" :disabled="operationInProgress" @click="uninstallGrammar(grammar.id)">
            {{ uninstallButtonText(grammar.id) }}
          </Button>

          <Button v-else size="sm" :disabled="operationInProgress" @click="installGrammar(grammar.id)">
            {{ installButtonText(grammar.id) }}
          </Button>
        </article>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TreeSitterGrammar } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import Button from '../Button.vue';
import SearchInput from '../search/SearchInput.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import SettingsSectionHeader from './SettingsSectionHeader.vue';

type GrammarFilter = 'all' | 'installed' | 'available' | 'attention';

const client = useClient();
const grammars = ref<TreeSitterGrammar[]>([]);
const loading = ref(false);
const error = ref<string>();
const search = ref('');
const grammarFilter = ref<GrammarFilter>('all');
const installingLanguage = ref<string>();
const uninstallingLanguage = ref<string>();
const installStep = ref<string>();
const syncingRegistry = ref(false);
let removeCoreEventListener: (() => void) | undefined;

const grammarFilters: { value: GrammarFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'available', label: 'Available' },
  { value: 'attention', label: 'Attention' },
];

const operationInProgress = computed(() => installingLanguage.value !== undefined || uninstallingLanguage.value !== undefined);
const grammarSummary = computed(() => ({
  installed: grammars.value.filter((grammar) => grammar.installed).length,
  available: grammars.value.filter((grammar) => !grammar.installed).length,
  attention: grammars.value.filter((grammar) => grammar.installed && !grammar.highlightsInstalled).length,
}));
const filteredGrammars = computed(() => {
  const query = search.value.trim().toLowerCase();
  return grammars.value
    .filter((grammar) => grammarMatchesFilter(grammar))
    .filter((grammar) => {
      if (!query) return true;
      return grammar.id.toLowerCase().includes(query) || grammar.requires.some((dependency) => dependency.toLowerCase().includes(query));
    })
    .sort((first, second) => Number(second.installed) - Number(first.installed) || first.id.localeCompare(second.id));
});

const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
  return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
};

const grammarMatchesFilter = (grammar: TreeSitterGrammar) => {
  if (grammarFilter.value === 'installed') return grammar.installed;
  if (grammarFilter.value === 'available') return !grammar.installed;
  if (grammarFilter.value === 'attention') return grammar.installed && !grammar.highlightsInstalled;
  return true;
};

const loadGrammars = async () => {
  loading.value = true;
  error.value = undefined;
  try {
    grammars.value = await client.listTreeSitterGrammars();
  } catch (err) {
    error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    loading.value = false;
  }
};

const installGrammar = async (language: string) => {
  if (operationInProgress.value) return;

  installingLanguage.value = language;
  installStep.value = 'Starting install';
  error.value = undefined;

  try {
    const result = await client.installTreeSitterGrammar(language);
    if (!result.installed) throw new Error(result.message ?? `Failed to install ${language} grammar`);
    await loadGrammars();
  } catch (err) {
    error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    installingLanguage.value = undefined;
    installStep.value = undefined;
  }
};

const uninstallGrammar = async (language: string) => {
  if (operationInProgress.value) return;

  uninstallingLanguage.value = language;
  error.value = undefined;

  try {
    const result = await client.uninstallTreeSitterGrammar(language);
    if (!result.uninstalled) throw new Error(result.message ?? `Failed to uninstall ${language} grammar`);
    await loadGrammars();
  } catch (err) {
    error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    uninstallingLanguage.value = undefined;
  }
};

const syncRegistry = async () => {
  if (syncingRegistry.value) return;

  syncingRegistry.value = true;
  error.value = undefined;

  try {
    const result = await client.syncTreeSitterRegistry();
    if (!result.synced) throw new Error(result.message ?? 'Failed to sync tree-sitter registry');
    await loadGrammars();
  } catch (err) {
    error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    syncingRegistry.value = false;
  }
};

const installButtonText = (language: string) => {
  if (installingLanguage.value === language) return 'Installing...';
  return 'Install';
};

const uninstallButtonText = (language: string) => {
  if (uninstallingLanguage.value === language) return 'Uninstalling...';
  return 'Uninstall';
};

const grammarRowClass = (grammar: TreeSitterGrammar) => ({
  installed: grammar.installed,
  warning: grammar.installed && !grammar.highlightsInstalled,
});

onMounted(() => {
  removeCoreEventListener = window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'treeSitter/installProgress') return;
    if (!event.params || typeof event.params !== 'object') return;

    const params = event.params as { language?: unknown; step?: unknown };
    if (params.language !== installingLanguage.value) return;
    if (typeof params.step === 'string') installStep.value = params.step;
  });

  void loadGrammars();
});

onBeforeUnmount(() => {
  removeCoreEventListener?.();
});
</script>

<style scoped lang="scss">
.settings-section,
.grammar-list {
  display: grid;
  gap: var(--space-7);
  min-width: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-6);
}

.summary-card {
  display: grid;
  gap: var(--space-3);
}

.stat-label {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stat-value {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-lg);
  font-weight: 800;
  line-height: 1;
}

.grammar-catalog {
  overflow: hidden;
}

.panel-header {
  display: flex;
  gap: var(--space-6);
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-7);
  border-bottom: 1px solid var(--color-border-subtle);
}

h3,
p {
  margin: 0;
}

h3 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

p {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.catalog-controls {
  display: grid;
  grid-template-columns: minmax(220px, 360px) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: center;
  padding: var(--space-7);
}

.filter-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.grammar-list {
  gap: var(--space-4);
  padding: 0 var(--space-7) var(--space-7);
}

.grammar-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-6);
  align-items: center;
  min-width: 0;
  padding: var(--space-6);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);

  &.installed {
    background: linear-gradient(90deg, var(--color-success-muted), var(--color-bg-panel-raised) 160px);
  }

  &.warning {
    background: linear-gradient(90deg, var(--color-warning-muted), var(--color-bg-panel-raised) 160px);
  }
}

.grammar-meta {
  min-width: 0;
}

.grammar-title {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
}

.grammar-name {
  color: var(--color-text-primary);
  font-weight: 800;
}

.grammar-details {
  display: flex;
  gap: var(--space-6);
  min-width: 0;
  margin-top: var(--space-3);
  overflow: hidden;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message {
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-muted);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  font-size: var(--font-size-body);

  &.error {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }
}

.panel-empty {
  margin: var(--space-7);
}

.install-step {
  margin-top: var(--space-4);
  color: var(--color-success);
  font-size: var(--font-size-label);
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .catalog-controls {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .summary-grid,
  .grammar-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel-header {
    display: grid;
  }
}
</style>
