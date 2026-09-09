import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { getActiveWorkspace, isActiveWorkspace, useClient } from '../lib/useClient';
import { useReviewAcpStore } from './reviewAcp';
import { useWorkbenchStore } from './workbench';
import type {
  ChangedFile,
  DiffTarget,
  ReviewedFilesState,
  ReviewedFilesUpdate,
  ReviewAgentState,
  ReviewAnchor,
  ReviewChatMessage,
  ReviewMessage,
  ReviewProgress,
  ReviewRun,
  ReviewSession,
  ReviewThread,
} from '../lib/protocol';
import { useRepoStore } from './repo';

const humanParticipantId = 'local-human';

export const useReviewStore = defineStore('review', () => {
  const client = useClient();
  const repo = useRepoStore();
  const workbench = useWorkbenchStore();
  const acpReview = useReviewAcpStore();
  const agentAdapter = computed({
    get: () => {
      const value = workbench.activeWorkspaceId ? workbench.uiState(workbench.activeWorkspaceId).reviewAgentAdapter : '';
      return value?.startsWith('acp:') ? value : '';
    },
    set: (value: string) => {
      const id = workbench.activeWorkspaceId;
      if (id) workbench.saveUiState(id, { ...workbench.uiState(id), reviewAgentAdapter: value });
    },
  });
  const session = ref<ReviewSession | null>(null);
  watch(
    () => [session.value?.id, workbench.activeWorkspaceId],
    () => {
      void acpReview.activate(getActiveWorkspace(), session.value?.id);
    },
  );
  const sessions = ref<ReviewSession[]>([]);
  const progress = ref<ReviewProgress | null>(null);
  const reviewedFiles = ref<ReviewedFilesState>({ files: {} });
  const runs = ref<ReviewRun[]>([]);
  const agentStates = ref<ReviewAgentState[]>([]);
  const threads = ref<ReviewThread[]>([]);
  const chatMessages = ref<ReviewChatMessage[]>([]);
  const loading = ref(false);
  const error = ref<string>();
  const draftAnchor = ref<ReviewAnchor>();
  const draftFile = ref<ChangedFile>();
  const draftMode = ref<'comment' | 'chat'>('comment');
  const draftBody = ref('');
  const replyDrafts = ref<Record<string, string>>({});
  let reviewedFilesMutation = Promise.resolve();
  let reviewedFilesVersion = 0;
  let workspaceEpoch = 0;

  const openThreads = computed(() => threads.value.filter((thread) => thread.status === 'open'));

  window.diffuse.onWorkbenchEvent((event) => {
    if (event.kind !== 'review/changed' || !isActiveWorkspace(event)) return;
    if (event.payload.root !== repo.repository?.root) return;
    if (event.payload.sessionId && session.value?.id && event.payload.sessionId !== session.value.id) return;
    const epoch = workspaceEpoch;
    void refreshReviewState().catch((err) => {
      if (epoch === workspaceEpoch) error.value = err instanceof Error ? err.message : JSON.stringify(err);
    });
  });

  const ensureSession = async () => {
    if (!repo.repository) return;
    const epoch = workspaceEpoch;
    const repository = repo.repository;
    loading.value = true;
    error.value = undefined;

    try {
      const active = await client.getActiveReviewSession();
      const next = active ?? (await client.createReviewSession(newSession(repository.root, repository.head, repo.diffTarget)));
      if (epoch !== workspaceEpoch) return;
      session.value = next;
      await refreshReviewState();
    } catch (err) {
      if (epoch !== workspaceEpoch) return;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
    } finally {
      if (epoch === workspaceEpoch) loading.value = false;
    }
  };

  const loadThreads = async () => {
    if (!session.value) {
      threads.value = [];
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.getReviewThreads(session.value.id);
    if (epoch === workspaceEpoch) threads.value = loaded;
  };

  const loadChatMessages = async () => {
    if (!session.value) {
      chatMessages.value = [];
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.getReviewChatMessages(session.value.id);
    if (epoch === workspaceEpoch) chatMessages.value = loaded.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  };

  const loadSessions = async () => {
    if (!repo.repository) {
      sessions.value = [];
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.listReviewSessions();
    if (epoch === workspaceEpoch) sessions.value = loaded;
  };

  const loadProgress = async () => {
    if (!session.value) {
      progress.value = null;
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.getReviewProgress(session.value.id);
    if (epoch === workspaceEpoch) progress.value = loaded;
  };

  const loadReviewedFiles = async () => {
    if (!session.value) {
      reviewedFiles.value = { files: {} };
      return;
    }

    const sessionId = session.value.id;
    const epoch = workspaceEpoch;
    await reviewedFilesMutation.catch(() => undefined);
    const version = reviewedFilesVersion;
    const loaded = await client.getReviewedFiles(sessionId);
    if (epoch === workspaceEpoch && session.value?.id === sessionId && reviewedFilesVersion === version) reviewedFiles.value = loaded;
  };

  const loadRuns = async () => {
    if (!session.value) {
      runs.value = [];
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.getReviewRuns(session.value.id);
    if (epoch === workspaceEpoch) runs.value = loaded;
  };

  const loadAgentStates = async () => {
    if (!session.value) {
      agentStates.value = [];
      return;
    }

    const epoch = workspaceEpoch;
    const loaded = await client.getReviewAgentStates(session.value.id);
    if (epoch === workspaceEpoch) agentStates.value = loaded;
  };

  const refreshReviewState = async () => {
    await Promise.all([
      loadSessions(),
      loadThreads(),
      loadProgress(),
      loadReviewedFiles(),
      loadRuns(),
      loadAgentStates(),
      loadChatMessages(),
    ]);
  };

  const selectSession = async (sessionId: string) => {
    if (!repo.repository) throw new Error('Cannot select a review session without an active repository');
    const epoch = ++workspaceEpoch;
    loading.value = true;
    error.value = undefined;
    try {
      const loadedSessions = await client.listReviewSessions();
      const selected = loadedSessions.find((item) => item.id === sessionId);
      if (!selected) throw new Error(`Review session not found: ${sessionId}`);
      const [loadedProgress, loadedReviewedFiles, loadedRuns, loadedAgentStates, loadedChatMessages, loadedThreads] = await Promise.all([
        client.getReviewProgress(sessionId),
        client.getReviewedFiles(sessionId),
        client.getReviewRuns(sessionId),
        client.getReviewAgentStates(sessionId),
        client.getReviewChatMessages(sessionId),
        client.getReviewThreads(sessionId),
      ]);
      if (epoch !== workspaceEpoch) throw new Error(`Review session selection superseded: ${sessionId}`);
      sessions.value = loadedSessions;
      session.value = selected;
      progress.value = loadedProgress;
      reviewedFiles.value = loadedReviewedFiles;
      runs.value = loadedRuns;
      agentStates.value = loadedAgentStates;
      chatMessages.value = loadedChatMessages.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
      threads.value = loadedThreads;
      cancelDraft();
    } catch (err) {
      if (epoch === workspaceEpoch) error.value = err instanceof Error ? err.message : JSON.stringify(err);
      throw err;
    } finally {
      if (epoch === workspaceEpoch) loading.value = false;
    }
  };

  const startNewSession = async () => {
    if (!repo.repository) return false;
    const epoch = workspaceEpoch;
    const repository = repo.repository;
    loading.value = true;
    error.value = undefined;

    try {
      const created = await client.createReviewSession(newSession(repository.root, repository.head, repo.diffTarget));
      if (epoch !== workspaceEpoch) return false;
      session.value = created;
      await refreshReviewState();
      cancelDraft();
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    } finally {
      if (epoch === workspaceEpoch) loading.value = false;
    }
  };

  const startDraft = (file: ChangedFile, anchor: ReviewAnchor, mode: 'comment' | 'chat' = 'comment') => {
    draftFile.value = file;
    draftAnchor.value = anchor;
    draftMode.value = mode;
  };

  const cancelDraft = () => {
    draftFile.value = undefined;
    draftAnchor.value = undefined;
    draftMode.value = 'comment';
    draftBody.value = '';
  };

  const createThread = async (body: string) => {
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value || !draftFile.value || !draftAnchor.value) return false;
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
      if (epoch !== workspaceEpoch) return false;
      threads.value = [...threads.value.filter((item) => item.id !== saved.id), saved];
      cancelDraft();
      error.value = undefined;
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    }
  };

  const addMessage = async (thread: ReviewThread, body: string) => {
    if (!session.value) return false;
    const text = body.trim();
    if (!text) return false;
    const epoch = workspaceEpoch;

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
      if (epoch !== workspaceEpoch) return false;
      threads.value = threads.value.map((item) => (item.id === saved.id ? saved : item));
      error.value = undefined;
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    }
  };

  const resolveThread = async (thread: ReviewThread) => {
    if (!session.value) return;
    const updated = { ...thread, status: 'resolved' as const, updatedAt: new Date().toISOString() };
    const saved = await client.saveReviewThread(session.value.id, updated);
    threads.value = threads.value.map((item) => (item.id === saved.id ? saved : item));
  };

  const reopenThread = async (thread: ReviewThread) => {
    if (!session.value) return;
    const updated = { ...thread, status: 'open' as const, updatedAt: new Date().toISOString() };
    const saved = await client.saveReviewThread(session.value.id, updated);
    threads.value = threads.value.map((item) => (item.id === saved.id ? saved : item));
  };

  const isFileReviewed = (file: ChangedFile) => {
    return reviewedFiles.value.files[file.id]?.signature === file.signature;
  };

  const markFileReviewed = async (file: ChangedFile) => {
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value) return false;

    const reviewedAt = new Date().toISOString();
    return updateReviewedFiles({
      files: {
        [file.id]: {
          fileId: file.id,
          reviewedAt,
          reviewedBy: humanParticipantId,
          signature: file.signature,
        },
      },
    });
  };

  const unmarkFileReviewed = async (file: ChangedFile) => {
    if (!session.value) return false;
    return updateReviewedFiles({ removeFileIds: [file.id] });
  };

  const setFilesReviewed = async (files: ChangedFile[], reviewed: boolean) => {
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value) return false;

    const now = new Date().toISOString();
    const update: ReviewedFilesUpdate = reviewed ? { files: {} } : { removeFileIds: [] };
    for (const file of files) {
      if (reviewed) {
        update.files![file.id] = {
          fileId: file.id,
          reviewedAt: now,
          reviewedBy: humanParticipantId,
          signature: file.signature,
        };
      } else {
        update.removeFileIds!.push(file.id);
      }
    }

    return updateReviewedFiles(update);
  };

  const updateReviewedFiles = async (update: ReviewedFilesUpdate) => {
    if (!session.value) return false;
    const sessionId = session.value.id;
    const epoch = workspaceEpoch;
    try {
      reviewedFilesMutation = reviewedFilesMutation.then(async () => {
        if (epoch !== workspaceEpoch) return;
        const version = (reviewedFilesVersion += 1);
        const updated = await client.updateReviewedFiles(sessionId, update);
        if (epoch === workspaceEpoch && session.value?.id === sessionId && reviewedFilesVersion === version) reviewedFiles.value = updated;
      });
      await reviewedFilesMutation;
      if (epoch !== workspaceEpoch) return false;
      error.value = undefined;
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      reviewedFilesMutation = Promise.resolve();
      return false;
    }
  };

  const saveChatMessage = async (role: ReviewChatMessage['role'], body: string, context?: ReviewChatMessage['context']) => {
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value) return false;
    const text = body.trim();
    if (!text) return false;

    const message: ReviewChatMessage = {
      id: createId('chat'),
      sessionId: session.value.id,
      role,
      body: text,
      createdAt: new Date().toISOString(),
      ...(context ? { context } : {}),
    };

    try {
      const saved = await client.saveReviewChatMessage(session.value.id, message);
      if (epoch !== workspaceEpoch) return false;
      chatMessages.value = [...chatMessages.value.filter((item) => item.id !== saved.id), saved].sort((first, second) =>
        first.createdAt.localeCompare(second.createdAt),
      );
      error.value = undefined;
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    }
  };

  const startAgentReview = async () => {
    const reference = getActiveWorkspace();
    const review = session.value;
    if (!reference || !review) return false;
    error.value = undefined;
    try {
      await acpReview.queue(reference, review, agentAdapter.value.startsWith('acp:') ? agentAdapter.value.slice(4) : '');
      return isActiveWorkspace(reference) && session.value?.id === review.id;
    } catch (e) {
      if (isActiveWorkspace(reference) && session.value?.id === review.id) error.value = String(e);
      return false;
    }
  };
  const stopAgentReview = async (agentSessionId?: string) => {
    if (agentSessionId) return acpReview.stop(agentSessionId);
    await acpReview.stopReviews();
  };
  const askAgentInThread = async (thread: ReviewThread, body: string) => {
    const reference = getActiveWorkspace();
    const review = session.value;
    if (!reference || !review || !body.trim()) return false;
    error.value = undefined;
    try {
      await acpReview.queue(
        reference,
        review,
        agentAdapter.value.startsWith('acp:') ? agentAdapter.value.slice(4) : '',
        body.trim(),
        thread,
      );
      return isActiveWorkspace(reference) && session.value?.id === review.id;
    } catch (e) {
      if (isActiveWorkspace(reference) && session.value?.id === review.id) error.value = String(e);
      return false;
    }
  };
  const askAgentAtDraft = async (body: string) => {
    const review = session.value;
    const file = draftFile.value;
    const anchor = draftAnchor.value;
    const epoch = workspaceEpoch;
    if (!review || !file || !anchor) return false;
    const now = new Date().toISOString();
    const result = await askAgentInThread(
      {
        id: selectionChatThreadId(file.id, anchor),
        sessionId: review.id,
        fileId: file.id,
        oldPath: file.oldPath ?? undefined,
        newPath: file.newPath ?? undefined,
        anchor,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
      body,
    );
    if (result && epoch === workspaceEpoch && draftBody.value.trim() === body.trim()) cancelDraft();
    return result && epoch === workspaceEpoch;
  };

  const threadCountForAnchor = (fileId: string, side: 'old' | 'new', line: number) => {
    return openThreads.value.filter((thread) => {
      return thread.fileId === fileId && thread.anchor.side === side && line >= thread.anchor.startLine && line <= thread.anchor.endLine;
    }).length;
  };

  const clear = () => {
    workspaceEpoch += 1;
    reviewedFilesVersion += 1;
    reviewedFilesMutation = Promise.resolve();
    session.value = null;
    sessions.value = [];
    progress.value = null;
    reviewedFiles.value = { files: {} };
    runs.value = [];
    agentStates.value = [];
    threads.value = [];
    chatMessages.value = [];
    error.value = undefined;
    replyDrafts.value = {};
    cancelDraft();
  };

  const captureDraftState = () => ({
    file: draftFile.value,
    anchor: draftAnchor.value,
    mode: draftMode.value,
    body: draftBody.value,
    replies: { ...replyDrafts.value },
  });

  const restoreDraftState = (state?: {
    file?: ChangedFile;
    anchor?: ReviewAnchor;
    mode: 'comment' | 'chat';
    body: string;
    replies?: Record<string, string>;
  }) => {
    draftFile.value = state?.file;
    draftAnchor.value = state?.anchor;
    draftMode.value = state?.mode ?? 'comment';
    draftBody.value = state?.body ?? '';
    replyDrafts.value = { ...(state?.replies ?? {}) };
  };

  return {
    agentAdapter,
    acpReview,
    session,
    sessions,
    progress,
    reviewedFiles,
    runs,
    agentStates,
    chatMessages: computed(() => [...chatMessages.value, ...acpReview.messages]),
    threads,
    openThreads,
    loading,
    error,
    draftAnchor,
    draftFile,
    draftMode,
    draftBody,
    replyDrafts,
    pendingAgentChatKeys: computed(() => acpReview.pendingChatKeys),
    ensureSession,
    selectSession,
    startNewSession,
    loadSessions,
    loadProgress,
    loadReviewedFiles,
    loadRuns,
    loadAgentStates,
    loadChatMessages,
    refreshReviewState,
    startAgentReview,
    stopAgentReview,
    loadThreads,
    startDraft,
    cancelDraft,
    captureDraftState,
    restoreDraftState,
    createThread,
    addMessage,
    resolveThread,
    reopenThread,
    isFileReviewed,
    markFileReviewed,
    unmarkFileReviewed,
    setFilesReviewed,
    saveChatMessage,
    askAgentInThread,
    askAgentAtDraft,
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

const selectionChatThreadId = (fileId: string, anchor: ReviewAnchor) => {
  return `chat:${fileId}:${anchor.side}:${anchor.startLine}:${anchor.endLine}:${anchor.startColumn ?? ''}:${anchor.endColumn ?? ''}`;
};

const createId = (prefix: string) => {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}-${random}`;
};
