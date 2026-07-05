import type { ChangedFile, ReviewThread, SyntaxSide } from './protocol';
import type { SearchResult } from './search/searchTypes';

export const workspaceRouteNames = {
  overview: 'overview',
  diff: 'diff',
  folderDiff: 'folder-diff',
} as const;

export type WorkspaceRouteName = (typeof workspaceRouteNames)[keyof typeof workspaceRouteNames];

let revealRequestId = 0;

export const routeParamString = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value.join('/');
  return value ?? '';
};

export const overviewRoute = () => ({ name: workspaceRouteNames.overview });

export const diffRoute = (fileId: string, query: Record<string, string | undefined> = {}) => ({
  name: workspaceRouteNames.diff,
  params: { fileId },
  query: withoutEmptyQueryValues(query),
});

export const folderDiffRoute = (folderPath: string) => ({
  name: workspaceRouteNames.folderDiff,
  params: { folderPath },
});

export const threadDiffRoute = (thread: ReviewThread) =>
  diffRoute(thread.fileId, {
    threadId: thread.id,
    requestId: nextRevealRequestId(),
  });

export const searchResultDiffRoute = (result: SearchResult, query: string) => {
  if (!result.fileId) return undefined;
  const target = searchResultTarget(result);
  return diffRoute(result.fileId, {
    search: query.trim() || undefined,
    line: target?.line === undefined ? undefined : String(target.line),
    side: target?.side,
    requestId: target ? nextRevealRequestId() : undefined,
  });
};

export const changedFilePath = (file: ChangedFile) => file.newPath ?? file.oldPath ?? file.id;

export const sortFilesLikeSidebar = (files: ChangedFile[]) => {
  return [...files].sort((first, second) => compareSidebarPaths(changedFilePath(first), changedFilePath(second)));
};

export const filesForFolderPath = (files: ChangedFile[], folderPath: string) => {
  return sortFilesLikeSidebar(files.filter((file) => changedFilePath(file).startsWith(`${folderPath}/`)));
};

const searchResultTarget = (result: SearchResult): { line?: number; side?: SyntaxSide } | undefined => {
  return result.kind === 'content' || result.kind === 'symbol' ? { line: result.line, side: result.side } : undefined;
};

const nextRevealRequestId = () => String(++revealRequestId);

const withoutEmptyQueryValues = (query: Record<string, string | undefined>) => {
  return Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])));
};

const compareSidebarPaths = (firstPath: string, secondPath: string) => {
  const firstParts = firstPath.split('/').filter(Boolean);
  const secondParts = secondPath.split('/').filter(Boolean);
  const length = Math.min(firstParts.length, secondParts.length);

  for (let index = 0; index < length; index += 1) {
    if (firstParts[index] === secondParts[index]) continue;

    const firstIsFolder = index < firstParts.length - 1;
    const secondIsFolder = index < secondParts.length - 1;
    if (firstIsFolder !== secondIsFolder) return firstIsFolder ? -1 : 1;

    return firstParts[index].localeCompare(secondParts[index]);
  }

  return firstParts.length - secondParts.length;
};
