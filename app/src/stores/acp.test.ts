// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDesktopBridge } from '../test/mockDesktopBridge';
import { acpSnapshot, historyEntry } from '../test/acpFixture';
import { useAcpStore } from './acp';
import { useWorkbenchStore } from './workbench';
import type { AcpSnapshot } from '../lib/acpContract';

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});
function setup() {
  const bridge = createMockDesktopBridge();
  window.diffuse = bridge;
  const snapshot = acpSnapshot();
  const workbench = useWorkbenchStore();
  workbench.workspaces = [snapshot.summary];
  bridge.getAcpSnapshot.mockImplementation(async (c) => ({
    ...snapshot,
    workspaceId: c.workspaceId,
    workspaceGeneration: c.workspaceGeneration,
  }));
  bridge.getAcpHistory.mockResolvedValue([]);
  bridge.getAcpActivity.mockResolvedValue([]);
  return { bridge, snapshot, workbench, store: useAcpStore() };
}
describe('ACP active view and independent event stream', () => {
  it('rejects late history after selecting another session and follows 100-entry pages', async () => {
    const { bridge, snapshot, store } = setup();
    const first = snapshot.sessions[0].id;
    const second = 'second';
    snapshot.sessions.push({ ...snapshot.sessions[0], id: second });
    let finish!: (value: ReturnType<typeof historyEntry>[]) => void;
    bridge.getAcpHistory.mockImplementation(async ({ sessionId, after }) => {
      if (sessionId === first)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return after ? [historyEntry(second, 101)] : Array.from({ length: 100 }, (_, i) => historyEntry(second, i + 1));
    });
    const old = store.select(snapshot.workspaceId, first);
    await vi.waitFor(() => expect(bridge.getAcpHistory).toHaveBeenCalledOnce());
    const next = store.select(snapshot.workspaceId, second);
    finish([historyEntry(first)]);
    await Promise.all([old, next]);
    expect(store.history).toHaveLength(101);
    expect(store.history.every((entry) => entry.sessionId === second)).toBe(true);
    expect(bridge.getAcpHistory).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: second, after: 100 }));
  });

  it('discards a snapshot from a closed generation', async () => {
    const { bridge, snapshot, store, workbench } = setup();
    let resolve!: (snapshot: AcpSnapshot) => void;
    bridge.getAcpSnapshot.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = store.refresh(snapshot.workspaceId);
    await vi.waitFor(() => expect(bridge.getAcpSnapshot).toHaveBeenCalledOnce());
    workbench.workspaces = [{ ...snapshot.summary, workspaceGeneration: 'new' }];
    resolve(snapshot);
    await loading;
    expect(store.snapshots[snapshot.workspaceId]).toBeUndefined();
  });
  it('loads normalized chunks once and reloads from zero when historyRevision changes', async () => {
    const { bridge, snapshot, store } = setup();
    const id = snapshot.sessions[0].id;
    bridge.getAcpHistory.mockImplementation(async ({ after }) => (after ? [] : [historyEntry(id)]));
    await store.select(snapshot.workspaceId, id);
    await store.refresh(snapshot.workspaceId);
    expect(store.history).toHaveLength(1);
    expect(bridge.getAcpHistory).toHaveBeenLastCalledWith(expect.objectContaining({ after: 1 }));
    snapshot.sessions[0].historyRevision = 1;
    bridge.getAcpHistory.mockResolvedValueOnce([historyEntry(id, 50, 'Replaced')]);
    await store.refresh(snapshot.workspaceId);
    expect(store.history).toEqual([historyEntry(id, 50, 'Replaced')]);
    expect(bridge.getAcpHistory).toHaveBeenLastCalledWith(expect.objectContaining({ after: 0 }));
  });
  it('recovers gaps using ACP replay and never the workbench sequence', async () => {
    const { bridge, snapshot, store, workbench } = setup();
    workbench.sequence = 900;
    store.start();
    await vi.waitFor(() => expect(store.snapshots[snapshot.workspaceId]).toBeDefined());
    bridge.readAcpEvents.mockResolvedValueOnce({ events: [], requiresSnapshot: true });
    bridge.emitAcpEventBatch({
      requiresSnapshot: false,
      events: [
        {
          sequence: 8,
          eventId: 'e',
          kind: 'agent/sessionChanged',
          workspaceId: snapshot.workspaceId,
          workspaceGeneration: snapshot.workspaceGeneration,
          payload: snapshot.sessions[0],
        },
      ],
    });
    await vi.waitFor(() => expect(bridge.readAcpEvents).toHaveBeenCalledWith({ afterSequence: 0 }));
    await vi.waitFor(() => expect(bridge.getAcpSnapshot).toHaveBeenCalledTimes(2));
    expect(workbench.sequence).toBe(900);
    bridge.emitAcpEventBatch({ events: [], requiresSnapshot: true, sequence: 9 });
    await vi.waitFor(() => expect(bridge.getAcpSnapshot).toHaveBeenCalledTimes(3));
    store.stop();
  });
  it('ignores old-generation events while allowing background workspaces', async () => {
    const { bridge, snapshot, store, workbench } = setup();
    const b = acpSnapshot('workspace-b', 'generation-b');
    workbench.workspaces.push(b.summary);
    bridge.getAcpSnapshot.mockImplementation(async (c) => (c.workspaceId === b.workspaceId ? b : snapshot));
    store.start();
    await vi.waitFor(() => expect(store.snapshots[b.workspaceId]).toBeDefined());
    bridge.getAcpSnapshot.mockClear();
    bridge.emitAcpEventBatch({
      requiresSnapshot: false,
      events: [
        { sequence: 1, eventId: 'old', kind: 'agent/activity', workspaceId: snapshot.workspaceId, workspaceGeneration: 'old', payload: {} },
        {
          sequence: 2,
          eventId: 'b',
          kind: 'agent/activity',
          workspaceId: b.workspaceId,
          workspaceGeneration: b.workspaceGeneration,
          payload: {},
        },
      ],
    });
    await vi.waitFor(() => expect(bridge.getAcpSnapshot).toHaveBeenCalledTimes(1));
    expect(bridge.getAcpSnapshot).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: b.workspaceId }));
    store.stop();
  });
});
