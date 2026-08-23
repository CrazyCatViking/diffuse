import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { isActiveWorkspace, useClient } from '../lib/useClient';
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
  const session = ref<ReviewSession | null>(null);
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
  const pendingAgentChatKeys = ref(new Set<string>());
  let reviewedFilesMutation = Promise.resolve();
  let reviewedFilesVersion = 0;
  let workspaceEpoch = 0;

  const openThreads = computed(() => threads.value.filter((thread) => thread.status === 'open'));
  const activeRun = computed(() => {
    const active = runs.value
      .filter((run) => run.status === 'starting' || run.status === 'planning' || run.status === 'running' || run.status === 'cancelling')
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))[0];
    return active ?? null;
  });
  const activeAgentState = computed(() => {
    const activeRunId = activeRun.value?.id;
    const states = activeRunId ? agentStates.value.filter((agent) => agent.id === activeRunId) : agentStates.value;
    return [...states].sort((first, second) => (second.updatedAt ?? '').localeCompare(first.updatedAt ?? ''))[0] ?? null;
  });

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
      await client.recoverStaleReviewRuns(next.id);
      if (epoch !== workspaceEpoch) return;
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

  const startAgentReview = async () => {
    if (!repo.repository) return false;
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value) return false;

    loading.value = true;
    error.value = undefined;
    try {
      await client.startReviewAgent(repo.repository.root, session.value.id, repo.changedFiles);
      if (epoch !== workspaceEpoch) return false;
      await refreshReviewState();
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      await loadRuns();
      return false;
    } finally {
      if (epoch === workspaceEpoch) loading.value = false;
    }
  };

  const stopAgentReview = async () => {
    const epoch = workspaceEpoch;
    loading.value = true;
    error.value = undefined;
    try {
      await client.stopReviewAgent();
      if (epoch !== workspaceEpoch) return;
      await refreshReviewState();
    } catch (err) {
      if (epoch !== workspaceEpoch) return;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
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

  const askAgentInThread = async (thread: ReviewThread, body: string) => {
    if (!repo.repository) return false;
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value) return false;
    const text = body.trim();
    if (!text) return false;

    const context: ReviewChatMessage['context'] = {
      fileId: thread.fileId,
      selection: thread.anchor,
      threadIds: [thread.id],
    };
    const chatKey = threadChatKey(thread.id);
    if (pendingAgentChatKeys.value.has(chatKey)) return false;
    const userMessage: ReviewChatMessage = {
      id: createId('chat'),
      sessionId: session.value.id,
      role: 'user',
      body: text,
      createdAt: new Date().toISOString(),
      context,
    };
    const pendingMessage: ReviewChatMessage = {
      id: createId('chat'),
      sessionId: session.value.id,
      role: 'assistant',
      body: 'Thinking...',
      createdAt: new Date().toISOString(),
      provider: 'opencode',
      context,
    };

    loading.value = true;
    error.value = undefined;
    pendingAgentChatKeys.value = new Set([...pendingAgentChatKeys.value, chatKey]);
    try {
      const savedUser = await client.saveReviewChatMessage(session.value.id, userMessage);
      const savedPending = await client.saveReviewChatMessage(session.value.id, pendingMessage);
      if (epoch !== workspaceEpoch) return false;
      chatMessages.value = upsertChatMessages(chatMessages.value, [savedUser, savedPending]);
      const assistant = await client.chatWithReviewAgent(
        repo.repository.root,
        session.value.id,
        thread,
        text,
        chatMessages.value,
        savedUser.id,
        savedPending.id,
      );
      if (epoch !== workspaceEpoch) return false;
      chatMessages.value = [...chatMessages.value.filter((item) => item.id !== assistant.id), assistant].sort((first, second) =>
        first.createdAt.localeCompare(second.createdAt),
      );
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    } finally {
      if (epoch !== workspaceEpoch) return;
      const nextPending = new Set(pendingAgentChatKeys.value);
      nextPending.delete(chatKey);
      pendingAgentChatKeys.value = nextPending;
      loading.value = false;
    }
  };

  const askAgentAtDraft = async (body: string) => {
    if (!repo.repository) return false;
    const epoch = workspaceEpoch;
    if (!session.value) await ensureSession();
    if (epoch !== workspaceEpoch || !session.value || !draftFile.value || !draftAnchor.value) return false;
    const text = body.trim();
    if (!text) return false;

    const chatThreadId = selectionChatThreadId(draftFile.value.id, draftAnchor.value);
    const context: ReviewChatMessage['context'] = {
      fileId: draftFile.value.id,
      selection: draftAnchor.value,
      threadIds: [chatThreadId],
    };
    if (pendingAgentChatKeys.value.has(chatThreadId)) return false;

    const now = new Date().toISOString();
    const pseudoThread: ReviewThread = {
      id: chatThreadId,
      sessionId: session.value.id,
      fileId: draftFile.value.id,
      oldPath: draftFile.value.oldPath ?? undefined,
      newPath: draftFile.value.newPath ?? undefined,
      anchor: draftAnchor.value,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: createId('msg'), authorId: humanParticipantId, body: text, createdAt: now }],
    };
    const userMessage: ReviewChatMessage = {
      id: createId('chat'),
      sessionId: session.value.id,
      role: 'user',
      body: text,
      createdAt: now,
      context,
    };
    const pendingMessage: ReviewChatMessage = {
      id: createId('chat'),
      sessionId: session.value.id,
      role: 'assistant',
      body: 'Thinking...',
      createdAt: new Date().toISOString(),
      provider: 'opencode',
      context,
    };

    loading.value = true;
    error.value = undefined;
    pendingAgentChatKeys.value = new Set([...pendingAgentChatKeys.value, chatThreadId]);
    try {
      const savedUser = await client.saveReviewChatMessage(session.value.id, userMessage);
      const savedPending = await client.saveReviewChatMessage(session.value.id, pendingMessage);
      if (epoch !== workspaceEpoch) return false;
      chatMessages.value = upsertChatMessages(chatMessages.value, [savedUser, savedPending]);
      cancelDraft();
      const assistant = await client.chatWithReviewAgent(
        repo.repository.root,
        session.value.id,
        pseudoThread,
        text,
        chatMessages.value,
        savedUser.id,
        savedPending.id,
      );
      if (epoch !== workspaceEpoch) return false;
      chatMessages.value = upsertChatMessages(chatMessages.value, [assistant]);
      return true;
    } catch (err) {
      if (epoch !== workspaceEpoch) return false;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      return false;
    } finally {
      if (epoch !== workspaceEpoch) return;
      const nextPending = new Set(pendingAgentChatKeys.value);
      nextPending.delete(chatThreadId);
      pendingAgentChatKeys.value = nextPending;
      loading.value = false;
    }
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
    pendingAgentChatKeys.value = new Set();
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
    session,
    sessions,
    progress,
    reviewedFiles,
    runs,
    agentStates,
    activeAgentState,
    chatMessages,
    activeRun,
    threads,
    openThreads,
    loading,
    error,
    draftAnchor,
    draftFile,
    draftMode,
    draftBody,
    replyDrafts,
    pendingAgentChatKeys,
    ensureSession,
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

const threadChatKey = (threadId: string) => threadId;

const selectionChatThreadId = (fileId: string, anchor: ReviewAnchor) => {
  return `chat:${fileId}:${anchor.side}:${anchor.startLine}:${anchor.endLine}:${anchor.startColumn ?? ''}:${anchor.endColumn ?? ''}`;
};

const upsertChatMessages = (current: ReviewChatMessage[], messages: ReviewChatMessage[]) => {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
};

const createId = (prefix: string) => {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}-${random}`;
};
