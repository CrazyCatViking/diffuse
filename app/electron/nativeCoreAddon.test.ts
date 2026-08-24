import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreBackendError } from './coreBackend';
import { nativeAddonFactoryFromModule, resolveNativeAddonPath } from './nativeCoreAddon';

describe('native core addon loading', () => {
  it('uses the configured addon before staged development and packaged paths', () => {
    const cwd = '/workspace/app';
    const configured = resolve(cwd, 'configured.node');
    const checked: string[] = [];

    expect(
      resolveNativeAddonPath({
        cwd,
        resourcesPath: '/resources',
        env: { DIFFUSE_NATIVE_ADDON: './configured.node' },
        fileExists: (path) => {
          checked.push(path);
          return path === configured;
        },
      }),
    ).toBe(configured);
    expect(checked).toEqual([configured]);
  });

  it('fails loudly when an explicit addon path is missing', () => {
    expect(() =>
      resolveNativeAddonPath({
        cwd: '/workspace/app',
        resourcesPath: '/resources',
        env: { DIFFUSE_NATIVE_ADDON: '/missing/diffuse_core.node' },
        fileExists: () => false,
      }),
    ).toThrowError(expect.objectContaining<Partial<CoreBackendError>>({ code: 'NATIVE_ADDON_NOT_FOUND' }));
  });

  it('checks the staged development path before the packaged resource', () => {
    const checked: string[] = [];
    const packaged = '/resources/native/diffuse_core.node';

    expect(
      resolveNativeAddonPath({
        cwd: '/workspace/app',
        resourcesPath: '/resources',
        env: {},
        fileExists: (path) => {
          checked.push(path);
          return path === packaged;
        },
      }),
    ).toBe(packaged);
    expect(checked).toEqual(['/workspace/app/build/native/diffuse_core.node', packaged]);
  });

  it('never inspects cwd development paths in packaged mode', () => {
    const checked: string[] = [];

    expect(() =>
      resolveNativeAddonPath({
        cwd: '/attacker-controlled-cwd',
        resourcesPath: '/resources',
        isPackaged: true,
        env: {},
        fileExists: (path) => {
          checked.push(path);
          return path === '/attacker-controlled-cwd/build/native/diffuse_core.node';
        },
      }),
    ).toThrowError(expect.objectContaining<Partial<CoreBackendError>>({ code: 'NATIVE_ADDON_NOT_FOUND' }));
    expect(checked).toEqual(['/resources/native/diffuse_core.node']);
  });

  it('adapts factory and class exports through one typed boundary', () => {
    const addon = completeAddon();
    const callback = () => undefined;
    const factory = nativeAddonFactoryFromModule({ createCore: () => addon });
    class DiffuseCore {
      constructor(readonly options: unknown) {
        Object.assign(this, addon);
      }
    }
    const classFactory = nativeAddonFactoryFromModule({ DiffuseCore });

    expect(factory({ onEventBatch: callback })).toBe(addon);
    expect(classFactory({ onEventBatch: callback })).toMatchObject(addon);
  });
});

function completeAddon() {
  return {
    getVersion: async () => undefined,
    getWorkbenchSnapshot: async () => undefined,
    openWorkspace: async () => undefined,
    activateWorkspace: async () => undefined,
    getWorkspaceSnapshot: async () => undefined,
    closeWorkspace: async () => undefined,
    request: async () => undefined,
    health: async () => undefined,
    shutdown: async () => undefined,
  };
}
