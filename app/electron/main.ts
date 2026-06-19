import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startCoreProcess } from './coreProcess';
import { CoreRequestTimeoutError, type CoreEvent, type CoreRpcClient } from './coreRpcClient';
import { ReviewAgentRunner } from './reviewAgentRunner';

let mainWindow: BrowserWindow | null = null;
let core: CoreRpcClient | null = null;
let reviewAgentRunner: ReviewAgentRunner | null = null;

const allowedCoreMethods = new Set([
  'getVersion',
  'openRepository',
  'getDiffTargetDefaults',
  'listBranches',
  'listChangedFiles',
  'getDiffRenderModel',
  'getSyntaxSpans',
  'getLspConfigInfo',
  'getLspInstallInfo',
  'installLspServer',
  'restartLspServer',
  'getLspStatus',
  'getLspHover',
  'getLspDiagnostics',
  'getReviewConfig',
  'saveReviewConfig',
  'getActiveReviewSession',
  'listReviewSessions',
  'createReviewSession',
  'getReviewProgress',
  'saveReviewProgress',
  'getReviewAgentStates',
  'saveReviewAgentState',
  'getReviewRuns',
  'recoverStaleReviewRuns',
  'saveReviewRun',
  'createReviewRun',
  'updateReviewRun',
  'finishReviewRun',
  'getReviewThreads',
  'getReviewChatMessages',
  'saveReviewChatMessage',
  'addReviewComment',
  'saveReviewThread',
  'listTreeSitterGrammars',
  'syncTreeSitterRegistry',
  'installTreeSitterGrammar',
  'uninstallTreeSitterGrammar'
]);

function getCore(): CoreRpcClient {
  if (core?.isRunning) return core;

  core = startCoreProcess();
  core.on('event', (event: CoreEvent) => {
    mainWindow?.webContents.send('core:event', event);
  });
  core.once('exit', () => {
    core = null;
  });
  return core;
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

async function coreRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await getCore().request<T>(method, params, requestTimeoutMs(method), { killOnTimeout: shouldKillCoreOnTimeout(method) });
  } catch (error) {
    if (!(error instanceof CoreRequestTimeoutError)) throw error;
    if (!shouldKillCoreOnTimeout(method)) throw error;

    core?.dispose();
    core = null;
    return getCore().request<T>(method, params, requestTimeoutMs(method), { killOnTimeout: shouldKillCoreOnTimeout(method) });
  }
}

function getReviewAgentRunner(): ReviewAgentRunner {
  reviewAgentRunner ??= new ReviewAgentRunner(coreRequest);
  return reviewAgentRunner;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
      sandbox: false
    }
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script ${preloadPath}:`, error);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  getCore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  reviewAgentRunner?.dispose();
  core?.dispose();
});

function ensureLspConfigFile(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) return;

  writeFileSync(configPath, `${JSON.stringify({
    lsp: {
      zig: {
        command: 'zls',
        args: []
      }
    }
  }, null, 2)}\n`);
}

ipcMain.handle('repo:pickDirectory', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Repository',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('core:request', async (_event, request: { method: string; params?: Record<string, unknown> }) => {
  if (!allowedCoreMethods.has(request.method)) {
    throw new Error(`Unknown core method: ${request.method}`);
  }

  return coreRequest(request.method, request.params ?? {});
});

ipcMain.handle('lsp:openConfig', async (_event, request: { configPath?: string }) => {
  const configPath = request.configPath;
  if (!configPath) throw new Error('LSP config path is not available');
  ensureLspConfigFile(configPath);
  const error = await shell.openPath(configPath);
  if (error) throw new Error(error);
  return configPath;
});

ipcMain.handle('review-agent:start', async (_event, request: { repositoryRoot: string; sessionId: string; files: unknown[] }) => {
  return getReviewAgentRunner().start(request as Parameters<ReviewAgentRunner['start']>[0]);
});

ipcMain.handle('review-agent:stop', async () => {
  return getReviewAgentRunner().stop();
});

ipcMain.handle('review-agent:chat', async (_event, request: Parameters<ReviewAgentRunner['chat']>[0]) => {
  return getReviewAgentRunner().chat(request);
});
