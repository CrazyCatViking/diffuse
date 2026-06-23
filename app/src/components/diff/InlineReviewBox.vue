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
  gap: 8px;
  min-height: 0;
  margin: 4px 12px 8px;
  padding: 10px 12px;
  color: #d7deea;
  background: linear-gradient(90deg, rgba(240, 195, 106, 0.16), rgba(17, 23, 34, 0.98) 18px);
  border: 1px solid #3a4356;
  border-left: 3px solid #f0c36a;
  border-radius: 10px;
  box-sizing: border-box;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.review-box.resolved {
  min-height: 72px;
  opacity: 0.78;
}

.review-box.chat {
  background: linear-gradient(90deg, rgba(118, 157, 255, 0.14), rgba(17, 23, 34, 0.98) 18px);
  border-left-color: #769dff;
}

.review-box-header,
.composer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.composer-actions {
  justify-content: space-between;
}

.review-box-header {
  color: #98a2b3;
  font-size: 12px;
  text-transform: uppercase;
}

.review-error {
  color: #ff9d9d;
  text-transform: none;
}

.resolved-label {
  padding: 2px 6px;
  color: #9ab7a0;
  background: rgba(99, 179, 112, 0.12);
  border: 1px solid rgba(99, 179, 112, 0.22);
  border-radius: 999px;
  text-transform: none;
}

.thread-label {
  color: #8da2c0;
  text-transform: none;
}

.comment-composer,
.thread {
  display: grid;
  gap: 8px;
}

.composer-author,
.message-meta {
  color: #98a2b3;
  font-size: 12px;
}

.message {
  display: grid;
  gap: 5px;
  padding: 8px 10px;
  background: rgba(15, 19, 27, 0.72);
  border: 1px solid rgba(58, 67, 86, 0.8);
  border-radius: 8px;
}

.message.chat {
  background: rgba(31, 43, 70, 0.72);
  border-color: rgba(82, 118, 178, 0.85);
}

.reply-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
  padding-top: 2px;
}

.reply-actions {
  display: flex;
  gap: 6px;
}

.message-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;

  strong {
    color: #f4f7fb;
  }

  time {
    color: #687386;
  }
}

.thread-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
  justify-content: flex-end;
}

.thread-actions button {
  padding: 4px 8px;
}

textarea {
  min-height: 74px;
  padding: 10px;
  resize: vertical;
  color: #f4f7fb;
  background: #0f131b;
  border: 1px solid #30384a;
  border-radius: 8px;
  font: inherit;
}

.reply-input {
  height: 30px;
  min-height: 30px;
  max-height: 140px;
  min-width: 0;
  padding: 6px 10px;
  color: #f4f7fb;
  background: #0f131b;
  border: 1px solid #30384a;
  border-radius: 14px;
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
  padding: 5px 10px;
  color: #d7e6ff;
  background: #1b2c4a;
  border: 1px solid #38527d;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }
}

p {
  margin: 0;
  color: #eef3fb;
  white-space: pre-wrap;
}
</style>
