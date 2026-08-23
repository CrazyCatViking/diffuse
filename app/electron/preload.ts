import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CoreEvent, CoreRequest } from '../src/lib/coreContract';
import type { DesktopBridge, ReviewAgentChatRequest, ReviewAgentStartRequest } from '../src/lib/desktopBridge';

const coreRequest: CoreRequest = (method, ...args) => {
  return ipcRenderer.invoke('core:request', { method, params: args[0] });
};

const onCoreEvent = (listener: (event: CoreEvent) => void) => {
  const handler = (_event: IpcRendererEvent, coreEvent: CoreEvent) => listener(coreEvent);
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

const startReviewAgent = (request: ReviewAgentStartRequest) => {
  return ipcRenderer.invoke('review-agent:start', request);
};

const stopReviewAgent = () => {
  return ipcRenderer.invoke('review-agent:stop');
};

const chatWithReviewAgent = (request: ReviewAgentChatRequest) => {
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
  chatWithReviewAgent,
} satisfies DesktopBridge;

contextBridge.exposeInMainWorld('diffuse', bridge);
