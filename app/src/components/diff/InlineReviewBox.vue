<template>
  <section
    class="review-box"
    :class="{
      resolved: entry.kind === 'thread' && entry.thread.status === 'resolved',
      chat: entry.kind === 'chat' || (entry.kind === 'draft' && entry.mode === 'chat'),
    }"
  >
    <div v-if="entry.kind === 'thread'" class="review-box-header">
      <span v-if="entry.thread.status === 'resolved'" class="resolved-label">Resolved</span>

      <span v-else class="thread-label">Thread</span>

      <span v-if="error" class="review-error">{{ error }}</span>

      <div class="thread-actions">
        <button type="button" @click="emit('collapse', entry.anchor)">Collapse</button>

        <button v-if="entry.thread.status === 'open'" type="button" @click="emit('resolve', entry.thread)">Resolve</button>

        <button v-else type="button" @click="emit('reopen', entry.thread)">Reopen</button>
      </div>
    </div>

    <form v-if="entry.kind === 'draft'" class="comment-composer" @submit.prevent="submitDraft">
      <div class="composer-author">You</div>

      <textarea
        :value="draftBody"
        :placeholder="entry.mode === 'chat' ? 'Ask AI about this selection' : 'Add a review comment'"
        @input="emit('update:draftBody', ($event.target as HTMLTextAreaElement).value)"
      />

      <div class="composer-actions">
        <button type="button" @click="emit('cancel')">Cancel</button>

        <button type="submit" :disabled="draftBody.trim().length === 0 || agentResponding">
          {{ entry.mode === 'chat' ? 'Ask AI' : 'Comment' }}
        </button>
      </div>
    </form>

    <article v-else class="thread">
      <div v-for="message in timelineMessages" :key="message.id" class="message" :class="{ chat: message.kind === 'chat' }">
        <div class="message-meta">
          <strong>{{ message.author }}</strong>

          <time>{{ formatTime(message.createdAt) }}</time>
        </div>

        <p>{{ message.body }}</p>
      </div>

      <form class="reply-composer" @submit.prevent="submitReply">
        <textarea
          ref="replyTextareaRef"
          v-model="replyBody"
          class="reply-input"
          rows="1"
          placeholder="Reply or ask an agent..."
          :disabled="agentResponding"
          @input="resizeReplyTextarea"
          @keydown.enter.exact.prevent="submitReply"
        />

        <div class="reply-actions">
          <button type="button" :disabled="replyBody.trim().length === 0 || agentResponding" @click="submitChat">Ask AI</button>

          <button type="submit" :disabled="replyBody.trim().length === 0 || agentResponding">Send</button>
        </div>
      </form>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReviewAnchor, ReviewChatMessage, ReviewThread } from '../../lib/protocol';

export type InlineReviewEntry =
  | {
      kind: 'draft';
      key: string;
      anchor: ReviewAnchor;
      mode: 'comment' | 'chat';
    }
  | {
      kind: 'thread';
      key: string;
      anchor: ReviewAnchor;
      thread: ReviewThread;
    }
  | {
      kind: 'chat';
      key: string;
      anchor: ReviewAnchor;
      chatThreadId: string;
    };

const props = defineProps<{
  entry: InlineReviewEntry;
  draftBody: string;
  chatMessages?: ReviewChatMessage[];
  agentResponding?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  'update:draftBody': [value: string];
  submit: [];
  submitChatDraft: [];
  cancel: [];
  reply: [payload: { thread: ReviewThread; body: string }];
  chat: [payload: { thread: ReviewThread; body: string }];
  collapse: [anchor: ReviewAnchor];
  resolve: [thread: ReviewThread];
  reopen: [thread: ReviewThread];
}>();

const replyBody = ref('');
const replyTextareaRef = ref<HTMLTextAreaElement | null>(null);
const agentResponding = computed(() => props.agentResponding ?? false);

const submitDraft = () => {
  if (props.entry.kind !== 'draft') return;
  if (props.entry.mode === 'chat') emit('submitChatDraft');
  else emit('submit');
};

const submitReply = () => {
  if (props.entry.kind !== 'thread') return;
  const body = replyBody.value.trim();
  if (!body || agentResponding.value) return;
  emit('reply', { thread: props.entry.thread, body });
  replyBody.value = '';
  resizeReplyTextarea();
};

const submitChat = () => {
  if (props.entry.kind !== 'thread') return;
  const body = replyBody.value.trim();
  if (!body || agentResponding.value) return;
  emit('chat', { thread: props.entry.thread, body });
  replyBody.value = '';
  resizeReplyTextarea();
};

const timelineMessages = computed(() => {
  const threadMessages =
    props.entry.kind === 'thread'
      ? props.entry.thread.messages.map((message) => ({
          id: message.id,
          kind: 'thread' as const,
          author: authorName(message.authorId),
          body: message.body,
          createdAt: message.createdAt,
        }))
      : [];
  const chatMessages = (props.chatMessages ?? []).map((message) => ({
    id: message.id,
    kind: 'chat' as const,
    author: message.role === 'assistant' ? 'AI agent' : message.role === 'system' ? 'System' : 'You asked AI',
    body: message.body,
    createdAt: message.createdAt,
  }));
  return [...threadMessages, ...chatMessages].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
});

const resizeReplyTextarea = () => {
  window.requestAnimationFrame(() => {
    const textarea = replyTextareaRef.value;
    if (!textarea) return;
    textarea.style.height = '30px';
    const nextHeight = Math.min(textarea.scrollHeight, 140);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 140 ? 'auto' : 'hidden';
  });
};

const authorName = (authorId: string) => {
  if (authorId === 'local-human') return 'You';
  return authorId.startsWith('ai') ? 'AI agent' : authorId;
};

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
</script>

<style scoped lang="scss">
.review-box {
  display: grid;
  gap: var(--space-4);
  min-height: 0;
  margin: var(--space-2) var(--space-6) var(--space-4);
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-secondary);
  background: linear-gradient(90deg, var(--color-review-muted), var(--color-bg-shell) 18px);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-review);
  border-radius: var(--radius-4);
  box-sizing: border-box;
  box-shadow: var(--shadow-inset-highlight);
}

.review-box.resolved {
  min-height: 72px;
  opacity: 0.78;
}

.review-box.chat {
  background: linear-gradient(90deg, var(--color-ai-muted), var(--color-bg-shell) 18px);
  border-left-color: var(--color-ai);
}

.review-box-header,
.composer-actions {
  display: flex;
  align-items: center;
  gap: var(--space-5);
}

.composer-actions {
  justify-content: space-between;
}

.review-box-header {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  text-transform: uppercase;
}

.review-error {
  color: var(--color-danger);
  text-transform: none;
}

.resolved-label {
  padding: var(--space-1) var(--space-3);
  color: var(--color-success);
  background: var(--color-success-muted);
  border: 1px solid rgba(91, 184, 119, 0.25);
  border-radius: var(--radius-pill);
  text-transform: none;
}

.thread-label {
  color: var(--color-ai);
  text-transform: none;
}

.comment-composer,
.thread {
  display: grid;
  gap: var(--space-4);
}

.composer-author,
.message-meta {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.message {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}

.message.chat {
  background: var(--color-bg-active);
  border-color: var(--color-border-strong);
}

.reply-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: end;
  padding-top: var(--space-1);
}

.reply-actions {
  display: flex;
  gap: var(--space-3);
}

.message-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-6);

  strong {
    color: var(--color-text-primary);
  }

  time {
    color: var(--color-text-disabled);
  }
}

.thread-actions {
  display: flex;
  gap: var(--space-4);
  margin-left: auto;
  justify-content: flex-end;
}

.thread-actions button {
  padding: 4px 8px;
}

textarea {
  min-height: 74px;
  padding: var(--space-5);
  resize: vertical;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  font: inherit;
}

.reply-input {
  height: 30px;
  min-height: 30px;
  max-height: 140px;
  min-width: 0;
  padding: var(--space-3) var(--space-5);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  font: inherit;
  line-height: 18px;
  overflow: hidden;
  resize: none;

  &::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
}

button {
  padding: var(--space-3) var(--space-5);
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border: 1px solid rgba(143, 179, 255, 0.26);
  border-radius: var(--radius-3);
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }
}

p {
  margin: 0;
  color: var(--color-text-primary);
  white-space: pre-wrap;
}
</style>
