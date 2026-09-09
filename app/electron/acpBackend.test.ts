import { describe, expect, it, vi } from 'vitest';
import { AcpBackend } from './acpBackend';
import { NativeCoreBackend } from './nativeCoreBackend';
import type { NativeCoreAddon, NativeCoreAddonCreateOptions } from './nativeCoreAddon';
import { adapter } from '../src/test/acpFixture';
describe('ACP backend boundary', () => {
  it('reports unsupported RPC methods rather than returning success', async () => {
    const backend = new AcpBackend();
    await expect(backend.discoverAcpAdapters()).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    await expect(backend.saveAcpAdapter(adapter)).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
  });
  it('uses a distinct native callback and recovers malformed batches without poisoning workbench events', async () => {
    let options!: NativeCoreAddonCreateOptions;
    const save = vi.fn(async () => null);
    const backend = new NativeCoreBackend((created) => {
      options = created;
      return {
        saveAcpAdapter: save,
        health: async () => ({ status: 'healthy' }),
        shutdown: async () => null,
      } as unknown as NativeCoreAddon;
    });
    const acp = vi.fn();
    const workbench = vi.fn();
    backend.onAcpEventBatch(acp);
    backend.onEvents(workbench);
    await backend.saveAcpAdapter(adapter);
    expect(save).toHaveBeenCalledWith(adapter);
    options.onAcpEventBatch?.({ events: [], requiresSnapshot: true, sequence: 100 });
    expect(acp).toHaveBeenLastCalledWith({ events: [], requiresSnapshot: true, sequence: 100 });
    options.onAcpEventBatch?.({ malformed: true });
    expect(acp).toHaveBeenLastCalledWith({ events: [], requiresSnapshot: true });
    expect(workbench).not.toHaveBeenCalled();
    expect(await backend.health()).toEqual({ status: 'healthy' });
    await backend.shutdown();
    options.onAcpEventBatch?.({ events: [], requiresSnapshot: true });
    expect(acp).toHaveBeenCalledTimes(2);
  });
});
