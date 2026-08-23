import type { RouteRecordRaw } from 'vue-router';
import ReviewOverviewView from './components/review/ReviewOverviewView.vue';
import DiffViewer from './components/diff/DiffViewer.vue';
import FolderDiffViewer from './components/diff/FolderDiffViewer.vue';
import WorkbenchOverview from './components/workbench/WorkbenchOverview.vue';
import { workspaceRouteNames } from './lib/workspaceRoutes';

export const routes = [
  { path: '/', redirect: '/workbench' },
  { path: '/workbench', name: workspaceRouteNames.workbench, component: WorkbenchOverview },
  { path: '/w/:workspaceId/review', name: workspaceRouteNames.overview, component: ReviewOverviewView },
  { path: '/w/:workspaceId/file/:fileId(.*)', name: workspaceRouteNames.diff, component: DiffViewer },
  { path: '/w/:workspaceId/folder/:folderPath(.*)', name: workspaceRouteNames.folderDiff, component: FolderDiffViewer },
  { path: '/:pathMatch(.*)*', redirect: '/workbench' },
] satisfies RouteRecordRaw[];
