import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { startCoreProcess } from './coreProcess'
import type { CoreRpcClient } from './coreRpcClient'

let mainWindow: BrowserWindow | null = null
let core: CoreRpcClient | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Diffuse',
    backgroundColor: '#111318',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  core = startCoreProcess()
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

ipcMain.handle('core:request', async (_event, request: { method: string; params?: Record<string, unknown> }) => {
  if (!core) throw new Error('Diffuse core is not running')
  return core.request(request.method, request.params ?? {})
})
