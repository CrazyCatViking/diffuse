import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { startCoreProcess } from './coreProcess';
import { CoreRequestTimeoutError, type CoreRpcClient } from './coreRpcClient';
import { ReviewAgentRunner } from './reviewAgentRunner';
import { coreMethodNames, type CoreEvent, type CoreMethod, type CoreMethods } from '../src/lib/coreContract';

type WindowState = {
  window: BrowserWindow;
  launchRepository?: string;
  repositoryRoot?: string;
  core: CoreRpcClient | null;
  reviewAgentRunner: ReviewAgentRunner | null;
};

const windowStates = new Map<number, WindowState>();

if (!app.requestSingleInstanceLock({ cwd: process.cwd() })) {
  app.exit(0);
}

const allowedCoreMethods = new Set<CoreMethod>(coreMethodNames);

function getCore(state: WindowState): CoreRpcClient {
  if (state.core?.isRunning) return state.core;

  state.core = startCoreProcess();
  state.core.on('event', (event: CoreEvent) => {
    if (!state.window.isDestroyed()) state.window.webContents.send('core:event', event);
  });
  state.core.once('exit', () => {
    state.core = null;
  });
  return state.core;
}

function isCoreMethod(method: string): method is CoreMethod {
  return allowedCoreMethods.has(method as CoreMethod);
}

function requestTimeoutMs(method: string): number {
  if (method === 'installTreeSitterGrammar') return 5 * 60_000;
  if (method === 'syncTreeSitterRegistry') return 2 * 60_000;
  if (method === 'getSyntaxSpans') return 10_000;
  if (method === 'getLspHover') return 10_000;
  if (method === 'getLspDiagnostics') return 10_000;
  return 30_000;
}

function shouldKillCoreOnTimeout(method: string): boolean {
  return method !== 'getSyntaxSpans' && method !== 'getLspHover' && method !== 'getLspDiagnostics';
}

async function coreRequest<M extends CoreMethod>(
  state: WindowState,
  method: M,
  params: CoreMethods[M]['params'] = {} as CoreMethods[M]['params'],
): Promise<CoreMethods[M]['result']> {
  try {
    return await getCore(state).request<CoreMethods[M]['result']>(method, params, requestTimeoutMs(method), {
      killOnTimeout: shouldKillCoreOnTimeout(method),
    });
  } catch (error) {
    if (!(error instanceof CoreRequestTimeoutError)) throw error;
    if (!shouldKillCoreOnTimeout(method)) throw error;

    state.core?.dispose();
    state.core = null;
    return getCore(state).request<CoreMethods[M]['result']>(method, params, requestTimeoutMs(method), {
      killOnTimeout: shouldKillCoreOnTimeout(method),
    });
  }
}

function getReviewAgentRunner(state: WindowState): ReviewAgentRunner {
  state.reviewAgentRunner ??= new ReviewAgentRunner(async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (!isCoreMethod(method)) throw new Error(`Unknown core method: ${method}`);
    return (await coreRequest(state, method, params as CoreMethods[typeof method]['params'])) as T;
  });
  return state.reviewAgentRunner;
}

function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function focusExistingRepositoryWindow(path: string): boolean {
  for (const state of windowStates.values()) {
    if (state.repositoryRoot !== path && state.launchRepository !== path) continue;
    focusWindow(state.window);
    return true;
  }
  return false;
}

function createWindow(launchRepository?: string): WindowState {
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

  const state: WindowState = {
    window,
    launchRepository,
    core: null,
    reviewAgentRunner: null,
  };
  windowStates.set(window.id, state);

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script ${preloadPath}:`, error);
  });

  window.on('closed', () => {
    state.reviewAgentRunner?.dispose();
    state.core?.dispose();
    windowStates.delete(window.id);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  getCore(state);
  return state;
}

function parseLaunchRepository(args: string[], cwd = process.cwd()): string | undefined {
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
  createWindow(parseLaunchRepository(process.argv));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
  const cwd = isCwdPayload(additionalData) ? additionalData.cwd : workingDirectory;
  const launchPath = parseLaunchRepository(argv, cwd);
  const openWindow = () => {
    if (launchPath && focusExistingRepositoryWindow(launchPath)) return;
    const state = createWindow(launchPath);
    focusWindow(state.window);
  };
  if (app.isReady()) openWindow();
  else void app.whenReady().then(openWindow);
});

function isCwdPayload(value: unknown): value is { cwd: string } {
  return typeof value === 'object' && value !== null && 'cwd' in value && typeof value.cwd === 'string';
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const state of windowStates.values()) {
    state.reviewAgentRunner?.dispose();
    state.core?.dispose();
  }
});

function getWindowState(event: IpcMainInvokeEvent): WindowState {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Could not resolve request window');
  const state = windowStates.get(window.id);
  if (!state) throw new Error('Could not resolve window state');
  return state;
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
  const state = getWindowState(event);

  const result = await dialog.showOpenDialog(state.window, {
    title: 'Open Repository',
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:getLaunchRepository', async (event) => {
  return getWindowState(event).launchRepository ?? null;
});

ipcMain.handle('core:request', async (event, request: { method: string; params?: Record<string, unknown> }) => {
  if (!isCoreMethod(request.method)) {
    throw new Error(`Unknown core method: ${request.method}`);
  }

  const state = getWindowState(event);
  const result = await coreRequest(state, request.method, request.params ?? {});
  if (request.method === 'openRepository' && isOpenRepositoryResult(result)) {
    state.repositoryRoot = result.root;
  }
  return result;
});

function isOpenRepositoryResult(value: unknown): value is { root: string } {
  return typeof value === 'object' && value !== null && 'root' in value && typeof value.root === 'string';
}

ipcMain.handle('lsp:openConfig', async (_event, request: { configPath?: string }) => {
  const configPath = request.configPath;
  if (!configPath) throw new Error('LSP config path is not available');
  ensureLspConfigFile(configPath);
  const error = await shell.openPath(configPath);
  if (error) throw new Error(error);
  return configPath;
});

ipcMain.handle('review-agent:start', async (event, request: { repositoryRoot: string; sessionId: string; files: unknown[] }) => {
  return getReviewAgentRunner(getWindowState(event)).start(request as Parameters<ReviewAgentRunner['start']>[0]);
});

ipcMain.handle('review-agent:stop', async (event) => {
  return getReviewAgentRunner(getWindowState(event)).stop();
});

ipcMain.handle('review-agent:chat', async (event, request: Parameters<ReviewAgentRunner['chat']>[0]) => {
  return getReviewAgentRunner(getWindowState(event)).chat(request);
});
