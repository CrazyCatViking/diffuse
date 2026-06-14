import { ChangedFile, DiffRenderModel, DiffRenderOptions, InstallTreeSitterGrammarResult, OpenRepositoryResult, SyntaxLineSpans, SyntaxSide, TreeSitterGrammar, UninstallTreeSitterGrammarResult, VersionInfo } from "./protocol";

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

  const getSyntaxSpans = async (fileId: string, side: SyntaxSide, startLine: number, endLine: number, options: Pick<DiffRenderOptions, 'context'>): Promise<SyntaxLineSpans[]> => {
    return window.diffuse.coreRequest('getSyntaxSpans', { fileId, side, startLine, endLine, options });
  };

  const installTreeSitterGrammar = async (language: string): Promise<InstallTreeSitterGrammarResult> => {
    return window.diffuse.coreRequest('installTreeSitterGrammar', { language });
  };

  const listTreeSitterGrammars = async (): Promise<TreeSitterGrammar[]> => {
    return window.diffuse.coreRequest('listTreeSitterGrammars');
  };

  const uninstallTreeSitterGrammar = async (language: string): Promise<UninstallTreeSitterGrammarResult> => {
    return window.diffuse.coreRequest('uninstallTreeSitterGrammar', { language });
  };
     
  return {
    pickRepository,     
    getVersion,
    openRepository,
    listChangedFiles,
    getDiffRenderModel,
    getSyntaxSpans,
    installTreeSitterGrammar,
    listTreeSitterGrammars,
    uninstallTreeSitterGrammar
  };
};
