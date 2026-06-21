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

const getLaunchRepository = () => {
  return ipcRenderer.invoke('app:getLaunchRepository');
};

const openLspConfig = (configPath?: string) => {
  return ipcRenderer.invoke('lsp:openConfig', { configPath });
};

const startReviewAgent = (request: unknown) => {
  return ipcRenderer.invoke('review-agent:start', request);
};

const stopReviewAgent = () => {
  return ipcRenderer.invoke('review-agent:stop');
};

const chatWithReviewAgent = (request: unknown) => {
  return ipcRenderer.invoke('review-agent:chat', request);
};

const bridge = {
  pickRepository,
  getLaunchRepository,
  openLspConfig,
  coreRequest,
  onCoreEvent,
  startReviewAgent,
  stopReviewAgent,
  chatWithReviewAgent
};

contextBridge.exposeInMainWorld('diffuse', bridge);
