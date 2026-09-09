<template>
  <section ref="surface" class="input-surface" tabindex="-1" aria-labelledby="input-heading" @focusin="acknowledgeExactAttention">
    <EmptyState
      v-if="!request || request.workspaceId !== workspaceId"
      title="Input request unavailable"
      description="This request may have expired or belongs to another workspace."
    />

    <Panel v-else class="input-panel" elevated>
      <header class="input-header">
        <div>
          <p class="eyebrow">{{ kindLabel }}</p>
          <h1 id="input-heading">Input Required</h1>
        </div>

        <Badge :tone="statusTone" size="md">{{ statusLabel }}</Badge>
      </header>

      <p class="prompt">{{ request.prompt }}</p>

      <form v-if="request.status === 'pending'" class="input-form" @submit.prevent="submit">
        <AgentInputForm
          v-if="acpInput?.method === 'elicitation/create'"
          :key="`${request.id}:${request.revision}`"
          :schema="acpInput.params.requestedSchema"
          :disabled="sending"
          :initial-values="workbench.inputFormDraft(request)"
          @response="draft = $event"
          @draft="workbench.saveInputFormDraft(request, acpInput.params.requestedSchema, $event)"
        />

        <fieldset v-else-if="request.choices.length > 0">
          <legend>Choose a response</legend>
          <label v-for="choice in request.choices" :key="choice" class="choice-row">
            <input v-model="draft" type="radio" name="input-choice" :value="choice" @change="persistDraft" />
            <span>{{ optionLabel(choice) }}</span>
          </label>
        </fieldset>

        <label v-else-if="metadataLoaded || request.kind === 'authentication'" class="response-field">
          <span>{{ request.kind === 'authentication' ? 'Secret value' : 'Response' }}</span>
          <input
            ref="responseInput"
            v-model="draft"
            :type="request.kind === 'authentication' ? 'password' : 'text'"
            :autocomplete="request.kind === 'authentication' ? 'off' : undefined"
            @input="persistDraft"
          />
        </label>

        <p v-else>Loading request details...</p>

        <p v-if="submitError" class="submit-error" role="alert">{{ submitError }}</p>

        <div class="input-actions">
          <Button type="submit" :disabled="sending || !draft || (!metadataLoaded && !request.choices.length)">Submit response</Button>

          <Button v-if="acpInput?.method === 'elicitation/create'" variant="secondary" :disabled="sending" @click="declineForm"
            >Decline form</Button
          >

          <Button v-if="request.cancellationSupported" variant="secondary" :disabled="sending" @click="cancel"> Cancel request </Button>
        </div>
      </form>

      <p v-else class="terminal-description" role="status">{{ terminalDescription }}</p>
    </Panel>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { routeParamString } from '../../lib/workspaceRoutes';
import { useWorkbenchStore } from '../../stores/workbench';
import { useAcpStore } from '../../stores/acp';
import { record } from '../../lib/acpContract';
import AgentInputForm from '../agents/AgentInputForm.vue';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';

const route = useRoute();
const workbench = useWorkbenchStore();
const acp = useAcpStore();
const metadataLoaded = ref(false);
const surface = ref<HTMLElement>();
const responseInput = ref<HTMLInputElement>();
const draft = ref('');
const sending = ref(false);
const submitError = ref('');
const acknowledgedRevision = ref<string>();
const workspaceId = computed(() => routeParamString(route.params.workspaceId));
const inputRequestId = computed(() => routeParamString(route.params.inputRequestId));
const request = computed(() => workbench.inputRequest(inputRequestId.value));
const acpInput = computed(() =>
  acp.snapshots[workspaceId.value]?.inputs.find((i) => i.input.id === inputRequestId.value && i.input.revision === request.value?.revision),
);
const optionLabel = (choice: string) => {
  const options = acpInput.value?.params.options;
  const option = Array.isArray(options) ? options.find((o) => record(o) && o.optionId === choice) : undefined;
  return record(option) && typeof option.name === 'string'
    ? `${option.name}${typeof option.kind === 'string' ? ` (${option.kind})` : ''}`
    : choice;
};
watch(
  [workspaceId, inputRequestId, () => request.value?.revision],
  async ([id, inputId, revision]) => {
    metadataLoaded.value = false;
    try {
      await acp.refresh(id);
      if (workspaceId.value === id && inputRequestId.value === inputId && request.value?.revision === revision) metadataLoaded.value = true;
    } catch (error) {
      // RPC has no ACP producer; retain its existing legacy input contract only when explicitly unsupported.
      if (String(error).includes('UNSUPPORTED_METHOD')) metadataLoaded.value = true;
      else submitError.value = String(error);
    }
  },
  { immediate: true },
);
let secretRequestToClear: NonNullable<typeof request.value> | undefined;
const kindLabel = computed(() => {
  if (request.value?.kind === 'permission') return 'Permission request';
  if (request.value?.kind === 'authentication') return 'Authentication request';
  if (request.value?.kind === 'conflict') return 'Conflict decision';
  return 'Question';
});
const statusLabel = computed(() => request.value?.status.replace('-', ' ') ?? 'Unavailable');
const statusTone = computed(() => {
  if (request.value?.status === 'accepted') return 'success';
  if (request.value?.status === 'rejected' || request.value?.status === 'expired') return 'danger';
  if (request.value?.status === 'pending') return 'warning';
  return 'neutral';
});
const terminalDescription = computed(() => {
  if (request.value?.status === 'response-submitted') return 'Response submitted. Waiting for the provider to accept it.';
  if (request.value?.status === 'accepted') return 'The provider accepted this response.';
  if (request.value?.status === 'rejected') return 'The provider rejected this response.';
  if (request.value?.status === 'expired') return 'This request expired before it was resolved.';
  if (request.value?.status === 'cancelled') return 'This request was cancelled.';
  return 'A newer request superseded this revision.';
});

const persistDraft = () => {
  if (request.value && acpInput.value?.method !== 'elicitation/create') workbench.saveInputDraft(request.value, draft.value);
};

const submit = async () => {
  const current = request.value;
  if (!current || current.status !== 'pending' || !draft.value || (!metadataLoaded.value && !current.choices.length)) return;
  sending.value = true;
  submitError.value = '';
  try {
    await workbench.answerInputRequest(current.id, current.revision, {
      value: draft.value,
      secret: current.kind === 'authentication' ? true : undefined,
    });
    clearDraft(current);
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : String(error);
  } finally {
    sending.value = false;
  }
};

const cancel = async () => {
  const current = request.value;
  if (!current || current.status !== 'pending') return;
  sending.value = true;
  submitError.value = '';
  try {
    await workbench.cancelInputRequest(current.id, current.revision);
    clearDraft(current);
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : String(error);
  } finally {
    sending.value = false;
  }
};

const declineForm = async () => {
  draft.value = JSON.stringify({ action: 'decline' });
  await submit();
};

const acknowledgeExactAttention = () => {
  const current = request.value;
  if (!current || !isVisibleAndFocused()) return;
  const attention = workbench.attentionItems[current.attentionId];
  if (!attention) return;
  const key = `${attention.id}:${attention.revision}`;
  if (acknowledgedRevision.value === key || attention.status !== 'unread') return;
  acknowledgedRevision.value = key;
  void workbench.acknowledgeAttention(attention.id, attention.revision).catch(() => {
    acknowledgedRevision.value = undefined;
  });
};

const isVisibleAndFocused = () => {
  const element = surface.value;
  if (!element || !element.isConnected || document.visibilityState !== 'visible') return false;
  if (element.closest('[hidden], [inert]')) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return document.activeElement === element || (document.activeElement instanceof Node && element.contains(document.activeElement));
};

const clearDraft = (current: NonNullable<typeof request.value>) => {
  if (request.value?.id === current.id && request.value.revision === current.revision) {
    draft.value = '';
    if (responseInput.value) responseInput.value.value = '';
  }
  workbench.clearInputDraft(current);
};

const handleVisibilityChange = () => acknowledgeExactAttention();

watch(
  () => request.value,
  async (current, previous) => {
    if (current && previous && current.id === previous.id && current.revision === previous.revision && current.status === previous.status)
      return;
    if (previous?.kind === 'authentication' && (!current || current.id !== previous.id || current.revision !== previous.revision)) {
      clearDraft(previous);
    }
    if (!current) return;
    draft.value = workbench.inputDraft(current);
    submitError.value = '';
    await nextTick();
    responseInput.value?.focus();
    acknowledgeExactAttention();
  },
  { immediate: true },
);

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (!responseInput.value) surface.value?.focus();
  acknowledgeExactAttention();
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (request.value?.kind === 'authentication') secretRequestToClear = request.value;
  draft.value = '';
  if (responseInput.value) responseInput.value.value = '';
});

onUnmounted(() => {
  if (secretRequestToClear) workbench.clearInputDraft(secretRequestToClear);
});
</script>

<style scoped lang="scss">
.input-surface {
  display: grid;
  place-items: start center;
  min-width: 0;
  min-height: 0;
  padding: var(--space-10);
  overflow: auto;
  background: var(--color-bg-app);
  outline: 0;
}

.input-panel {
  display: grid;
  gap: var(--space-8);
  width: min(680px, 100%);
}

.input-header,
.input-actions {
  display: flex;
  gap: var(--space-5);
  align-items: center;
  justify-content: space-between;
}

h1,
p {
  margin: 0;
}

h1 {
  margin-top: var(--space-2);
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-md);
}

.eyebrow {
  color: var(--color-warning);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.prompt {
  color: var(--color-text-secondary);
  font-size: var(--font-size-body-lg);
  line-height: 1.6;
  white-space: pre-wrap;
}

.input-form,
.response-field,
fieldset {
  display: grid;
  gap: var(--space-5);
}

fieldset {
  padding: 0;
  border: 0;
}

legend,
.response-field > span {
  margin-bottom: var(--space-3);
  color: var(--color-text-primary);
  font-weight: 700;
}

.choice-row {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-5);
  color: var(--color-text-secondary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}

.response-field input {
  min-height: 38px;
  padding: 0 var(--space-5);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.submit-error {
  color: var(--color-danger);
}

.terminal-description {
  padding: var(--space-6);
  color: var(--color-text-secondary);
  background: var(--color-bg-inset);
  border-radius: var(--radius-3);
}

@media (max-width: 720px) {
  .input-surface {
    padding: var(--space-6);
  }

  .input-header,
  .input-actions {
    display: grid;
    justify-content: stretch;
  }
}
</style>
