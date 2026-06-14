<template>
  <section class="review-box" :class="{ resolved: entry.kind === 'thread' && entry.thread.status === 'resolved' }">
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

    <form v-if="entry.kind === 'draft'" class="comment-composer" @submit.prevent="emit('submit')">
      <div class="composer-author">You</div>
      <textarea :value="draftBody" placeholder="Add a review comment" @input="emit('update:draftBody', ($event.target as HTMLTextAreaElement).value)" />
      <div class="composer-actions">
        <button type="button" @click="emit('cancel')">Cancel</button>
        <button type="submit" :disabled="draftBody.trim().length === 0">Comment</button>
      </div>
    </form>

    <article v-else class="thread">
      <div v-for="message in entry.thread.messages" :key="message.id" class="message">
        <div class="message-meta">
          <strong>{{ authorName(message.authorId) }}</strong>
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
          @input="resizeReplyTextarea"
          @keydown.enter.exact.prevent="submitReply"
        />
        <button type="submit" :disabled="replyBody.trim().length === 0">Send</button>
      </form>
    </article>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { ReviewAnchor, ReviewThread } from '../../lib/protocol';

export type InlineReviewEntry = {
  kind: 'draft';
  key: string;
  anchor: ReviewAnchor;
} | {
  kind: 'thread';
  key: string;
  anchor: ReviewAnchor;
  thread: ReviewThread;
};

const props = defineProps<{
  entry: InlineReviewEntry
  draftBody: string
  error?: string
}>();

const emit = defineEmits<{
  'update:draftBody': [value: string]
  submit: []
  cancel: []
  reply: [payload: { thread: ReviewThread; body: string }]
  collapse: [anchor: ReviewAnchor]
  resolve: [thread: ReviewThread]
  reopen: [thread: ReviewThread]
}>();

const replyBody = ref('');
const replyTextareaRef = ref<HTMLTextAreaElement | null>(null);

const submitReply = () => {
  if (props.entry.kind !== 'thread') return;
  const body = replyBody.value.trim();
  if (!body) return;
  emit('reply', { thread: props.entry.thread, body });
  replyBody.value = '';
  resizeReplyTextarea();
};

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

.reply-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
  padding-top: 2px;
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
