import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useClient } from '../lib/useClient';
import type { ChangedFile, DiffTarget, ReviewAnchor, ReviewMessage, ReviewProgress, ReviewSession, ReviewThread } from '../lib/protocol';
import { useRepoStore } from './repo';

const humanParticipantId = 'local-human';

export const useReviewStore = defineStore('review', () => {
  const client = useClient();
  const repo = useRepoStore();
  const session = ref<ReviewSession | null>(null);
  const sessions = ref<ReviewSession[]>([]);
  const progress = ref<ReviewProgress | null>(null);
  const threads = ref<ReviewThread[]>([]);
  const loading = ref(false);
  const error = ref<string>();
  const draftAnchor = ref<ReviewAnchor>();
  const draftFile = ref<ChangedFile>();

  const openThreads = computed(() => threads.value.filter((thread) => thread.status === 'open'));

  const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
    return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
  };

  window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'review/changed') return;
    if (!event.params || typeof event.params !== 'object') return;

    const params = event.params as { root?: unknown; sessionId?: unknown };
    if (params.root !== repo.repository?.root) return;
    if (typeof params.sessionId === 'string' && session.value?.id && params.sessionId !== session.value.id) return;
    void refreshReviewState();
  });

  const ensureSession = async () => {
    if (!repo.repository) return;
    loading.value = true;
    error.value = undefined;

    try {
      const active = await client.getActiveReviewSession();
      session.value = active ?? await client.createReviewSession(newSession(repo.repository.root, repo.repository.head, repo.diffTarget));
      await refreshReviewState();
    } catch (err) {
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
    } finally {
      loading.value = false;
    }
  };

  const loadThreads = async () => {
    if (!session.value) {
      threads.value = [];
      return;
    }

    threads.value = await client.getReviewThreads(session.value.id);
  };

  const loadSessions = async () => {
    if (!repo.repository) {
      sessions.value = [];
      return;
    }

    sessions.value = await client.listReviewSessions();
  };

  const loadProgress = async () => {
    if (!session.value) {
      progress.value = null;
      return;
    }

    progress.value = await client.getReviewProgress(session.value.id);
  };

  const refreshReviewState = async () => {
    await Promise.all([loadSessions(), loadThreads(), loadProgress()]);
  };

  const startDraft = (file: ChangedFile, anchor: ReviewAnchor) => {
    draftFile.value = file;
    draftAnchor.value = anchor;
  };

  const cancelDraft = () => {
    draftFile.value = undefined;
    draftAnchor.value = undefined;
  };

  const createThread = async (body: string) => {
    if (!session.value) await ensureSession();
    if (!session.value || !draftFile.value || !draftAnchor.value) return false;
    const text = body.trim();
    if (!text) return false;

    const now = new Date().toISOString();
    const message: ReviewMessage = {
      id: createId('msg'),
      authorId: humanParticipantId,
      body: text,
      createdAt: now,
    };
    const thread: ReviewThread = {
      id: createId('thread'),
      sessionId: session.value.id,
      fileId: draftFile.value.id,
      oldPath: draftFile.value.oldPath ?? undefined,
      newPath: draftFile.value.newPath ?? undefined,
      anchor: draftAnchor.value,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      messages: [message],
    };

    try {
      const saved = await client.saveReviewThread(session.value.id, thread);
      threads.value = [...threads.value.filter((item) => item.id !== saved.id), saved];
      cancelDraft();
      error.value = undefined;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    }
  };

  const addMessage = async (thread: ReviewThread, body: string) => {
    if (!session.value) return false;
    const text = body.trim();
    if (!text) return false;

    const now = new Date().toISOString();
    const message: ReviewMessage = {
      id: createId('msg'),
      authorId: humanParticipantId,
      body: text,
      createdAt: now,
    };
    const updated: ReviewThread = {
      ...thread,
      status: 'open',
      updatedAt: now,
      messages: [...thread.messages, message],
    };

    try {
      const saved = await client.saveReviewThread(session.value.id, updated);
      threads.value = threads.value.map((item) => item.id === saved.id ? saved : item);
      error.value = undefined;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    }
  };

  const resolveThread = async (thread: ReviewThread) => {
    if (!session.value) return;
    const updated = { ...thread, status: 'resolved' as const, updatedAt: new Date().toISOString() };
    const saved = await client.saveReviewThread(session.value.id, updated);
    threads.value = threads.value.map((item) => item.id === saved.id ? saved : item);
  };

  const reopenThread = async (thread: ReviewThread) => {
    if (!session.value) return;
    const updated = { ...thread, status: 'open' as const, updatedAt: new Date().toISOString() };
    const saved = await client.saveReviewThread(session.value.id, updated);
    threads.value = threads.value.map((item) => item.id === saved.id ? saved : item);
  };

  const threadCountForAnchor = (fileId: string, side: 'old' | 'new', line: number) => {
    return openThreads.value.filter((thread) => {
      return thread.fileId === fileId && thread.anchor.side === side && line >= thread.anchor.startLine && line <= thread.anchor.endLine;
    }).length;
  };

  const clear = () => {
    session.value = null;
    sessions.value = [];
    progress.value = null;
    threads.value = [];
    error.value = undefined;
    cancelDraft();
  };

  return {
    session,
    sessions,
    progress,
    threads,
    openThreads,
    loading,
    error,
    draftAnchor,
    draftFile,
    ensureSession,
    loadSessions,
    loadProgress,
    refreshReviewState,
    loadThreads,
    startDraft,
    cancelDraft,
    createThread,
    addMessage,
    resolveThread,
    reopenThread,
    threadCountForAnchor,
    clear,
  };
});

const newSession = (repositoryRoot: string, headAtCreation: string, target: DiffTarget): ReviewSession => {
  const now = new Date().toISOString();
  return {
    id: createId('session'),
    repositoryRoot,
    target: { ...target },
    headAtCreation,
    createdAt: now,
    updatedAt: now,
    title: 'Local review',
    status: 'active',
    participants: [{ id: humanParticipantId, kind: 'human', displayName: 'You' }],
  };
};

const createId = (prefix: string) => {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}-${random}`;
};
