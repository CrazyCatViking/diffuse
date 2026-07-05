<template>
  <div class="settings-section">
    <SettingsSectionHeader
      title-id="languageServers-settings-title"
      title="Language Servers"
      description="Configure LSP servers used for hover information and diagnostics in diffs."
    >
      <template #actions>
        <Button variant="secondary" :disabled="!lspConfigInfo?.configPath" @click="openLspConfig">Open Config</Button>

        <Button :disabled="lspLoading" @click="loadLspConfigInfo">{{ lspLoading ? 'Refreshing...' : 'Refresh' }}</Button>
      </template>
    </SettingsSectionHeader>

    <div class="summary-grid" aria-label="Language server summary">
      <Panel padding="md" class="summary-card">
        <span class="stat-label">Ready</span>

        <span class="stat-value">{{ lspSummary.ready }}</span>
      </Panel>

      <Panel padding="md" class="summary-card">
        <span class="stat-label">Running</span>

        <span class="stat-value">{{ lspSummary.running }}</span>
      </Panel>

      <Panel padding="md" class="summary-card">
        <span class="stat-label">Missing</span>

        <span class="stat-value">{{ lspSummary.missing }}</span>
      </Panel>

      <Panel padding="md" class="summary-card">
        <span class="stat-label">Errors</span>

        <span class="stat-value">{{ lspSummary.errors }}</span>
      </Panel>
    </div>

    <Panel padding="none" class="servers-panel">
      <header class="panel-header">
        <div>
          <h3>Servers</h3>

          <p>{{ lspServers.length }} configured {{ lspServers.length === 1 ? 'server' : 'servers' }}</p>
        </div>

        <Badge tone="neutral">{{ lspConfigInfo?.configPath ? 'Config found' : 'No config path' }}</Badge>
      </header>

      <div v-if="lspError" class="message error" role="alert">{{ lspError }}</div>

      <EmptyState
        v-else-if="lspLoading && !lspConfigInfo"
        class="panel-empty"
        align="start"
        bordered
        title="Loading language servers"
        description="Diffuse is reading configured and built-in server definitions."
      />

      <template v-else-if="lspConfigInfo">
        <div class="config-path-row">
          <span>Config file</span>

          <code>{{ lspConfigInfo.configPath ?? 'No home directory available' }}</code>
        </div>

        <EmptyState
          v-if="lspServers.length === 0"
          class="panel-empty"
          align="start"
          bordered
          title="No language servers"
          description="Add server entries to the LSP config file or use built-in defaults for supported languages."
        />

        <div v-else class="lsp-list">
          <article
            v-for="server in lspServers"
            :key="server.language"
            class="lsp-row"
            :class="{ missing: !server.installed, running: server.running, errored: Boolean(server.lastError) }"
          >
            <div class="lsp-meta">
              <div class="lsp-title">
                <span class="server-name">{{ server.language }}</span>

                <Badge :tone="server.installed ? 'success' : 'warning'">{{ server.installed ? 'Ready' : 'Missing' }}</Badge>

                <Badge :tone="lspSessionBadgeTone(server)">{{ lspSessionLabel(server) }}</Badge>

                <Badge tone="neutral">{{ server.configSource }}</Badge>
              </div>

              <div class="server-details">
                <span>{{ server.serverId }}</span>

                <span :title="lspCommand(server)">{{ lspCommand(server) }}</span>
              </div>

              <div v-if="server.lastError" class="lsp-error" :title="server.lastError">Last error: {{ server.lastError }}</div>

              <div v-if="server.running || server.lastError" class="lsp-session-actions">
                <Button type="button" size="sm" :disabled="restartingLspServer === server.serverId" @click="restartLspServer(server)">
                  {{ restartingLspServer === server.serverId ? 'Restarting...' : 'Restart Server' }}
                </Button>
              </div>

              <div v-if="!server.installed && server.install" class="lsp-install-guide">
                <div class="install-summary">{{ server.install.description }}</div>

                <div class="install-command">
                  <code>{{ lspInstallCommand(server) }}</code>

                  <Button type="button" size="sm" variant="secondary" @click="copyLspInstallCommand(server)">
                    {{ copiedLspLanguage === server.language ? 'Copied' : 'Copy' }}
                  </Button>

                  <Button
                    v-if="server.install.safeToRun"
                    type="button"
                    size="sm"
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
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { LspConfigInfo, LspServerInfo } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import SettingsSectionHeader from './SettingsSectionHeader.vue';

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'review' | 'ai';

const client = useClient();
const lspConfigInfo = ref<LspConfigInfo>();
const lspLoading = ref(false);
const lspError = ref<string>();
const installingLspServer = ref<string>();
const restartingLspServer = ref<string>();
const copiedLspLanguage = ref<string>();
const lspInstallStep = ref<string>();
let removeCoreEventListener: (() => void) | undefined;
let copiedLspTimer: number | undefined;

const lspServers = computed(() => lspConfigInfo.value?.servers ?? []);
const lspSummary = computed(() => ({
  ready: lspServers.value.filter((server) => server.installed).length,
  running: lspServers.value.filter((server) => server.running).length,
  missing: lspServers.value.filter((server) => !server.installed).length,
  errors: lspServers.value.filter((server) => server.lastError).length,
}));

const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
  return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
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

const lspSessionBadgeTone = (server: LspServerInfo): BadgeTone => {
  if (server.lastError) return 'danger';
  if (server.running) return 'success';
  if (server.starting) return 'info';
  return 'neutral';
};

onMounted(() => {
  removeCoreEventListener = window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'lsp/installProgress') return;
    if (!event.params || typeof event.params !== 'object') return;

    const params = event.params as { serverId?: unknown; step?: unknown };
    if (params.serverId !== installingLspServer.value) return;
    if (typeof params.step === 'string') lspInstallStep.value = params.step;
  });

  void loadLspConfigInfo();
});

onBeforeUnmount(() => {
  removeCoreEventListener?.();
  if (copiedLspTimer !== undefined) window.clearTimeout(copiedLspTimer);
});
</script>

<style scoped lang="scss">
.settings-section,
.lsp-list {
  display: grid;
  gap: var(--space-7);
  min-width: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.servers-panel {
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

.config-path-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-6);
  align-items: center;
  margin: var(--space-7);
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-muted);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  font-size: var(--font-size-label);

  code {
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.lsp-list {
  gap: var(--space-4);
  padding: 0 var(--space-7) var(--space-7);
}

.lsp-row {
  display: grid;
  min-width: 0;
  padding: var(--space-6);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);

  &.missing {
    background: linear-gradient(90deg, var(--color-warning-muted), var(--color-bg-panel-raised) 160px);
  }

  &.running {
    background: linear-gradient(90deg, var(--color-success-muted), var(--color-bg-panel-raised) 160px);
  }

  &.errored {
    background: linear-gradient(90deg, var(--color-danger-muted), var(--color-bg-panel-raised) 160px);
  }
}

.lsp-meta {
  min-width: 0;
}

.lsp-title {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
}

.server-name {
  color: var(--color-text-primary);
  font-weight: 800;
}

.server-details {
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

.lsp-error {
  margin-top: var(--space-3);
  overflow: hidden;
  color: var(--color-danger);
  font-size: var(--font-size-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lsp-session-actions {
  margin-top: var(--space-5);
}

.lsp-install-guide {
  display: grid;
  gap: var(--space-4);
  margin-top: var(--space-6);
  padding: var(--space-5);
  background: var(--color-warning-muted);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
}

.install-summary,
.install-note {
  color: var(--color-text-secondary);
  font-size: var(--font-size-label);
  line-height: 1.45;
}

.install-note {
  color: var(--color-text-muted);
}

.install-command {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  min-width: 0;

  code {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    padding: var(--space-4) var(--space-5);
    color: var(--color-text-secondary);
    background: var(--color-bg-inset);
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-3);
    font-family: var(--font-mono);
    font-size: var(--font-size-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.message {
  margin: var(--space-7);
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
  color: var(--color-success);
  font-size: var(--font-size-label);
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .summary-grid,
  .config-path-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel-header,
  .install-command {
    display: grid;
  }
}
</style>
