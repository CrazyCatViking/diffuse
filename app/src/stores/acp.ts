import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { type AcpSnapshot, type AcpHistory, type AcpActivity, type AcpEventBatch, type AcpSessionRequest } from '../lib/acpContract';
import { useWorkbenchStore } from './workbench';
import type { WorkspaceRequestContext } from '../lib/workbenchContract';

export const useAcpStore = defineStore('acp', () => {
  const workbench = useWorkbenchStore();
  const snapshots = ref<Record<string, AcpSnapshot>>({});
  const history = ref<AcpHistory[]>([]);
  const activity = ref<AcpActivity[]>([]);
  const error = ref('');
  const selected = ref<{ workspaceId: string; sessionId: string }>();
  const loadedSession = ref<string>();
  let sequence = 0;
  let viewEpoch = 0;
  let unsubscribe: (() => void) | undefined;
  let pending = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = -1;
  const dirty = new Set<string>();
  let inbox: AcpEventBatch[] = [];
  let draining = false;

  function context(workspaceId: string): WorkspaceRequestContext {
    const workspace = workbench.workspaces.find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error('Workspace is no longer open');
    return { workspaceId, workspaceGeneration: workspace.workspaceGeneration, requestId: crypto.randomUUID() };
  }
  function current(c: ReturnType<typeof context>) {
    return workbench.workspaces.some((w) => w.workspaceId === c.workspaceId && w.workspaceGeneration === c.workspaceGeneration);
  }
  async function refreshNow(workspaceId: string) {
    const c = context(workspaceId);
    const snapshot = await window.diffuse.getAcpSnapshot(c);
    if (!current(c)) return;
    snapshots.value[workspaceId] = snapshot;
    if (selected.value?.workspaceId === workspaceId) await loadHistory();
    error.value = '';
  }
  function refresh(workspaceId: string) {
    const operation = pending.then(() => refreshNow(workspaceId));
    pending = operation.catch((e) => {
      error.value = String(e);
    });
    return operation;
  }
  async function loadHistory() {
    const target = selected.value;
    if (!target) return;
    const epoch = viewEpoch;
    const request: AcpSessionRequest = { context: context(target.workspaceId), sessionId: target.sessionId };
    const session = snapshots.value[target.workspaceId]?.sessions.find((s) => s.id === target.sessionId);
    if (!session) {
      history.value = [];
      activity.value = [];
      return;
    }
    if (revision !== session.historyRevision) {
      loadedSession.value = undefined;
      history.value = [];
      activity.value = [];
      revision = session.historyRevision;
    }
    for (const kind of ['history', 'activity'] as const) {
      const entries = kind === 'history' ? history : activity;
      let after = entries.value.at(-1)?.sequence ?? 0;
      while (true) {
        const page =
          kind === 'history'
            ? await window.diffuse.getAcpHistory({ ...request, after })
            : await window.diffuse.getAcpActivity({ ...request, after });
        if (epoch !== viewEpoch || !current(request.context)) return;
        if (kind === 'history') history.value.push(...(page as AcpHistory[]));
        else activity.value.push(...(page as AcpActivity[]));
        if (page.length < 100) break;
        after = page.at(-1)!.sequence;
      }
    }
    if (epoch === viewEpoch && current(request.context)) loadedSession.value = target.sessionId;
  }
  function schedule(workspaceId: string) {
    dirty.add(workspaceId);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const ids = [...dirty];
      dirty.clear();
      pending = pending
        .then(async () => {
          for (const id of ids) if (workbench.workspaces.some((w) => w.workspaceId === id)) await refreshNow(id);
          await workbench.refreshAgentAttention();
        })
        .catch((e) => {
          error.value = String(e);
        });
    }, 80);
  }
  async function recover() {
    // Each workspace snapshot has a global ACP watermark. Never use the workbench watermark here.
    let minimum = Infinity;
    for (const w of [...workbench.workspaces]) {
      await refreshNow(w.workspaceId);
      minimum = Math.min(minimum, snapshots.value[w.workspaceId]?.sequence ?? 0);
    }
    sequence = Number.isFinite(minimum) ? minimum : 0;
    await workbench.refreshAgentAttention();
  }
  async function receive(batch: AcpEventBatch) {
    if (batch.requiresSnapshot) {
      await recover();
      return;
    }
    for (const event of batch.events) {
      if (event.sequence <= sequence) continue;
      if (event.sequence !== sequence + 1) {
        const replay = await window.diffuse.readAcpEvents({ afterSequence: sequence });
        if (replay.requiresSnapshot || (replay.events[0] && replay.events[0].sequence !== sequence + 1)) {
          await recover();
          return;
        }
        if (replay.events.length) await receive(replay);
        return;
      }
      sequence = event.sequence;
      if (workbench.workspaces.some((w) => w.workspaceId === event.workspaceId && w.workspaceGeneration === event.workspaceGeneration))
        schedule(event.workspaceId);
    }
  }
  function start() {
    if (unsubscribe) return;
    unsubscribe = window.diffuse.onAcpEventBatch((batch) => {
      // Bound retained renderer batches while history or native snapshots are loading.
      if (inbox.length >= 64) inbox = [{ events: [], requiresSnapshot: true }];
      else inbox.push(batch);
      if (draining) return;
      draining = true;
      pending = pending
        .then(async () => {
          while (inbox.length) await receive(inbox.shift()!);
        })
        .catch((e) => {
          error.value = String(e);
        })
        .finally(() => {
          draining = false;
        });
    });
    pending = pending.then(recover).catch((e) => {
      error.value = String(e);
    });
  }
  async function select(workspaceId: string, sessionId?: string) {
    viewEpoch += 1;
    loadedSession.value = undefined;
    selected.value = sessionId ? { workspaceId, sessionId } : undefined;
    history.value = [];
    activity.value = [];
    revision = -1;
    await refresh(workspaceId).catch((e) => {
      error.value = String(e);
    });
  }
  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    inbox = [];
    dirty.clear();
    viewEpoch += 1;
  }
  watch(
    () => workbench.workspaces.map((w) => `${w.workspaceId}:${w.workspaceGeneration}`).join(','),
    () => {
      for (const [id, snapshot] of Object.entries(snapshots.value))
        if (!workbench.workspaces.some((w) => w.workspaceId === id && w.workspaceGeneration === snapshot.workspaceGeneration)) {
          delete snapshots.value[id];
          if (selected.value?.workspaceId === id) {
            viewEpoch += 1;
            loadedSession.value = undefined;
            history.value = [];
            activity.value = [];
            revision = -1;
          }
        }
      if (unsubscribe) for (const w of workbench.workspaces) if (!snapshots.value[w.workspaceId]) schedule(w.workspaceId);
    },
    { flush: 'sync' },
  );
  return { snapshots, history, activity, error, selected, loadedSession, context, refresh, select, start, stop };
});
