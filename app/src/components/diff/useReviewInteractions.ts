import type { Ref } from 'vue';
import type { ChangedFile, ReviewAnchor, ReviewChatMessage, ReviewThread } from '../../lib/protocol';
import { useReviewStore } from '../../stores/review';
import type { InlineReviewEntry } from './InlineReviewBox.vue';
import { commentStartKey, selectionChatThreadId } from './reviewRows';

type SelectionDraft = { file: ChangedFile; anchor: ReviewAnchor };
type ReviewReplyPayload = { thread: ReviewThread; body: string };

export const useReviewInteractions = (options: {
  review: ReturnType<typeof useReviewStore>;
  draftBody: Ref<string>;
  collapsedCommentStarts: Ref<Set<string>>;
  expandedResolvedCommentStarts: Ref<Set<string>>;
  selectionDraft: Ref<SelectionDraft | undefined>;
  clearNativeSelection: () => void;
}) => {
  const { review, draftBody, collapsedCommentStarts, expandedResolvedCommentStarts, selectionDraft, clearNativeSelection } = options;

  const chatMessagesForEntry = (entry: InlineReviewEntry): ReviewChatMessage[] => {
    if (entry.kind === 'draft') return [];
    const threadId = entry.kind === 'thread' ? entry.thread.id : entry.chatThreadId;
    return review.chatMessages.filter((message) => message.context?.threadIds?.includes(threadId));
  };

  const agentRespondingForEntry = (entry: InlineReviewEntry) => {
    if (entry.kind === 'draft')
      return (
        entry.mode === 'chat' &&
        Boolean(
          review.draftFile &&
          review.draftAnchor &&
          review.pendingAgentChatKeys.has(selectionChatThreadId(review.draftFile.id, review.draftAnchor)),
        )
      );
    return review.pendingAgentChatKeys.has(entry.kind === 'thread' ? entry.thread.id : entry.chatThreadId);
  };

  const submitComment = async () => {
    const saved = await review.createThread(draftBody.value);
    if (!saved) return;
    draftBody.value = '';
    clearNativeSelection();
  };

  const submitChatDraft = async () => {
    const saved = await review.askAgentAtDraft(draftBody.value);
    if (!saved) return;
    draftBody.value = '';
    clearNativeSelection();
  };

  const cancelDraft = () => {
    draftBody.value = '';
    review.cancelDraft();
    clearNativeSelection();
  };

  const addReply = async (payload: ReviewReplyPayload) => {
    await review.addMessage(payload.thread, payload.body);
    const next = new Set(collapsedCommentStarts.value);
    next.delete(commentStartKey(payload.thread.anchor.side, payload.thread.anchor.startLine));
    collapsedCommentStarts.value = next;
  };

  const askAiInThread = async (payload: ReviewReplyPayload) => {
    await review.askAgentInThread(payload.thread, payload.body);
    const next = new Set(collapsedCommentStarts.value);
    next.delete(commentStartKey(payload.thread.anchor.side, payload.thread.anchor.startLine));
    collapsedCommentStarts.value = next;
  };

  const collapseThread = (anchor: ReviewAnchor) => {
    const next = new Set(collapsedCommentStarts.value);
    next.add(commentStartKey(anchor.side, anchor.startLine));
    collapsedCommentStarts.value = next;
    const expandedResolved = new Set(expandedResolvedCommentStarts.value);
    expandedResolved.delete(commentStartKey(anchor.side, anchor.startLine));
    expandedResolvedCommentStarts.value = expandedResolved;
  };

  const resolveThread = async (thread: ReviewThread) => {
    await review.resolveThread(thread);
    const next = new Set(collapsedCommentStarts.value);
    next.add(commentStartKey(thread.anchor.side, thread.anchor.startLine));
    collapsedCommentStarts.value = next;
    const expandedResolved = new Set(expandedResolvedCommentStarts.value);
    expandedResolved.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
    expandedResolvedCommentStarts.value = expandedResolved;
  };

  const reopenThread = async (thread: ReviewThread) => {
    await review.reopenThread(thread);
    const next = new Set(collapsedCommentStarts.value);
    next.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
    collapsedCommentStarts.value = next;
    const expandedResolved = new Set(expandedResolvedCommentStarts.value);
    expandedResolved.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
    expandedResolvedCommentStarts.value = expandedResolved;
  };

  const startSelectionComment = () => {
    if (!selectionDraft.value) return;
    draftBody.value = '';
    review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor, 'comment');
    selectionDraft.value = undefined;
  };

  const startSelectionChat = () => {
    if (!selectionDraft.value) return;
    draftBody.value = '';
    review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor, 'chat');
    selectionDraft.value = undefined;
  };

  return {
    chatMessagesForEntry,
    agentRespondingForEntry,
    submitComment,
    submitChatDraft,
    cancelDraft,
    addReply,
    askAiInThread,
    collapseThread,
    resolveThread,
    reopenThread,
    startSelectionComment,
    startSelectionChat,
  };
};
