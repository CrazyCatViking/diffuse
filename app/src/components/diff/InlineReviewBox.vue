<template>
  <section
    class="review-box"
    :class="{
      resolved: entry.kind === 'thread' && entry.thread.status === 'resolved',
      chat: entry.kind === 'chat' || (entry.kind === 'draft' && entry.mode === 'chat'),
      flashing,
    }"
    @keyup.esc="emit('cancel')"
  >
    <div v-if="entry.kind === 'thread'" class="review-box-header">
      <div class="thread-heading">
        <span v-if="entry.thread.status === 'resolved'" class="resolved-label">Resolved thread</span>

        <span v-else class="thread-label">Open thread</span>

        <span class="anchor-label">{{ anchorLabel(entry.anchor) }}</span>
      </div>

      <span v-if="error" class="review-error">{{ error }}</span>

      <div class="thread-actions">
        <button class="ghost-action" type="button" @click="emit('collapse', entry.anchor)">Collapse</button>

        <button v-if="entry.thread.status === 'open'" class="primary-action" type="button" @click="emit('resolve', entry.thread)">
          Resolve
        </button>

        <button v-else class="primary-action" type="button" @click="emit('reopen', entry.thread)">Reopen</button>
      </div>
    </div>

    <form v-if="entry.kind === 'draft'" class="comment-composer" @submit.prevent="submitDraft">
      <div class="composer-heading">
        <div class="composer-title-group">
          <span class="composer-author">{{ entry.mode === 'chat' ? 'Ask AI' : 'Comment draft' }}</span>

          <span class="anchor-label">{{ anchorLabel(entry.anchor) }}</span>
        </div>

        <span class="composer-hint">{{ entry.mode === 'chat' ? 'AI sees this selection' : 'Saved to local review' }}</span>
      </div>

      <textarea
        ref="draftTextareaRef"
        :value="draftBody"
        :placeholder="entry.mode === 'chat' ? 'Ask AI about this selection' : 'Add a review comment'"
        :aria-label="entry.mode === 'chat' ? 'Ask AI about this selection' : 'Add a review comment'"
        @input="emit('update:draftBody', ($event.target as HTMLTextAreaElement).value)"
        @keydown.ctrl.enter.prevent="submitDraft"
      />

      <div class="composer-actions">
        <button class="ghost-action" type="button" @click="emit('cancel')">Cancel</button>

        <button
          class="primary-action"
          :class="{ ai: entry.mode === 'chat' }"
          type="submit"
          :disabled="draftBody.trim().length === 0 || agentResponding"
        >
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

      <div v-if="agentResponding" class="agent-responding">AI is responding...</div>

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
          <button class="ghost-action" type="button" :disabled="replyBody.trim().length === 0 || agentResponding" @click="submitChat">
            Ask AI
          </button>

          <button class="primary-action" type="submit" :disabled="replyBody.trim().length === 0 || agentResponding">Send</button>
        </div>
      </form>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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
  flashing?: boolean;
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
const draftTextareaRef = ref<HTMLTextAreaElement | null>(null);
const replyTextareaRef = ref<HTMLTextAreaElement | null>(null);
const agentResponding = computed(() => props.agentResponding ?? false);

const submitDraft = () => {
  if (props.entry.kind !== 'draft') return;
  if (props.draftBody.trim().length === 0 || agentResponding.value) return;
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

const anchorLabel = (anchor: ReviewAnchor) => {
  const range = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`;
  return `${anchor.side}:${range}`;
};

const focusDraftTextarea = async () => {
  if (props.entry.kind !== 'draft') return;

  await nextTick();
  draftTextareaRef.value?.focus();
};

onMounted(() => {
  void focusDraftTextarea();
});

watch(
  () => (props.entry.kind === 'draft' ? props.entry.key : undefined),
  () => {
    void focusDraftTextarea();
  },
);
</script>

<style scoped lang="scss">
.review-box {
  display: grid;
  gap: var(--space-4);
  min-height: 0;
  margin: 0;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-secondary);
  background: linear-gradient(90deg, var(--color-review-muted), var(--color-bg-shell) 18px);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-review);
  border-radius: var(--radius-4);
  box-sizing: border-box;
  box-shadow: var(--shadow-inset-highlight);
}

.review-box.resolved {
  min-height: 56px;
  opacity: 0.78;
}

.review-box.chat {
  background: linear-gradient(90deg, var(--color-ai-muted), var(--color-bg-shell) 18px);
  border-left-color: var(--color-ai);
}

.review-box.flashing {
  animation: review-box-flash 1800ms ease-out;
}

.review-box-header,
.composer-actions,
.composer-heading {
  display: flex;
  align-items: center;
  gap: var(--space-5);
}

.review-box-header,
.composer-actions,
.composer-heading {
  justify-content: space-between;
}

.review-box-header {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  text-transform: uppercase;
}

.thread-heading,
.composer-title-group {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
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

.anchor-label,
.composer-hint {
  color: var(--color-text-subtle);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  text-transform: none;
}

.composer-hint {
  overflow: hidden;
  font-family: var(--font-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-composer,
.thread {
  display: grid;
  gap: var(--space-3);
}

.composer-author,
.message-meta {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.composer-author {
  color: var(--color-text-primary);
  font-weight: 700;
}

.message {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}

.message.chat {
  background: var(--color-bg-active);
  border-color: var(--color-border-strong);
}

.agent-responding {
  width: fit-content;
  padding: var(--space-2) var(--space-4);
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border: 1px solid rgba(143, 179, 255, 0.18);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-label);
}

.reply-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: end;
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
  min-height: 64px;
  padding: var(--space-4);
  resize: vertical;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  font: inherit;

  &:focus-visible {
    border-color: var(--color-border-focus);
    outline: 1px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.reply-input {
  height: 30px;
  min-height: 30px;
  max-height: 140px;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
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
  padding: var(--space-2) var(--space-4);
  color: var(--button-color, var(--color-text-secondary));
  background: var(--button-bg, transparent);
  border: 1px solid var(--button-border, var(--color-border-default));
  border-radius: var(--radius-3);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-label);
  font-weight: 650;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);

  &:hover:not(:disabled) {
    background: var(--button-bg-hover, var(--color-bg-hover));
    border-color: var(--button-border-hover, var(--color-border-strong));
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }
}

.ghost-action {
  --button-bg: transparent;
  --button-bg-hover: var(--color-bg-hover);
  --button-border: var(--color-border-default);
  --button-border-hover: var(--color-border-strong);
  --button-color: var(--color-text-muted);
}

.primary-action {
  --button-bg: var(--color-review-muted);
  --button-bg-hover: rgba(240, 195, 106, 0.22);
  --button-border: rgba(240, 195, 106, 0.26);
  --button-border-hover: rgba(240, 195, 106, 0.38);
  --button-color: #f7d898;

  &.ai {
    --button-bg: var(--color-ai-muted);
    --button-bg-hover: rgba(143, 179, 255, 0.22);
    --button-border: rgba(143, 179, 255, 0.26);
    --button-border-hover: rgba(143, 179, 255, 0.38);
    --button-color: #d6e3ff;
  }
}

p {
  margin: 0;
  color: var(--color-text-primary);
  white-space: pre-wrap;
}

@keyframes review-box-flash {
  0%,
  22% {
    box-shadow:
      var(--shadow-inset-highlight),
      0 0 0 1px rgba(240, 195, 106, 0.18),
      0 12px 32px rgba(0, 0, 0, 0.22);
  }

  100% {
    box-shadow: var(--shadow-inset-highlight);
  }
}
</style>
