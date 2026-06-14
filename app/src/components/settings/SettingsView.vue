<template>
  <main class="settings-view">
    <header class="settings-header">
      <div>
        <div class="eyebrow">Settings</div>
        <h1>Tree-sitter Grammars</h1>
        <p>Manage syntax grammars used for highlighting diffs.</p>
      </div>

      <Button @click="$emit('close')">Back to Diff</Button>
    </header>

    <section class="settings-panel">
      <div class="panel-header">
        <div>
          <h2>Installed</h2>
          <p>{{ installedGrammars.length }} installed grammar{{ installedGrammars.length === 1 ? '' : 's' }}</p>
        </div>
        <Button :disabled="loading" @click="loadGrammars">{{ loading ? 'Refreshing...' : 'Refresh' }}</Button>
      </div>

      <div v-if="error" class="message error">{{ error }}</div>
      <div v-else-if="loading && grammars.length === 0" class="message">Loading grammars...</div>
      <div v-else-if="installedGrammars.length === 0" class="message">No grammars installed yet.</div>
      <div v-else class="installed-list">
        <div v-for="grammar in installedGrammars" :key="grammar.id" class="installed-card">
          <span class="grammar-name">{{ grammar.id }}</span>
          <span class="grammar-path" :title="grammar.grammarPath">{{ grammar.grammarPath }}</span>
          <Button :disabled="operationInProgress" @click="uninstallGrammar(grammar.id)">
            {{ uninstallButtonText(grammar.id) }}
          </Button>
        </div>
      </div>
    </section>

    <section class="settings-panel grammar-browser">
      <div class="panel-header">
        <div>
          <h2>Available Grammars</h2>
          <p>{{ filteredGrammars.length }} matching grammar{{ filteredGrammars.length === 1 ? '' : 's' }}</p>
        </div>

        <label class="search-label">
          <span>Search</span>
          <input v-model="search" type="search" placeholder="Search languages..." />
        </label>
      </div>

      <div class="grammar-list">
        <article v-for="grammar in filteredGrammars" :key="grammar.id" class="grammar-row">
          <div class="grammar-meta">
            <div class="grammar-title">
              <span class="grammar-name">{{ grammar.id }}</span>
              <span v-if="grammar.installed" class="badge installed">Installed</span>
              <span v-else class="badge">Available</span>
            </div>
            <div class="grammar-details">
              <span v-if="grammar.requires.length > 0">Requires {{ grammar.requires.join(', ') }}</span>
              <span v-if="grammar.revision">Revision {{ grammar.revision }}</span>
              <span v-if="grammar.url" :title="grammar.url">{{ grammar.url }}</span>
            </div>
            <div v-if="installingLanguage === grammar.id && installStep" class="install-step">{{ installStep }}</div>
          </div>

          <Button v-if="grammar.installed" :disabled="operationInProgress" @click="uninstallGrammar(grammar.id)">
            {{ uninstallButtonText(grammar.id) }}
          </Button>
          <Button v-else :disabled="operationInProgress" @click="installGrammar(grammar.id)">
            {{ installButtonText(grammar.id) }}
          </Button>
        </article>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TreeSitterGrammar } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import Button from '../Button.vue';

defineEmits<{
  close: [];
}>();

const client = useClient();
const grammars = ref<TreeSitterGrammar[]>([]);
const loading = ref(false);
const error = ref<string>();
const search = ref('');
const installingLanguage = ref<string>();
const uninstallingLanguage = ref<string>();
const installStep = ref<string>();
let removeCoreEventListener: (() => void) | undefined;

const operationInProgress = computed(() => installingLanguage.value !== undefined || uninstallingLanguage.value !== undefined);
const installedGrammars = computed(() => grammars.value.filter((grammar) => grammar.installed));
const filteredGrammars = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return grammars.value;

  return grammars.value.filter((grammar) => {
    return grammar.id.toLowerCase().includes(query) || grammar.requires.some((dependency) => dependency.toLowerCase().includes(query));
  });
});

const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
  return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
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

const installButtonText = (language: string) => {
  if (installingLanguage.value === language) return 'Installing...';
  return 'Install';
};

const uninstallButtonText = (language: string) => {
  if (uninstallingLanguage.value === language) return 'Uninstalling...';
  return 'Uninstall';
};

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
.settings-view {
  min-height: 0;
  padding: 28px;
  overflow: auto;
  background: #111318;
}

.settings-header {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 22px;
}

.eyebrow {
  margin-bottom: 8px;
  color: #7e8aa0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  color: #f5f7fb;
  font-size: 26px;
}

h2 {
  color: #f5f7fb;
  font-size: 16px;
}

p {
  margin-top: 6px;
  color: #98a2b3;
  font-size: 13px;
}

.settings-panel {
  margin-bottom: 18px;
  padding: 18px;
  border: 1px solid #252a35;
  border-radius: 16px;
  background: #151821;
}

.panel-header {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 14px;
}

.installed-list,
.grammar-list {
  display: grid;
  gap: 8px;
}

.installed-card,
.grammar-row {
  display: grid;
  gap: 12px;
  align-items: center;
  padding: 13px 14px;
  border: 1px solid #2a3140;
  border-radius: 12px;
  background: #1b202b;
}

.installed-card {
  grid-template-columns: 160px minmax(0, 1fr) auto;
}

.grammar-row {
  grid-template-columns: minmax(0, 1fr) auto;
}

.grammar-meta {
  min-width: 0;
}

.grammar-title {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.grammar-name {
  color: #f5f7fb;
  font-weight: 700;
}

.grammar-path,
.grammar-details {
  min-width: 0;
  overflow: hidden;
  color: #7e8aa0;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grammar-details {
  display: flex;
  gap: 12px;
  margin-top: 5px;
}

.badge {
  color: #9fb4ff;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;

  &.installed {
    color: #8bd5a3;
  }
}

.search-label {
  display: grid;
  gap: 6px;
  width: min(280px, 100%);
  color: #7e8aa0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

input {
  width: 100%;
  padding: 9px 11px;
  color: #f5f7fb;
  background: #111318;
  border: 1px solid #2a3140;
  border-radius: 10px;
  outline: none;

  &:focus {
    border-color: #4b7bec;
  }
}

.message {
  color: #7e8aa0;
  font-size: 13px;

  &.error {
    color: #ff8d8d;
  }
}

.install-step {
  margin-top: 8px;
  color: #8bd5a3;
  font-size: 12px;
}

@media (max-width: 760px) {
  .settings-view {
    padding: 16px;
  }

  .settings-header,
  .panel-header,
  .grammar-row,
  .installed-card {
    display: grid;
  }
}
</style>
