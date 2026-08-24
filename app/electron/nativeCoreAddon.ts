import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { CoreMethods } from '../src/lib/coreContract';
import type { WorkspaceCoreMethod, WorkspaceReference, WorkspaceRequestContext } from '../src/lib/workbenchContract';
import { CoreBackendError } from './coreBackend';

export type NativeEventBatchCallback = (events: unknown) => void;

export type NativeCoreAddonCreateOptions = {
  onEventBatch: NativeEventBatchCallback;
  [key: string]: unknown;
};

export interface NativeCoreAddon {
  getVersion(): Promise<unknown>;
  getWorkbenchSnapshot(): Promise<unknown>;
  openWorkspace(path: string): Promise<unknown>;
  activateWorkspace(reference: WorkspaceReference | null): Promise<unknown>;
  getWorkspaceSnapshot(reference: WorkspaceReference): Promise<unknown>;
  closeWorkspace(reference: WorkspaceReference): Promise<unknown>;
  request<M extends WorkspaceCoreMethod>(context: WorkspaceRequestContext, method: M, params: CoreMethods[M]['params']): Promise<unknown>;
  health(): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export type NativeCoreAddonFactory = (options: NativeCoreAddonCreateOptions) => NativeCoreAddon;

type NativeAddonResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  fileExists?: (path: string) => boolean;
};

type NativeAddonLoadOptions = NativeAddonResolutionOptions & {
  requireAddon?: (path: string) => unknown;
};

const requireFromHere = createRequire(import.meta.url);

export function resolveNativeAddonPath(options: NativeAddonResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fileExists = options.fileExists ?? existsSync;
  const configured = env.DIFFUSE_NATIVE_ADDON;
  if (configured) {
    const configuredPath = isAbsolute(configured) ? configured : resolve(cwd, configured);
    if (fileExists(configuredPath)) return configuredPath;
    throw new CoreBackendError('NATIVE_ADDON_NOT_FOUND', `DIFFUSE_NATIVE_ADDON points to a missing native addon: ${configuredPath}`);
  }

  const developmentPath = resolve(cwd, 'build/native/diffuse_core.node');
  const resourcesPath = options.resourcesPath ?? getResourcesPath();
  const packagedPath = resourcesPath ? join(resourcesPath, 'native/diffuse_core.node') : undefined;
  const candidates = options.isPackaged ? (packagedPath ? [packagedPath] : []) : [developmentPath, ...(packagedPath ? [packagedPath] : [])];
  const match = candidates.find(fileExists);
  if (match) return match;
  throw new CoreBackendError('NATIVE_ADDON_NOT_FOUND', `Diffuse native addon was not found. Checked: ${candidates.join(', ')}`);
}

export function loadNativeAddonFactory(options: NativeAddonLoadOptions = {}): NativeCoreAddonFactory {
  const path = resolveNativeAddonPath(options);
  let loaded: unknown;
  try {
    loaded = (options.requireAddon ?? requireFromHere)(path);
  } catch (error) {
    throw new CoreBackendError('NATIVE_ADDON_LOAD_FAILED', `Failed to load Diffuse native addon: ${path}`, { cause: error });
  }
  return nativeAddonFactoryFromModule(loaded);
}

export function nativeAddonFactoryFromModule(loaded: unknown): NativeCoreAddonFactory {
  const candidate = unwrapDefaultExport(loaded);
  if (typeof candidate === 'function') {
    return (options) => validateAddon(candidate(options));
  }
  if (!isRecord(candidate)) throw invalidAddonExport();

  if (typeof candidate.createCore === 'function') {
    const createCore = candidate.createCore;
    return (options) => validateAddon(createCore(options));
  }
  if (typeof candidate.DiffuseCore === 'function') {
    const AddonClass = candidate.DiffuseCore as new (options: NativeCoreAddonCreateOptions) => unknown;
    return (options) => validateAddon(new AddonClass(options));
  }
  throw invalidAddonExport();
}

function validateAddon(value: unknown): NativeCoreAddon {
  const methods = [
    'getVersion',
    'getWorkbenchSnapshot',
    'openWorkspace',
    'activateWorkspace',
    'getWorkspaceSnapshot',
    'closeWorkspace',
    'request',
    'health',
    'shutdown',
  ];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new CoreBackendError('NATIVE_ADDON_INVALID', `Diffuse native addon is missing methods: ${methods.join(', ')}`);
  }
  return value as unknown as NativeCoreAddon;
}

function unwrapDefaultExport(value: unknown): unknown {
  if (!isRecord(value) || value.default === undefined) return value;
  return value.default;
}

function invalidAddonExport(): CoreBackendError {
  return new CoreBackendError('NATIVE_ADDON_INVALID', 'Diffuse native addon must export createCore, DiffuseCore, or a default factory');
}

function getResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
