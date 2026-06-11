import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { isCoreMethod, type CoreRequest } from '../src/lib/coreApi'
import { startCoreProcess } from './coreProcess'
import { CoreRequestTimeoutError, type CoreRpcClient } from './coreRpcClient'

let mainWindow: BrowserWindow | null = null
let core: CoreRpcClient | null = null

function getCore(): CoreRpcClient {
  if (core?.isRunning) return core

  core = startCoreProcess()
  core.once('exit', () => {
    core = null
  })
  return core
}

async function coreRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await getCore().request<T>(method, params)
  } catch (error) {
    if (!(error instanceof CoreRequestTimeoutError)) throw error

    core?.dispose()
    core = null
    return getCore().request<T>(method, params)
  }
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
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script ${preloadPath}:`, error)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  getCore()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  core?.dispose()
})

ipcMain.handle('repo:pickDirectory', async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Repository',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('core:request', async (_event, request: CoreRequest) => {
  if (!isCoreMethod(request.method)) {
    throw new Error(`Unknown core method: ${request.method}`)
  }

  return coreRequest(request.method, request.params ?? {})
})
