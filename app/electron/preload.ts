import { contextBridge, ipcRenderer } from 'electron'
import type { ChangedFile, DiffRenderModel, OpenRepositoryResult, VersionInfo } from '../src/lib/protocol'

function coreRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return ipcRenderer.invoke('core:request', { method, params })
}

contextBridge.exposeInMainWorld('diffuse', {
  pickRepository: (): Promise<string | null> => ipcRenderer.invoke('repo:pickDirectory'),
  getVersion: (): Promise<VersionInfo> => coreRequest('getVersion'),
  openRepository: (path: string): Promise<OpenRepositoryResult> => coreRequest('openRepository', { path }),
  listChangedFiles: (): Promise<ChangedFile[]> => coreRequest('listChangedFiles'),
  getDiffRenderModel: (fileId: string, options: { mode: 'split' }): Promise<DiffRenderModel> =>
    coreRequest('getDiffRenderModel', { fileId, options })
})
