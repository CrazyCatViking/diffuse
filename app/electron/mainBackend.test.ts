import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeAddonModuleLoaded = vi.hoisted(() => vi.fn());
const electronState = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: any[]) => void>(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: vi.fn(() => '/user-data'),
    isPackaged: false,
    isReady: vi.fn(() => false),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => electronState.appHandlers.set(name, handler)),
    quit: electronState.quit,
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: class BrowserWindow {
    static fromWebContents = vi.fn();
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
  shell: { openPath: vi.fn() },
  Tray: class Tray {},
}));

vi.mock('./reviewAgentRunner', () => ({ ReviewAgentRunner: class ReviewAgentRunner {} }));
vi.mock('./nativeCoreAddon', () => {
  nativeAddonModuleLoaded();
  return { loadNativeAddonFactory: vi.fn() };
});

import { desktopCoreMode, parseLaunchRepository, resolveNativeSyntaxRunnerPath } from './main';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Electron main backend configuration', () => {
  it('keeps main import-safe and defaults desktop core selection to napi', () => {
    vi.stubEnv('DIFFUSE_DESKTOP_CORE', '');

    expect(nativeAddonModuleLoaded).not.toHaveBeenCalled();
    expect(desktopCoreMode()).toBe('napi');
    expect(desktopCoreMode('napi')).toBe('napi');
    expect(desktopCoreMode('rpc')).toBe('rpc');
    expect(() => desktopCoreMode('other')).toThrow('Unsupported DIFFUSE_DESKTOP_CORE value');
    expect(parseLaunchRepository(['diffuse', '--open-repository', 'repo'], '/workspace')).toBe('/workspace/repo');
  });

  it('prefers development and packaged Rust helpers for their matching runtime', () => {
    const development = '/workspace/target/debug/diffuse';
    const packaged = '/resources/diffuse-rpc';
    const common = {
      cwd: '/workspace/app',
      dirname: '/workspace/app/out/main',
      resourcesPath: '/resources',
      platform: 'linux' as const,
      fileExists: (path: string) => path === development || path === packaged,
    };

    expect(resolveNativeSyntaxRunnerPath({ ...common, isPackaged: false })).toBe(development);
    expect(resolveNativeSyntaxRunnerPath({ ...common, isPackaged: true })).toBe(packaged);
  });

  it('honors and validates an explicit syntax runner path', () => {
    const configured = resolve('/workspace/app', 'bin/diffuse');

    expect(
      resolveNativeSyntaxRunnerPath({
        configuredPath: 'bin/diffuse',
        cwd: '/workspace/app',
        fileExists: (path) => path === configured,
      }),
    ).toBe(configured);
    expect(() =>
      resolveNativeSyntaxRunnerPath({
        configuredPath: '/missing/diffuse',
        fileExists: () => false,
      }),
    ).toThrow('DIFFUSE_SYNTAX_RUNNER points to a missing executable');
  });

  it('does not initialize or duplicate shutdown when quitting before readiness', async () => {
    const beforeQuit = electronState.appHandlers.get('before-quit');
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    expect(beforeQuit).toBeTypeOf('function');
    beforeQuit?.(firstEvent);
    beforeQuit?.(repeatedEvent);
    await vi.waitFor(() => expect(electronState.quit).toHaveBeenCalledTimes(1));

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(nativeAddonModuleLoaded).not.toHaveBeenCalled();
  });
});
