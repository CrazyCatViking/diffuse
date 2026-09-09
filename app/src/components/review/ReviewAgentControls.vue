<template>
  <Panel class="agent-controls">
    <ReviewAgentPicker />

    <p>
      ACP reviews require an adapter with HTTP MCP support, use the bound review target, and deny all interactive permissions. Trusted
      executables are not OS-sandboxed.
    </p>

    <Button
      variant="ai"
      :disabled="!review.agentAdapter || review.loading || review.acpReview.busy || !review.session"
      @click="review.startAgentReview()"
      >Start ACP review</Button
    >

    <Button v-if="review.acpReview.hasActiveReview" variant="danger" @click="stopReviews">Stop all ACP review shards</Button>

    <div v-for="run in review.acpReview.runGroups" :key="run.id">
      <p>{{ run.status }}: {{ run.completed }}/{{ run.total }} shards completed, {{ run.fileCount }} assigned files.</p>

      <p v-if="run.status === 'failed' && run.error" role="alert">{{ run.error }}</p>

      <Button v-if="run.status === 'failed' && run.error" variant="secondary" @click="dismiss(run.id)"
        >Stop and dismiss failed review</Button
      >
    </div>

    <p>
      Review files are partitioned using maxParallelAgents with server-enforced MCP scopes and queued waves for large targets. Configure
      provider/model/agent flags explicitly in adapter arguments; legacy overrides are not translated.
    </p>

    <p v-if="review.acpReview.error" role="alert">{{ review.acpReview.error }}</p>

    <details v-if="review.runs.length">
      <summary>Legacy review history (read-only)</summary>

      <p v-for="run in review.runs" :key="run.id">
        {{ run.provider }} / {{ run.status }} / {{ run.startedAt }}{{ run.message ? `: ${run.message}` : '' }}
      </p>
    </details>

    <div v-for="session in review.acpReview.sessions" :key="session.id" class="agent-run">
      <Badge tone="ai">{{ session.adapterId }}: {{ session.state }}</Badge>

      <Button variant="ghost" @click="router.push(agentRoute(workbench.activeWorkspaceId!, session.id))">Open history / reconnect</Button>

      <Button v-if="review.acpReview.active(session.id)" variant="danger" @click="stop(session.id)">{{
        review.acpReview.bindings.some((binding) => binding.sessionId === session.id && binding.runId)
          ? 'Stop review shards'
          : 'Stop session and queued work'
      }}</Button>
    </div>
  </Panel>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useReviewStore } from '../../stores/review';
import { useWorkbenchStore } from '../../stores/workbench';
import { agentRoute } from '../../lib/workspaceRoutes';
import ReviewAgentPicker from './ReviewAgentPicker.vue';
import Button from '../Button.vue';
import Panel from '../ui/Panel.vue';
import Badge from '../ui/Badge.vue';
const review = useReviewStore();
const workbench = useWorkbenchStore();
const router = useRouter();
async function stop(id: string) {
  try {
    await review.stopAgentReview(id);
  } catch (e) {
    review.error = String(e);
  }
}
async function stopReviews() {
  try {
    await review.acpReview.stopReviews();
  } catch (e) {
    review.error = String(e);
  }
}
async function dismiss(id: string) {
  try {
    await review.acpReview.dismissWave(id);
  } catch (e) {
    review.error = String(e);
  }
}
</script>

<style scoped lang="scss">
.agent-controls {
  display: grid;
  gap: var(--space-4);
}
.agent-run {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
}
p {
  margin: 0;
  color: var(--color-text-muted);
}
</style>
