import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge, ReviewAgentChatRequest, ReviewAgentStartRequest } from '../src/lib/desktopBridge';
import { isWorkbenchEvent, type WorkspaceReference, type WorkspaceRequest } from '../src/lib/workbenchContract';

const workspaceRequest: WorkspaceRequest = (context, method, ...args) => {
  return ipcRenderer.invoke('workspace:request', { context, method, params: args[0] });
};

const onWorkbenchEvent: DesktopBridge['onWorkbenchEvent'] = (listener) => {
  const handler = (_event: IpcRendererEvent, workbenchEvent: unknown) => {
    if (isWorkbenchEvent(workbenchEvent)) listener(workbenchEvent);
  };
  ipcRenderer.on('workbench:event', handler);
  return () => ipcRenderer.off('workbench:event', handler);
};

const pickRepository = () => {
  return ipcRenderer.invoke('repo:pickDirectory');
};

const getVersion = () => {
  return ipcRenderer.invoke('app:getVersion');
};

const getWorkbenchSnapshot = () => {
  return ipcRenderer.invoke('workbench:getSnapshot');
};

const openWorkspace = (path: string) => {
  return ipcRenderer.invoke('workspace:open', { path });
};

const activateWorkspace = (reference: WorkspaceReference | null) => {
  return ipcRenderer.invoke('workspace:activate', reference);
};

const closeWorkspace = (reference: WorkspaceReference) => {
  return ipcRenderer.invoke('workspace:close', reference);
};

const openLspConfig = (configPath?: string) => {
  return ipcRenderer.invoke('lsp:openConfig', { configPath });
};

const startReviewAgent = (request: ReviewAgentStartRequest) => {
  return ipcRenderer.invoke('review-agent:start', request);
};

const stopReviewAgent: DesktopBridge['stopReviewAgent'] = (context) => {
  return ipcRenderer.invoke('review-agent:stop', context);
};

const chatWithReviewAgent = (request: ReviewAgentChatRequest) => {
  return ipcRenderer.invoke('review-agent:chat', request);
};

const bridge = {
  pickRepository,
  openLspConfig,
  getVersion,
  getWorkbenchSnapshot,
  openWorkspace,
  activateWorkspace,
  closeWorkspace,
  workspaceRequest,
  onWorkbenchEvent,
  startReviewAgent,
  stopReviewAgent,
  chatWithReviewAgent,
} satisfies DesktopBridge;

contextBridge.exposeInMainWorld('diffuse', bridge);
