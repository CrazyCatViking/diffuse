import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type Input, type IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { startCoreProcess } from './coreProcess';
import { ReviewAgentRunner } from './reviewAgentRunner';
import { coreMethodNames, type CoreMethods } from '../src/lib/coreContract';
import type { ReviewAgentChatRequest, ReviewAgentStartRequest } from '../src/lib/desktopBridge';
import {
  isWorkspaceReference,
  isWorkspaceRequestContext,
  type WorkbenchEvent,
  type WorkspaceCoreMethod,
  type WorkspaceRequestContext,
} from '../src/lib/workbenchContract';
import { LegacyWorkspaceRegistry } from './legacyWorkspaceRegistry';

const workspaceMethodNames = coreMethodNames.filter(
  (method): method is WorkspaceCoreMethod => method !== 'getVersion' && method !== 'openRepository',
);
const allowedWorkspaceMethods = new Set<WorkspaceCoreMethod>(workspaceMethodNames);
let primaryWindow: BrowserWindow | null = null;
let initialWorkspaceOpen: Promise<unknown> = Promise.resolve();
let reviewAgentOwner: { context: WorkspaceRequestContext; runner: ReviewAgentRunner } | null = null;

const registry = new LegacyWorkspaceRegistry({
  createClient: startCoreProcess,
  onEvent: (event) => forwardWorkbenchEvent(event),
});

if (!app.requestSingleInstanceLock({ cwd: process.cwd() })) {
  app.exit(0);
}

function forwardWorkbenchEvent(event: WorkbenchEvent): void {
  if (event.kind === 'workspace/removed' && reviewAgentOwner && matchesContext(reviewAgentOwner.context, event)) {
    reviewAgentOwner.runner.dispose();
    reviewAgentOwner = null;
  }
  if (primaryWindow && !primaryWindow.isDestroyed()) primaryWindow.webContents.send('workbench:event', event);
}

function isWorkspaceMethod(method: string): method is WorkspaceCoreMethod {
  return allowedWorkspaceMethods.has(method as WorkspaceCoreMethod);
}

function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(): BrowserWindow {
  if (primaryWindow && !primaryWindow.isDestroyed()) return primaryWindow;

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Diffuse',
    backgroundColor: '#111318',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  primaryWindow = window;

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script ${preloadPath}:`, error);
  });
  installKeyboardDefaultGuards(window);
  window.on('closed', () => {
    if (primaryWindow === window) primaryWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

function installKeyboardDefaultGuards(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (shouldToggleDevTools(input)) {
      event.preventDefault();
      toggleDevTools(window);
      return;
    }

    if (shouldBlockElectronDefaultShortcut(input)) event.preventDefault();
  });
}

function shouldToggleDevTools(input: Input): boolean {
  if (input.isComposing) return false;

  const key = input.key.toLowerCase();
  if (key === 'f12') return true;
  if (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) return true;
  return input.meta && input.alt && (key === 'i' || key === 'j' || key === 'c');
}

function toggleDevTools(window: BrowserWindow): void {
  if (window.webContents.isDevToolsOpened()) {
    window.webContents.closeDevTools();
    return;
  }

  window.webContents.openDevTools({ mode: 'detach' });
}

function shouldBlockElectronDefaultShortcut(input: Input): boolean {
  if (input.isComposing) return false;

  const key = input.key.toLowerCase();
  const command = input.control || input.meta;
  if (key === 'browserback' || key === 'browserforward') return true;
  if (input.alt && (key === 'arrowleft' || key === 'arrowright')) return true;
  if (key === 'f5' || key === 'f11' || key === 'f12') return true;
  if (!command) return false;

  if (key === 'r') return true;
  if (input.shift && (key === 'i' || key === 'j' || key === 'c')) return true;
  return key === '+' || key === '=' || key === '-' || key === '_' || key === '0';
}

export function parseLaunchRepository(args: string[], cwd = process.cwd()): string | undefined {
  const index = args.indexOf('--open-repository');
  if (index === -1 || index + 1 >= args.length) return undefined;
  const path = args
    .slice(index + 1)
    .filter((arg) => !arg.startsWith('-'))
    .at(-1);
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  const launchPath = parseLaunchRepository(process.argv);
  if (launchPath) initialWorkspaceOpen = openWorkspaceFromMain(launchPath);

  app.on('activate', () => {
    const window = createWindow();
    focusWindow(window);
  });
});

app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
  const cwd = isCwdPayload(additionalData) ? additionalData.cwd : workingDirectory;
  const launchPath = parseLaunchRepository(argv, cwd);
  const handleInvocation = async () => {
    const window = createWindow();
    focusWindow(window);
    if (launchPath) await openWorkspaceFromMain(launchPath);
  };
  if (app.isReady()) void handleInvocation();
  else void app.whenReady().then(handleInvocation);
});

function isCwdPayload(value: unknown): value is { cwd: string } {
  return isRecord(value) && typeof value.cwd === 'string';
}

async function openWorkspaceFromMain(path: string): Promise<void> {
  try {
    await registry.openWorkspace(path);
  } catch (error) {
    console.error(`Failed to open workspace ${path}:`, error);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  reviewAgentOwner?.runner.dispose();
  reviewAgentOwner = null;
  registry.dispose();
});

function getRequestWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window !== primaryWindow) throw new Error('Request did not originate from the primary window');
  return window;
}

function ensureLspConfigFile(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) return;

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        lsp: {
          zig: {
            command: 'zls',
            args: [],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

ipcMain.handle('repo:pickDirectory', async (event) => {
  const window = getRequestWindow(event);
  const result = await dialog.showOpenDialog(window, {
    title: 'Open Repository',
    properties: ['openDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('app:getVersion', async (event) => {
  getRequestWindow(event);
  const client = startCoreProcess();
  try {
    return await client.request<CoreMethods['getVersion']['result']>('getVersion');
  } finally {
    client.dispose();
  }
});

ipcMain.handle('workbench:getSnapshot', async (event) => {
  getRequestWindow(event);
  await initialWorkspaceOpen;
  return registry.getWorkbenchSnapshot();
});

ipcMain.handle('workspace:open', async (event, request: unknown) => {
  getRequestWindow(event);
  if (!isRecord(request) || typeof request.path !== 'string' || !request.path.trim()) throw new Error('Workspace path is required');
  return registry.openWorkspace(request.path);
});

ipcMain.handle('workspace:activate', async (event, reference: unknown) => {
  getRequestWindow(event);
  if (!isWorkspaceReference(reference)) throw new Error('Invalid workspace reference');
  return registry.activateWorkspace(reference);
});

ipcMain.handle('workspace:close', async (event, reference: unknown) => {
  getRequestWindow(event);
  if (!isWorkspaceReference(reference)) throw new Error('Invalid workspace reference');
  return registry.closeWorkspace(reference);
});

ipcMain.handle('workspace:request', async (event, request: unknown) => {
  getRequestWindow(event);
  if (!isRecord(request) || !isWorkspaceRequestContext(request.context)) throw new Error('Invalid workspace request context');
  if (typeof request.method !== 'string' || !isWorkspaceMethod(request.method))
    throw new Error(`Unknown workspace method: ${String(request.method)}`);
  if (request.params !== undefined && !isRecord(request.params)) throw new Error('Workspace request params must be an object');
  return registry.request(request.context, request.method, request.params as CoreMethods[typeof request.method]['params']);
});

ipcMain.handle('lsp:openConfig', async (event, request: unknown) => {
  getRequestWindow(event);
  const configPath = isRecord(request) && typeof request.configPath === 'string' ? request.configPath : undefined;
  if (!configPath) throw new Error('LSP config path is not available');
  ensureLspConfigFile(configPath);
  const error = await shell.openPath(configPath);
  if (error) throw new Error(error);
  return configPath;
});

ipcMain.handle('review-agent:start', async (event, request: unknown) => {
  getRequestWindow(event);
  if (!isReviewAgentStartRequest(request)) throw new Error('Invalid review agent start request');
  const snapshot = registry.getWorkspaceSnapshot(request.context);
  return getReviewAgentRunner(request.context).start({
    repositoryRoot: snapshot.repository.root,
    sessionId: request.sessionId,
    files: request.files,
  });
});

ipcMain.handle('review-agent:stop', async (event, context: unknown) => {
  getRequestWindow(event);
  if (!isWorkspaceRequestContext(context)) throw new Error('Invalid review agent workspace context');
  const owner = requireReviewAgentOwner(context);
  const result = await owner.runner.stop();
  owner.runner.dispose();
  reviewAgentOwner = null;
  return result;
});

ipcMain.handle('review-agent:chat', async (event, request: unknown) => {
  getRequestWindow(event);
  if (!isReviewAgentChatRequest(request)) throw new Error('Invalid review agent chat request');
  const snapshot = registry.getWorkspaceSnapshot(request.context);
  const { context: _context, ...chatRequest } = request;
  return getReviewAgentRunner(request.context).chat({ ...chatRequest, repositoryRoot: snapshot.repository.root });
});

function getReviewAgentRunner(context: WorkspaceRequestContext): ReviewAgentRunner {
  registry.getWorkspaceSnapshot(context);
  if (reviewAgentOwner) return requireReviewAgentOwner(context).runner;

  const ownerContext = context;
  const runner = new ReviewAgentRunner(async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (!isWorkspaceMethod(method)) throw new Error(`Unknown workspace method: ${method}`);
    const response = await registry.request(
      { ...ownerContext, requestId: randomUUID() },
      method,
      params as CoreMethods[typeof method]['params'],
    );
    return response.result as T;
  });
  reviewAgentOwner = { context: ownerContext, runner };
  return runner;
}

function requireReviewAgentOwner(context: WorkspaceRequestContext): NonNullable<typeof reviewAgentOwner> {
  registry.getWorkspaceSnapshot(context);
  if (!reviewAgentOwner || !matchesContext(reviewAgentOwner.context, context)) {
    throw new Error('The legacy review agent runner belongs to another workspace');
  }
  return reviewAgentOwner;
}

function matchesContext(
  first: { workspaceId: string; workspaceGeneration: string },
  second: { workspaceId: string; workspaceGeneration: string },
): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}

function isReviewAgentStartRequest(value: unknown): value is ReviewAgentStartRequest {
  return isRecord(value) && isWorkspaceRequestContext(value.context) && typeof value.sessionId === 'string' && Array.isArray(value.files);
}

function isReviewAgentChatRequest(value: unknown): value is ReviewAgentChatRequest {
  return (
    isRecord(value) &&
    isWorkspaceRequestContext(value.context) &&
    typeof value.sessionId === 'string' &&
    isRecord(value.thread) &&
    typeof value.question === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
