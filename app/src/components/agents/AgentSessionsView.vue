<template>
  <section ref="surface" class="agent-view" tabindex="-1" aria-label="Agent sessions" @focusin="acknowledge">
    <Toolbar>
      <h1>Agents</h1>

      <Button variant="secondary" @click="run(() => acp.refresh(workspaceId))">Refresh / load history</Button>
    </Toolbar>

    <p v-if="error || acp.error" role="alert">{{ error || acp.error }}</p>

    <div class="agent-layout">
      <Panel class="sessions">
        <h2>Workspace sessions</h2>

        <Button
          v-for="item in snapshot?.sessions ?? []"
          :key="item.id"
          variant="ghost"
          :pressed="item.id === sessionId"
          @click="router.push(agentRoute(workspaceId, item.id))"
        >
          {{ item.adapterId }} / {{ item.reviewSessionId ? 'Review' : 'Chat' }} / {{ item.state }} / {{ item.id.slice(0, 8) }}
        </Button>

        <form @submit.prevent="open()">
          <label
            >Adapter
            <select v-model="adapterId" required aria-label="Adapter">
              <option value="" disabled>Select an adapter</option>

              <option
                v-for="item in adapters"
                :key="item.adapter.id"
                :value="item.adapter.id"
                :disabled="!item.available || !item.platformSupported"
              >
                {{ item.adapter.id }}{{ !item.platformSupported ? ' (unsupported platform)' : !item.available ? ' (unavailable)' : '' }}
              </option>
            </select>
          </label>

          <p v-if="!adapters.length">Configure a trusted executable in Settings / Agent Adapters.</p>

          <label><input v-model="reviewMode" type="checkbox" /> Review current target (deny all permissions)</label>

          <label v-if="!reviewMode"><input v-model="interactive" type="checkbox" /> Interactive permissions and forms</label>

          <Button type="submit" :disabled="busy || !adapterId || (reviewMode && !review.session)"
            >New {{ reviewMode ? 'review' : 'chat' }} session</Button
          >
        </form>
      </Panel>

      <div v-if="session" class="conversation">
        <Toolbar>
          <Badge tone="ai">{{ session.state }}</Badge>

          <span>{{ session.continuity }} / {{ session.permissionPolicy }}</span>

          <Button v-if="session.state === 'failed' || session.state === 'closed'" :disabled="busy" @click="open(session.id)"
            >Reconnect / load</Button
          >

          <Button
            variant="danger"
            :disabled="busy || !['running', 'starting'].includes(session.state)"
            @click="run(() => windowBridge.cancelAcpSession(request()))"
            >Cancel active turn</Button
          >

          <Button variant="secondary" :disabled="busy || session.state === 'closed'" @click="closeSession">Close session</Button>
        </Toolbar>

        <p v-if="session.continuity === 'reset'">
          The adapter could not resume this conversation. A new remote session was created; earlier history remains local.
        </p>

        <label v-if="modes.length"
          >Agent mode
          <select :value="currentMode" :disabled="busy || session.state !== 'ready'" @change="changeMode">
            <option v-for="mode in modes" :key="mode.id" :value="mode.id">{{ mode.name }}</option>
          </select>
        </label>

        <Button
          v-for="input in pendingInputs"
          :key="input.input.id"
          variant="review"
          @click="router.push(inputRoute(workspaceId, input.input.id))"
          >{{ input.input.status }}: {{ input.input.prompt }}</Button
        >

        <article v-for="(message, index) in messages" :key="`${message.id}:${index}`" class="message">
          <h3>{{ message.role === 'user-message' ? 'You' : 'Agent' }}</h3>

          <p>{{ message.text }}</p>
        </article>

        <details v-if="tools.length || plan.length">
          <summary>Plan and tool activity ({{ tools.length }})</summary>

          <p v-for="(entry, index) in plan" :key="index">{{ entry.status }}: {{ entry.content }}</p>

          <p v-for="tool in tools" :key="String(tool.toolCallId)">{{ tool.title ?? tool.toolCallId }}: {{ tool.status ?? 'pending' }}</p>
        </details>

        <details>
          <summary>Session activity ({{ acp.activity.length }})</summary>

          <p v-for="entry in acp.activity" :key="entry.sequence">
            {{ entry.kind }}{{ record(entry.payload) && typeof entry.payload.message === 'string' ? `: ${entry.payload.message}` : '' }}
          </p>
        </details>

        <Panel>
          <h2>Prompt queue</h2>

          <div v-for="turn in turns" :key="turn.id" class="queue-row">
            <span>{{ turn.state }}: {{ turn.text }}{{ turn.stopReason ? ` (${turn.stopReason})` : '' }}</span>

            <Button
              v-if="turn.state === 'queued'"
              variant="secondary"
              :disabled="busy"
              @click="run(() => windowBridge.cancelAcpTurn({ ...request(), turnId: turn.id }))"
              >Cancel queued prompt</Button
            >
          </div>
        </Panel>

        <form @submit.prevent="send">
          <label
            >Prompt
            <textarea id="agent-prompt" v-model="draft" aria-label="Agent prompt" rows="4" :disabled="session.state === 'closed'" />
          </label>

          <Button type="submit" :disabled="busy || !draft.trim() || !['ready', 'running', 'starting'].includes(session.state)"
            >Queue prompt</Button
          >
        </form>
      </div>

      <EmptyState
        v-else
        title="Choose or start a session"
        description="Sessions and queued turns continue while you work in another workspace."
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAcpStore } from '../../stores/acp';
import { useReviewStore } from '../../stores/review';
import { useWorkbenchStore } from '../../stores/workbench';
import { agentRoute, inputRoute, routeParamString } from '../../lib/workspaceRoutes';
import { record, type AcpDiscovery } from '../../lib/acpContract';
import { agentMessages, agentTools } from '../../lib/acpPresentation';
import Button from '../Button.vue';
import Panel from '../ui/Panel.vue';
import Badge from '../ui/Badge.vue';
import Toolbar from '../ui/Toolbar.vue';
import EmptyState from '../ui/EmptyState.vue';

const acp = useAcpStore();
const review = useReviewStore();
const workbench = useWorkbenchStore();
const route = useRoute();
const router = useRouter();
const windowBridge = window.diffuse;
const surface = ref<HTMLElement>();
const adapters = ref<AcpDiscovery[]>([]);
const adapterId = ref('');
const reviewMode = ref(false);
const interactive = ref(false);
const busy = ref(false);
const error = ref('');
const workspaceId = computed(() => routeParamString(route.params.workspaceId));
const sessionId = computed(() => routeParamString(route.params.agentSessionId));
const snapshot = computed(() => acp.snapshots[workspaceId.value]);
const session = computed(() => snapshot.value?.sessions.find((s) => s.id === sessionId.value));
const turns = computed(() => snapshot.value?.turnsBySession[sessionId.value] ?? []);
const pendingInputs = computed(() => snapshot.value?.inputs.filter((i) => i.sessionId === sessionId.value) ?? []);
const draft = computed({
  get: () => workbench.uiState(workspaceId.value).agentDrafts?.[sessionId.value] ?? '',
  set: (value) => saveDraft(workspaceId.value, sessionId.value, value),
});
function saveDraft(workspaceId: string, sessionId: string, value: string) {
  const state = workbench.uiState(workspaceId);
  workbench.saveUiState(workspaceId, { ...state, agentDrafts: { ...state.agentDrafts, [sessionId]: value } });
}
const messages = computed(() => agentMessages(acp.history));
const tools = computed(() => agentTools(acp.history));
const plan = computed(() => {
  const value = [...acp.history].reverse().find((h) => h.kind === 'plan')?.content;
  return Array.isArray(value) ? value.filter(record) : [];
});
const modes = computed(() => {
  const value = session.value?.modes;
  return record(value) && Array.isArray(value.availableModes)
    ? value.availableModes.filter(
        (m): m is { id: string; name: string } => record(m) && typeof m.id === 'string' && typeof m.name === 'string',
      )
    : [];
});
const currentMode = computed(() => (record(session.value?.modes) ? session.value.modes.currentModeId : ''));
const request = () => ({ context: acp.context(workspaceId.value), sessionId: sessionId.value });
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  const id = workspaceId.value;
  busy.value = true;
  error.value = '';
  try {
    await action();
    await acp.refresh(id);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function open(reconnect?: string) {
  const c = acp.context(workspaceId.value);
  const sourceRoute = route.fullPath;
  const existing = reconnect ? session.value : undefined;
  await run(async () => {
    const result = await windowBridge.openAcpSession({
      context: c,
      adapterId: existing?.adapterId ?? adapterId.value,
      sessionId: reconnect,
      reviewSessionId: existing ? (existing.reviewSessionId ?? undefined) : reviewMode.value ? review.session?.id : undefined,
      interactive: existing ? existing.permissionPolicy === 'interactive' : !reviewMode.value && interactive.value,
    });
    if (route.fullPath === sourceRoute) await router.push(agentRoute(c.workspaceId, result.sessionId));
  });
}
async function send() {
  if (busy.value) return;
  const text = draft.value.trim();
  if (!text) return;
  const state = workbench.uiState(workspaceId.value);
  const previous = state.agentPromptRequests?.[sessionId.value];
  const retry = previous?.text === text ? previous : { text, requestId: crypto.randomUUID() };
  workbench.saveUiState(workspaceId.value, { ...state, agentPromptRequests: { ...state.agentPromptRequests, [sessionId.value]: retry } });
  const queued = { ...request(), text };
  queued.context.requestId = retry.requestId;
  await run(async () => {
    await windowBridge.queueAcpPrompt(queued);
    if (
      workbench.workspaces.some(
        (w) => w.workspaceId === queued.context.workspaceId && w.workspaceGeneration === queued.context.workspaceGeneration,
      )
    ) {
      const latest = workbench.uiState(queued.context.workspaceId);
      const requests = { ...latest.agentPromptRequests };
      delete requests[queued.sessionId];
      const drafts = { ...latest.agentDrafts };
      if (drafts[queued.sessionId]?.trim() === text) drafts[queued.sessionId] = '';
      workbench.saveUiState(queued.context.workspaceId, { ...latest, agentDrafts: drafts, agentPromptRequests: requests });
    }
  });
}
function changeMode(event: Event) {
  const modeId = (event.target as HTMLSelectElement).value;
  void run(() => windowBridge.setAcpMode({ ...request(), modeId }));
}
function closeSession() {
  if (window.confirm('Close this agent session and cancel its queued work?')) void run(() => windowBridge.closeAcpSession(request()));
}
const acknowledging = new Set<string>();
function acknowledge() {
  const element = surface.value;
  if (
    !session.value ||
    acp.loadedSession !== sessionId.value ||
    !element?.isConnected ||
    !document.hasFocus() ||
    document.visibilityState !== 'visible' ||
    !element.contains(document.activeElement) ||
    element.closest('[inert], [hidden]')
  )
    return;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') return;
  }
  for (const item of Object.values(workbench.attentionItems)) {
    if (
      item.workspaceId !== workspaceId.value ||
      item.target.kind !== 'agent' ||
      item.target.agentSessionId !== sessionId.value ||
      item.status !== 'unread'
    )
      continue;
    const key = `${item.id}:${item.revision}`;
    if (acknowledging.has(key)) continue;
    acknowledging.add(key);
    void workbench.acknowledgeAttention(item.id, item.revision).catch(() => {
      acknowledging.delete(key);
    });
  }
}
watch(
  () => [workbench.attentionItems, acp.loadedSession],
  () => {
    void nextTick(acknowledge);
  },
  { deep: true },
);
watch(
  [workspaceId, sessionId],
  async ([id, session]) => {
    await acp.select(id, session);
    await nextTick();
    if (workspaceId.value !== id || sessionId.value !== session) return;
    const restored = workbench.uiState(id).logicalFocus;
    const target = restored ? document.getElementById(restored) : undefined;
    if (target && surface.value?.contains(target)) target.focus();
    else surface.value?.focus();
  },
  { immediate: true },
);
void windowBridge
  .discoverAcpAdapters()
  .then((value) => {
    adapters.value = value;
  })
  .catch((e) => {
    error.value = String(e);
  });
onMounted(() => {
  window.addEventListener('focus', acknowledge);
  document.addEventListener('visibilitychange', acknowledge);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', acknowledge);
  document.removeEventListener('visibilitychange', acknowledge);
  acp.selected = undefined;
});
</script>

<style scoped lang="scss">
.agent-view {
  min-width: 0;
  overflow: auto;
  padding: var(--space-6);
  color: var(--color-text-secondary);
}
.agent-layout {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  gap: var(--space-6);
}
.sessions,
.conversation,
form,
label {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
  align-content: start;
}
.message {
  padding: var(--space-6);
  background: var(--color-bg-panel);
  border-radius: var(--radius-4);
}
.message p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.queue-row {
  display: flex;
  gap: var(--space-4);
  justify-content: space-between;
  overflow-wrap: anywhere;
}
input,
select,
textarea {
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  padding: var(--space-3);
  min-width: 0;
}
:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
@media (max-width: 900px) {
  .agent-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
