import { describe, expect, it } from 'vitest';
import { diffRoute, folderDiffRoute, overviewRoute, restoreWorkspaceRoute, workbenchRoute, workspaceRouteNames } from './workspaceRoutes';

describe('workspace routes', () => {
  it('always includes explicit workspace identity', () => {
    expect(overviewRoute('workspace-a')).toEqual({ name: workspaceRouteNames.overview, params: { workspaceId: 'workspace-a' } });
    expect(diffRoute('workspace-a', 'src/main.ts')).toMatchObject({
      name: workspaceRouteNames.diff,
      params: { workspaceId: 'workspace-a', fileId: 'src/main.ts' },
    });
    expect(folderDiffRoute('workspace-b', 'src/lib')).toMatchObject({
      params: { workspaceId: 'workspace-b', folderPath: 'src/lib' },
    });
    expect(workbenchRoute()).toEqual({ name: workspaceRouteNames.workbench });
  });

  it('restores a saved route under the requested workspace', () => {
    expect(
      restoreWorkspaceRoute('workspace-b', {
        name: workspaceRouteNames.diff,
        params: { workspaceId: 'workspace-a', fileId: 'src/main.ts' },
        query: { line: '12' },
      }),
    ).toEqual({
      name: workspaceRouteNames.diff,
      params: { workspaceId: 'workspace-b', fileId: 'src/main.ts' },
      query: { line: '12' },
    });
  });
});
