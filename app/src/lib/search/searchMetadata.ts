import type { ChangedFile, ReviewThread } from '../protocol';
import type { FileSearchMetadata, SearchableFile } from './searchTypes';

const generatedPathSegments = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt']);
const generatedFileNames = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'Gopkg.lock', 'Pipfile.lock']);
const docsFileNames = new Set(['readme', 'changelog', 'license', 'contributing']);
const testSegments = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);

export const changedFilePath = (file: ChangedFile): string => file.newPath ?? file.oldPath ?? file.id;

export const fileNameForPath = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

export const extensionForPath = (path: string): string => {
  const name = fileNameForPath(path);
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
};

export const buildSearchableFiles = (files: ChangedFile[], reviewedFileIds: string[], threads: ReviewThread[]): SearchableFile[] => {
  const reviewed = new Set(reviewedFileIds);
  const threadsByFile = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const current = threadsByFile.get(thread.fileId) ?? [];
    current.push(thread);
    threadsByFile.set(thread.fileId, current);
  }

  return files.map((file) => {
    const path = changedFilePath(file);
    const name = fileNameForPath(path);
    const fileThreads = threadsByFile.get(file.id) ?? [];
    const commentText = fileThreads.map(threadSearchText).join(' ');
    const metadata = classifyFile(file, path, reviewed.has(file.id), fileThreads);

    return {
      file,
      path,
      name,
      extension: extensionForPath(path),
      metadata,
      searchText: `${path} ${file.oldPath ?? ''} ${file.status} ${metadata.generated ? 'generated' : ''} ${metadata.test ? 'test' : ''} ${metadata.docs ? 'docs' : ''}`,
      commentText,
    };
  });
};

export const classifyFile = (file: ChangedFile, path: string, reviewed: boolean, threads: ReviewThread[]): FileSearchMetadata => {
  const lowerPath = path.toLowerCase();
  const name = fileNameForPath(lowerPath);
  const extension = extensionForPath(lowerPath);
  const segments = lowerPath.split('/').filter(Boolean);
  const generated =
    segments.some((segment) => generatedPathSegments.has(segment)) ||
    generatedFileNames.has(name) ||
    lowerPath.endsWith('.min.js') ||
    lowerPath.endsWith('.min.css') ||
    lowerPath.endsWith('.map') ||
    lowerPath.endsWith('.generated.go') ||
    lowerPath.endsWith('.pb.go');
  const docs =
    segments.includes('docs') ||
    extension === 'md' ||
    extension === 'rst' ||
    extension === 'adoc' ||
    docsFileNames.has(name.replace(/\.[^.]+$/, ''));
  const test =
    segments.some((segment) => testSegments.has(segment)) ||
    /(^|[._-])(test|spec)\.[^.]+$/.test(name) ||
    /\.(test|spec)\.[^.]+$/.test(name);

  return {
    reviewed,
    commentCount: threads.length,
    unresolvedCount: threads.filter((thread) => thread.status === 'open').length,
    generated,
    test,
    docs,
  };
};

export const threadSearchText = (thread: ReviewThread): string => {
  return thread.messages.map((message) => message.body).join(' ');
};
