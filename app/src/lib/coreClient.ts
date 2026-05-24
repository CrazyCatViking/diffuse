import type { ChangedFile, DiffRenderModel, OpenRepositoryResult, VersionInfo } from './protocol'

export type DiffuseApi = {
  pickRepository(): Promise<string | null>
  getVersion(): Promise<VersionInfo>
  openRepository(path: string): Promise<OpenRepositoryResult>
  listChangedFiles(): Promise<ChangedFile[]>
  getDiffRenderModel(fileId: string, options: { mode: 'split' }): Promise<DiffRenderModel>
}

export const coreClient: DiffuseApi = {
  pickRepository: () => window.diffuse.pickRepository(),
  getVersion: () => window.diffuse.getVersion(),
  openRepository: (path) => window.diffuse.openRepository(path),
  listChangedFiles: () => window.diffuse.listChangedFiles(),
  getDiffRenderModel: (fileId, options) => window.diffuse.getDiffRenderModel(fileId, options)
}
