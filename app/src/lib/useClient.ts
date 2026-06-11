import { ChangedFile, DiffRenderModel, DiffRenderOptions, OpenRepositoryResult, VersionInfo } from "./protocol";

export const useClient = () => {
  const pickRepository = async (): Promise<string | null> => {
    return window.diffuse.pickRepository();
  };

  const getVersion = async (): Promise<VersionInfo> => {
    return window.diffuse.coreRequest('getVersion');
  };

  const openRepository = async (path: string): Promise<OpenRepositoryResult> => {
    return window.diffuse.coreRequest('openRepository', { path });
  };

  const listChangedFiles = async (): Promise<ChangedFile[]> => {
    return window.diffuse.coreRequest('listChangedFiles');
  };

  const getDiffRenderModel = async (fileId: string, options: DiffRenderOptions): Promise<DiffRenderModel> => {
    return window.diffuse.coreRequest('getDiffRenderModel', { fileId, options });
  };
    
  return {
    pickRepository,     
    getVersion,
    openRepository,
    listChangedFiles,
    getDiffRenderModel
  };
}
