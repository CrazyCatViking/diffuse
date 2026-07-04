import type { RouteRecordRaw } from 'vue-router';
import ReviewOverviewView from './components/review/ReviewOverviewView.vue';
import DiffViewer from './components/diff/DiffViewer.vue';
import FolderDiffViewer from './components/diff/FolderDiffViewer.vue';
import { workspaceRouteNames } from './lib/workspaceRoutes';

export const routes = [
  {
    path: '/overview',
    name: workspaceRouteNames.overview,
    component: ReviewOverviewView,
  },
  {
    path: '/diff/:fileId(.*)',
    name: workspaceRouteNames.diff,
    component: DiffViewer,
  },
  {
    path: '/folder-diff/:folderPath(.*)',
    name: workspaceRouteNames.folderDiff,
    component: FolderDiffViewer,
  },
] satisfies RouteRecordRaw[];
