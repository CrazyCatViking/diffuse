import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export type DiffuseBridge = typeof bridge;

// Should add an allowed methods guard here

const coreRequest = (method: string, params?: unknown) => {
  return ipcRenderer.invoke('core:request', { method, params });
};

const onCoreEvent = (listener: (event: unknown) => void) => {
  const handler = (_event: IpcRendererEvent, coreEvent: unknown) => listener(coreEvent);
  ipcRenderer.on('core:event', handler);
  return () => ipcRenderer.off('core:event', handler);
};

const pickRepository = () => {
  return ipcRenderer.invoke('repo:pickDirectory');
};

const bridge = {
  pickRepository,
  coreRequest,
  onCoreEvent
};

contextBridge.exposeInMainWorld('diffuse', bridge);
