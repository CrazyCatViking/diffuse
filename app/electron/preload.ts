import { contextBridge, ipcRenderer } from 'electron'

export type DiffuseBridge = typeof bridge;

// Should add an allowed methods guard here

const coreRequest = (method: string, params?: unknown) => {
  return ipcRenderer.invoke('core:request', { method, params });
}

const pickRepository = () => {
  return ipcRenderer.invoke('repo:pickDirectory');
}

const bridge = {
  pickRepository,
  coreRequest
}

contextBridge.exposeInMainWorld('diffuse', bridge)
