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
          <h2>Syntax Theme</h2>

          <p>Choose a built-in syntax theme or define your own colors.</p>
        </div>
      </div>

      <div class="theme-grid">
        <button
          v-for="theme in themeOptions"
          :key="theme.id"
          class="theme-card"
          :class="{ active: settings.selectedSyntaxThemeId === theme.id }"
          type="button"
          @click="settings.setSyntaxTheme(theme.id)"
        >
          <span class="theme-name">{{ theme.name }}</span>

          <span class="theme-swatches">
            <span v-for="color in swatchColors(theme.colors)" :key="color" class="swatch" :style="{ background: color }" />
          </span>
        </button>
      </div>

      <div v-if="settings.selectedSyntaxThemeId === 'custom'" class="custom-theme">
        <label v-for="field in customColorFields" :key="field.key" class="color-field">
          <span>{{ field.label }}</span>

          <span class="color-controls">
            <input
              class="color-swatch-input"
              type="color"
              :value="settings.customSyntaxTheme[field.key]"
              @input="setCustomSyntaxColor(field.key, $event)"
            />

            <input
              class="hex-input"
              type="text"
              :value="settings.customSyntaxTheme[field.key]"
              spellcheck="false"
              @input="previewCustomSyntaxHexColor(field.key, $event)"
              @change="setCustomSyntaxHexColor(field.key, $event)"
              @blur="setCustomSyntaxHexColor(field.key, $event)"
              @keyup.enter="setCustomSyntaxHexColor(field.key, $event)"
            />
          </span>
        </label>
      </div>

      <div class="theme-preview" aria-label="Syntax theme preview">
        <div class="preview-title">Preview</div>

        <HighlightedCode v-for="line in previewLines" :key="line.text" :text="line.text" :spans="line.spans" />
      </div>
    </section>

    <section class="settings-panel">
      <div class="panel-header">
        <div>
          <h2>Diff Viewer Keybindings</h2>

          <p>Customize single-file diff navigation. Use comma-separated bindings such as <code>h, &lt;Left&gt;</code>.</p>
        </div>

        <div class="panel-actions">
          <Button :disabled="!keybindingDraftsChanged || !keybindingValidation.valid" @click="applyKeybindings">Apply</Button>

          <Button variant="secondary" @click="resetKeybindingDrafts">Reset to Defaults</Button>
        </div>
      </div>

      <div v-if="keybindingSaved" class="message success">Keybindings saved.</div>

      <div class="keybinding-groups">
        <section v-for="group in keybindingGroups" :key="group.name" class="keybinding-group">
          <h3>{{ group.name }}</h3>

          <label v-for="action in group.actions" :key="action.id" class="keybinding-row">
            <span class="keybinding-meta">
              <span class="keybinding-label">{{ action.label }}</span>

              <span class="keybinding-description">{{ action.description }}</span>
            </span>

            <span class="keybinding-editor">
              <input
                class="keybinding-input"
                type="text"
                :value="keybindingDrafts[action.id]"
                spellcheck="false"
                :aria-label="`${action.label} keybindings`"
                @input="updateKeybindingDraft(action.id, $event)"
              />

              <span v-if="keybindingValidation.errors[action.id]" class="keybinding-error">
                {{ keybindingValidation.errors[action.id] }}
              </span>
            </span>
          </label>
        </section>
      </div>
    </section>

    <section class="settings-panel">
      <div class="panel-header">
        <div>
          <h2>Language Servers</h2>

          <p>Configure LSP servers used for hover information and diagnostics in diffs.</p>
        </div>

        <div class="panel-actions">
          <Button :disabled="!lspConfigInfo?.configPath" @click="openLspConfig">Open Config</Button>

          <Button :disabled="lspLoading" @click="loadLspConfigInfo">{{ lspLoading ? 'Refreshing...' : 'Refresh' }}</Button>
        </div>
      </div>

      <div v-if="lspError" class="message error">{{ lspError }}</div>

      <div v-else-if="lspLoading && !lspConfigInfo" class="message">Loading language servers...</div>

      <template v-else-if="lspConfigInfo">
        <div class="config-path-row">
          <span>Config file</span>

          <code>{{ lspConfigInfo.configPath ?? 'No home directory available' }}</code>
        </div>

        <div class="lsp-list">
          <article
            v-for="server in lspConfigInfo.servers"
            :key="server.language"
            class="lsp-row"
            :class="{ missing: !server.installed, running: server.running, errored: Boolean(server.lastError) }"
          >
            <div class="lsp-meta">
              <div class="lsp-title">
                <span class="grammar-name">{{ server.language }}</span>

                <span class="badge" :class="server.installed ? 'installed' : 'warning'">{{ server.installed ? 'Ready' : 'Missing' }}</span>

                <span class="badge" :class="lspSessionBadgeClass(server)">{{ lspSessionLabel(server) }}</span>

                <span class="badge">{{ server.configSource }}</span>
              </div>

              <div class="grammar-details">
                <span>{{ server.serverId }}</span>

                <span :title="lspCommand(server)">{{ lspCommand(server) }}</span>
              </div>

              <div v-if="server.lastError" class="lsp-error" :title="server.lastError">Last error: {{ server.lastError }}</div>

              <div v-if="server.running || server.lastError" class="lsp-session-actions">
                <Button type="button" :disabled="restartingLspServer === server.serverId" @click="restartLspServer(server)">
                  {{ restartingLspServer === server.serverId ? 'Restarting...' : 'Restart Server' }}
                </Button>
              </div>

              <div v-if="!server.installed && server.install" class="lsp-install-guide">
                <div class="install-summary">{{ server.install.description }}</div>

                <div class="install-command">
                  <code>{{ lspInstallCommand(server) }}</code>

                  <Button type="button" @click="copyLspInstallCommand(server)">{{
                    copiedLspLanguage === server.language ? 'Copied' : 'Copy'
                  }}</Button>

                  <Button
                    v-if="server.install.safeToRun"
                    type="button"
                    :disabled="installingLspServer === server.serverId"
                    @click="installLspServer(server)"
                  >
                    {{ installingLspServer === server.serverId ? 'Installing...' : 'Install' }}
                  </Button>
                </div>

                <div v-if="server.install.note" class="install-note">{{ server.install.note }}</div>

                <div v-if="installingLspServer === server.serverId && lspInstallStep" class="install-step">{{ lspInstallStep }}</div>
              </div>
            </div>
          </article>
        </div>
      </template>
    </section>

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
        <div
          v-for="grammar in installedGrammars"
          :key="grammar.id"
          class="installed-card"
          :class="{ warning: !grammar.highlightsInstalled }"
        >
          <span class="grammar-name">{{ grammar.id }}</span>
          <span v-if="!grammar.highlightsInstalled" class="badge warning">Highlights missing</span>
          <span class="grammar-path" :title="grammar.grammarPath">{{ grammar.grammarPath }}</span>
          <Button variant="secondary" :disabled="operationInProgress" @click="uninstallGrammar(grammar.id)">
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

        <Button :disabled="loading || syncingRegistry || operationInProgress" @click="syncRegistry">
          {{ syncingRegistry ? 'Syncing...' : 'Sync Registry' }}
        </Button>

        <label class="search-label">
          <span>Search</span>
          <input v-model="search" type="search" placeholder="Search languages..." />
        </label>
      </div>

      <div class="grammar-list">
        <article v-for="grammar in filteredGrammars" :key="grammar.id" class="grammar-row" :class="{ installed: grammar.installed }">
          <div class="grammar-meta">
            <div class="grammar-title">
              <span class="grammar-name">{{ grammar.id }}</span>
              <span v-if="grammar.installed" class="badge installed">Installed</span>
              <span v-else class="badge">Available</span>
              <span v-if="grammar.installed && !grammar.highlightsInstalled" class="badge warning">No highlights</span>
            </div>
            <div class="grammar-details">
              <span v-if="grammar.requires.length > 0">Requires {{ grammar.requires.join(', ') }}</span>
              <span v-if="grammar.revision">Revision {{ grammar.revision }}</span>
              <span v-if="grammar.url" :title="grammar.url">{{ grammar.url }}</span>
            </div>
            <div v-if="installingLanguage === grammar.id && installStep" class="install-step">{{ installStep }}</div>
          </div>

          <Button v-if="grammar.installed" variant="secondary" :disabled="operationInProgress" @click="uninstallGrammar(grammar.id)">
            {{ uninstallButtonText(grammar.id) }}
          </Button>
          <Button v-else variant="review" :disabled="operationInProgress" @click="installGrammar(grammar.id)">
            {{ installButtonText(grammar.id) }}
          </Button>
        </article>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  cloneDefaultDiffKeybindings,
  diffKeybindingActionIds,
  diffKeybindingDefinitions,
  normalizeDiffKeybindingList,
  validateDiffKeybindingMap,
  type DiffKeybindingAction,
  type DiffKeybindingDefinition,
  type DiffKeybindingMap,
} from '../../lib/diffKeybindings';
import type { LspConfigInfo, LspServerInfo, TreeSitterGrammar } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import { builtInSyntaxThemes, useSettingsStore, type SyntaxThemeColors } from '../../stores/settings';
import Button from '../Button.vue';
import HighlightedCode from '../diff/HighlightedCode.vue';

defineEmits<{
  close: [];
}>();

const client = useClient();
const settings = useSettingsStore();
const grammars = ref<TreeSitterGrammar[]>([]);
const lspConfigInfo = ref<LspConfigInfo>();
const loading = ref(false);
const lspLoading = ref(false);
const error = ref<string>();
const lspError = ref<string>();
const search = ref('');
const installingLanguage = ref<string>();
const uninstallingLanguage = ref<string>();
const installingLspServer = ref<string>();
const restartingLspServer = ref<string>();
const copiedLspLanguage = ref<string>();
const installStep = ref<string>();
const lspInstallStep = ref<string>();
const syncingRegistry = ref(false);
const keybindingDrafts = ref<Record<DiffKeybindingAction, string>>(keybindingDraftsFromMap(settings.diffKeybindings));
const keybindingSaved = ref(false);
let removeCoreEventListener: (() => void) | undefined;
let copiedLspTimer: number | undefined;
let keybindingSavedTimer: number | undefined;

const themeOptions = computed(() => [
  ...builtInSyntaxThemes,
  { id: 'custom' as const, name: 'Custom', colors: settings.customSyntaxTheme },
]);

const customColorFields: { key: keyof SyntaxThemeColors; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'comment', label: 'Comment' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'string', label: 'String' },
  { key: 'number', label: 'Number' },
  { key: 'function', label: 'Function' },
  { key: 'type', label: 'Type' },
  { key: 'property', label: 'Property' },
  { key: 'punctuation', label: 'Punctuation' },
];
const previewLines = [
  {
    text: 'function formatUser(user: User) {',
    spans: [
      { startColumn: 0, endColumn: 8, scope: 'keyword.function' },
      { startColumn: 9, endColumn: 19, scope: 'function' },
      { startColumn: 20, endColumn: 24, scope: 'variable.parameter' },
      { startColumn: 26, endColumn: 30, scope: 'type' },
      { startColumn: 31, endColumn: 32, scope: 'punctuation.bracket' },
    ],
  },
  {
    text: '  const active = user.enabled && user.score > 10;',
    spans: [
      { startColumn: 2, endColumn: 7, scope: 'keyword' },
      { startColumn: 8, endColumn: 14, scope: 'variable' },
      { startColumn: 17, endColumn: 21, scope: 'variable.parameter' },
      { startColumn: 22, endColumn: 29, scope: 'property' },
      { startColumn: 30, endColumn: 32, scope: 'operator' },
      { startColumn: 33, endColumn: 37, scope: 'variable.parameter' },
      { startColumn: 38, endColumn: 43, scope: 'property' },
      { startColumn: 46, endColumn: 48, scope: 'number' },
    ],
  },
  {
    text: '  return `${user.name}: ${active}`; // visible in review',
    spans: [
      { startColumn: 2, endColumn: 8, scope: 'keyword' },
      { startColumn: 9, endColumn: 34, scope: 'string' },
      { startColumn: 37, endColumn: 57, scope: 'comment' },
    ],
  },
  {
    text: '}',
    spans: [{ startColumn: 0, endColumn: 1, scope: 'punctuation.bracket' }],
  },
];

const operationInProgress = computed(() => installingLanguage.value !== undefined || uninstallingLanguage.value !== undefined);
const installedGrammars = computed(() => grammars.value.filter((grammar) => grammar.installed));
const filteredGrammars = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return grammars.value;

  return grammars.value.filter((grammar) => {
    return grammar.id.toLowerCase().includes(query) || grammar.requires.some((dependency) => dependency.toLowerCase().includes(query));
  });
});
const keybindingGroups = computed(() => {
  const groups: { name: DiffKeybindingDefinition['group']; actions: DiffKeybindingDefinition[] }[] = [];
  for (const definition of diffKeybindingDefinitions) {
    const group = groups.find((item) => item.name === definition.group);
    if (group) group.actions.push(definition);
    else groups.push({ name: definition.group, actions: [definition] });
  }
  return groups;
});
const keybindingDraftMap = computed<DiffKeybindingMap>(() => {
  return Object.fromEntries(
    diffKeybindingActionIds.map((action) => [action, normalizeDiffKeybindingList(keybindingDrafts.value[action] ?? '')]),
  ) as DiffKeybindingMap;
});
const keybindingValidation = computed(() => validateDiffKeybindingMap(keybindingDraftMap.value));
const keybindingDraftsChanged = computed(() => JSON.stringify(keybindingDraftMap.value) !== JSON.stringify(settings.diffKeybindings));
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

const loadLspConfigInfo = async () => {
  lspLoading.value = true;
  lspError.value = undefined;
  try {
    lspConfigInfo.value = await client.getLspConfigInfo();
  } catch (err) {
    lspError.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    lspLoading.value = false;
  }
};

const openLspConfig = async () => {
  const configPath = lspConfigInfo.value?.configPath;
  if (!configPath) return;
  lspError.value = undefined;
  try {
    await window.diffuse.openLspConfig(configPath);
    await loadLspConfigInfo();
  } catch (err) {
    lspError.value = err instanceof Error ? err.message : JSON.stringify(err);
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

const swatchColors = (colors: SyntaxThemeColors) => {
  return [colors.keyword, colors.string, colors.function, colors.type, colors.comment];
};

const lspCommand = (server: LspServerInfo) => {
  return [server.command, ...server.args].join(' ');
};

const lspInstallCommand = (server: LspServerInfo) => {
  if (!server.install) return '';
  return [server.install.command, ...server.install.args].join(' ');
};

const copyLspInstallCommand = async (server: LspServerInfo) => {
  const command = lspInstallCommand(server);
  if (!command) return;
  lspError.value = undefined;
  try {
    await navigator.clipboard.writeText(command);
    copiedLspLanguage.value = server.language;
    if (copiedLspTimer !== undefined) window.clearTimeout(copiedLspTimer);
    copiedLspTimer = window.setTimeout(() => {
      copiedLspLanguage.value = undefined;
      copiedLspTimer = undefined;
    }, 1400);
  } catch (err) {
    lspError.value = err instanceof Error ? err.message : JSON.stringify(err);
  }
};

const installLspServer = async (server: LspServerInfo) => {
  if (!server.install?.safeToRun || installingLspServer.value) return;
  installingLspServer.value = server.serverId;
  lspInstallStep.value = 'Starting install';
  lspError.value = undefined;

  try {
    const result = await client.installLspServer(server.serverId, server.command);
    if (!result.installed) throw new Error(result.message ?? `Failed to install ${server.serverId}`);
    await loadLspConfigInfo();
  } catch (err) {
    lspError.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    installingLspServer.value = undefined;
    lspInstallStep.value = undefined;
  }
};

const restartLspServer = async (server: LspServerInfo) => {
  if (restartingLspServer.value) return;
  restartingLspServer.value = server.serverId;
  lspError.value = undefined;
  try {
    await client.restartLspServer(server.serverId);
    await loadLspConfigInfo();
  } catch (err) {
    lspError.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    restartingLspServer.value = undefined;
  }
};

const lspSessionLabel = (server: LspServerInfo) => {
  if (server.lastError) return 'Error';
  if (server.starting) return 'Starting';
  if (server.running) return 'Running';
  return 'Not started';
};

const lspSessionBadgeClass = (server: LspServerInfo) => {
  if (server.lastError) return 'warning';
  if (server.running) return 'installed';
  return '';
};

const setCustomSyntaxColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  settings.setCustomSyntaxColor(key, input.value);
};

const setCustomSyntaxHexColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  const color = normalizeHexColor(input.value);
  if (!color) {
    input.value = settings.customSyntaxTheme[key];
    return;
  }

  settings.setCustomSyntaxColor(key, color);
  input.value = color;
};

const previewCustomSyntaxHexColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  const color = normalizeHexColor(input.value);
  if (color) settings.setCustomSyntaxColor(key, color);
};

const updateKeybindingDraft = (action: DiffKeybindingAction, event: Event) => {
  const input = event.target as HTMLInputElement;
  keybindingDrafts.value = { ...keybindingDrafts.value, [action]: input.value };
  keybindingSaved.value = false;
};

const applyKeybindings = () => {
  const validation = settings.setDiffKeybindings(keybindingDraftMap.value);
  if (!validation.valid) return;

  keybindingDrafts.value = keybindingDraftsFromMap(settings.diffKeybindings);
  showKeybindingSaved();
};

const resetKeybindingDrafts = () => {
  settings.setDiffKeybindings(cloneDefaultDiffKeybindings());
  keybindingDrafts.value = keybindingDraftsFromMap(settings.diffKeybindings);
  showKeybindingSaved();
};

function keybindingDraftsFromMap(keybindings: DiffKeybindingMap): Record<DiffKeybindingAction, string> {
  return Object.fromEntries(diffKeybindingActionIds.map((action) => [action, keybindings[action].join(', ')])) as Record<
    DiffKeybindingAction,
    string
  >;
}

const showKeybindingSaved = () => {
  keybindingSaved.value = true;
  if (keybindingSavedTimer !== undefined) window.clearTimeout(keybindingSavedTimer);
  keybindingSavedTimer = window.setTimeout(() => {
    keybindingSaved.value = false;
    keybindingSavedTimer = undefined;
  }, 1400);
};

const normalizeHexColor = (value: string) => {
  const trimmed = value.trim();
  const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (!/^#[0-9a-fA-F]{3}$/.test(hex)) return undefined;

  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
};

onMounted(() => {
  removeCoreEventListener = window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event)) return;
    if (!event.params || typeof event.params !== 'object') return;

    if (event.method === 'treeSitter/installProgress') {
      const params = event.params as { language?: unknown; step?: unknown };
      if (params.language !== installingLanguage.value) return;
      if (typeof params.step === 'string') installStep.value = params.step;
      return;
    }

    if (event.method === 'lsp/installProgress') {
      const params = event.params as { serverId?: unknown; step?: unknown };
      if (params.serverId !== installingLspServer.value) return;
      if (typeof params.step === 'string') lspInstallStep.value = params.step;
    }
  });

  void loadGrammars();
  void loadLspConfigInfo();
});

onBeforeUnmount(() => {
  removeCoreEventListener?.();
  if (copiedLspTimer !== undefined) window.clearTimeout(copiedLspTimer);
  if (keybindingSavedTimer !== undefined) window.clearTimeout(keybindingSavedTimer);
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
h3,
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

h3 {
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
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

.panel-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.installed-list,
.lsp-list,
.grammar-list,
.theme-grid,
.custom-theme,
.keybinding-groups,
.keybinding-group {
  display: grid;
  gap: 8px;
}

.keybinding-groups {
  gap: var(--space-7);
}

.keybinding-group {
  padding: var(--space-5);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-4);
}

.keybinding-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 320px);
  gap: var(--space-6);
  align-items: start;
  padding: var(--space-4) 0;
  border-top: 1px solid var(--color-border-hairline);
}

.keybinding-meta,
.keybinding-editor {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.keybinding-label {
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  font-weight: 650;
}

.keybinding-description {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.keybinding-input {
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
}

.keybinding-error {
  color: var(--color-danger);
  font-size: var(--font-size-label);
}

.theme-grid {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.theme-card {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 12px;
  color: #f5f7fb;
  background: #1b202b;
  border: 1px solid #2a3140;
  border-radius: 12px;
  cursor: pointer;

  &.active {
    border-color: #4b7bec;
    box-shadow: inset 0 0 0 1px #4b7bec;
  }

  &:focus-visible {
    border-color: var(--color-border-focus);
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.theme-name {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-swatches {
  display: flex;
  flex-shrink: 0;
}

.swatch {
  width: 16px;
  height: 16px;
  margin-left: -3px;
  border: 1px solid #111318;
  border-radius: 999px;
}

.custom-theme {
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  margin-top: 14px;
}

.theme-preview {
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid #2a3140;
  border-radius: 12px;
  background: #111318;
}

.preview-title {
  padding: 8px 12px;
  color: #7e8aa0;
  background: #1b202b;
  border-bottom: 1px solid #2a3140;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.theme-preview :deep(.code) {
  height: 24px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
}

.color-field {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  color: #cbd5e1;
  background: #1b202b;
  border: 1px solid #2a3140;
  border-radius: 12px;
  font-size: 13px;
}

.color-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.color-swatch-input {
  width: 24px;
  height: 24px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.color-swatch-input::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-swatch-input::-webkit-color-swatch {
  border: 1px solid #111318;
  border-radius: 999px;
}

.hex-input {
  width: 86px;
  padding: 6px 8px;
  color: #f5f7fb;
  background: #111318;
  border: 1px solid #2a3140;
  border-radius: 8px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  text-transform: lowercase;
}

.installed-card,
.lsp-row,
.grammar-row {
  display: grid;
  gap: 12px;
  align-items: center;
  padding: 13px 14px;
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  background: var(--color-bg-panel-raised);
  box-shadow: var(--shadow-inset-highlight);
}

.installed-card.warning,
.lsp-row.missing {
  background: linear-gradient(90deg, var(--color-warning-muted), var(--color-bg-panel-raised) 140px);
  border-color: rgba(240, 184, 106, 0.22);
}

.lsp-row.running,
.grammar-row.installed {
  background: linear-gradient(90deg, var(--color-success-muted), var(--color-bg-panel-raised) 140px);
  border-color: rgba(91, 184, 119, 0.2);
}

.lsp-row.errored {
  background: linear-gradient(90deg, var(--color-danger-muted), var(--color-bg-panel-raised) 140px);
  border-color: rgba(255, 107, 107, 0.24);
}

.installed-card {
  grid-template-columns: 160px minmax(0, 1fr) auto;
}

.grammar-row {
  grid-template-columns: minmax(0, 1fr) auto;
}

.lsp-row {
  grid-template-columns: minmax(0, 1fr);
}

.lsp-meta,
.grammar-meta {
  min-width: 0;
}

.lsp-title,
.grammar-title {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.config-path-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
  padding: 10px 12px;
  color: #98a2b3;
  background: #111722;
  border: 1px solid #252d3d;
  border-radius: 10px;
  font-size: 12px;

  code {
    min-width: 0;
    overflow: hidden;
    color: #d7deea;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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

.lsp-error {
  margin-top: 6px;
  overflow: hidden;
  color: #ff8d8d;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lsp-session-actions {
  margin-top: 10px;
}

.lsp-install-guide {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  background: var(--color-warning-muted);
  border: 1px solid rgba(240, 184, 106, 0.18);
  border-radius: 10px;
}

.install-summary,
.install-note {
  color: #aeb7c6;
  font-size: 12px;
  line-height: 1.45;
}

.install-note {
  color: #7e8aa0;
}

.install-command {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;

  code {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    padding: 7px 9px;
    color: #d7deea;
    background: rgba(17, 19, 24, 0.72);
    border: 1px solid #2a3140;
    border-radius: 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.badge {
  padding: var(--space-1) var(--space-3);
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border: 1px solid rgba(143, 179, 255, 0.18);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;

  &.installed {
    color: var(--color-success);
    background: var(--color-success-muted);
    border-color: rgba(91, 184, 119, 0.18);
  }

  &.warning {
    color: var(--color-warning);
    background: var(--color-warning-muted);
    border-color: rgba(240, 184, 106, 0.18);
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

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.message {
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-muted);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  font-size: 13px;

  &.error {
    color: var(--color-danger);
    background: var(--color-danger-muted);
    border-color: rgba(255, 107, 107, 0.22);
  }

  &.success {
    color: var(--color-success);
    background: var(--color-success-muted);
    border-color: rgba(91, 184, 119, 0.22);
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
  .installed-card,
  .keybinding-row {
    display: grid;
  }
}
</style>
