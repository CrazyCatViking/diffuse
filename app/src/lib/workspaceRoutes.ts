import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router';
import type { ChangedFile, ReviewThread, SyntaxSide } from './protocol';
import type { SearchResult } from './search/searchTypes';

export const workspaceRouteNames = {
  workbench: 'workbench',
  overview: 'workspace-review',
  diff: 'workspace-file',
  folderDiff: 'workspace-folder',
} as const;

export type WorkspaceRouteName = (typeof workspaceRouteNames)[keyof typeof workspaceRouteNames];

export type WorkspaceRouteState = {
  name: Exclude<WorkspaceRouteName, 'workbench'>;
  params: Record<string, string>;
  query: Record<string, string>;
};

let revealRequestId = 0;

export const routeParamString = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value.join('/');
  return value ?? '';
};

export const workbenchRoute = () => ({ name: workspaceRouteNames.workbench });

export const overviewRoute = (workspaceId: string) => ({ name: workspaceRouteNames.overview, params: { workspaceId } });

export const diffRoute = (workspaceId: string, fileId: string, query: Record<string, string | undefined> = {}) => ({
  name: workspaceRouteNames.diff,
  params: { workspaceId, fileId },
  query: withoutEmptyQueryValues(query),
});

export const folderDiffRoute = (workspaceId: string, folderPath: string) => ({
  name: workspaceRouteNames.folderDiff,
  params: { workspaceId, folderPath },
});

export const threadDiffRoute = (workspaceId: string, thread: ReviewThread) =>
  diffRoute(workspaceId, thread.fileId, {
    threadId: thread.id,
    requestId: nextRevealRequestId(),
  });

export const searchResultDiffRoute = (workspaceId: string, result: SearchResult, query: string) => {
  if (!result.fileId) return undefined;
  const target = searchResultTarget(result);
  return diffRoute(workspaceId, result.fileId, {
    search: query.trim() || undefined,
    line: target?.line === undefined ? undefined : String(target.line),
    side: target?.side,
    requestId: target ? nextRevealRequestId() : undefined,
  });
};

export const workspaceIdFromRoute = (route: RouteLocationNormalizedLoaded): string => routeParamString(route.params.workspaceId);

export const captureWorkspaceRoute = (route: RouteLocationNormalizedLoaded): WorkspaceRouteState | undefined => {
  if (
    route.name !== workspaceRouteNames.overview &&
    route.name !== workspaceRouteNames.diff &&
    route.name !== workspaceRouteNames.folderDiff
  ) {
    return undefined;
  }
  return {
    name: route.name,
    params: Object.fromEntries(
      Object.entries(route.params).map(([key, value]) => [key, routeParamString(value as string | string[] | undefined)]),
    ),
    query: Object.fromEntries(
      Object.entries(route.query)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => [key, value]),
    ),
  };
};

export const restoreWorkspaceRoute = (workspaceId: string, state?: WorkspaceRouteState): RouteLocationRaw => {
  if (!state) return overviewRoute(workspaceId);
  return {
    name: state.name,
    params: { ...state.params, workspaceId },
    query: state.query,
  };
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
