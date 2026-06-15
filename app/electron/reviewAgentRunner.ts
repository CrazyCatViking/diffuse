import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpencode } from '@opencode-ai/sdk';

type CoreRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

type ChangedFile = {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  status: string;
};

type ReviewAgentStartRequest = {
  repositoryRoot: string;
  sessionId: string;
  files: ChangedFile[];
};

type ReviewRunStatus = 'starting' | 'planning' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

type ReviewRun = {
  id: string;
  sessionId: string;
  provider: string;
  status: ReviewRunStatus;
  currentPhase?: string;
  message?: string;
  opencodeSessionId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ReviewAgentStatus = {
  running: boolean;
  runId?: string;
  provider?: string;
  status?: string;
  message?: string;
};

type ActiveRun = {
  id: string;
  sessionId: string;
  repositoryRoot: string;
  opencode?: Awaited<ReturnType<typeof createOpencode>>;
  opencodeSessionId?: string;
  pollTimer?: NodeJS.Timeout;
  stopping: boolean;
  seenBusy: boolean;
  idlePolls: number;
  startedAt: string;
};

export class ReviewAgentRunner {
  private activeRun: ActiveRun | null = null;

  constructor(private readonly coreRequest: CoreRequest) {}

  status(): ReviewAgentStatus {
    if (!this.activeRun) return { running: false };
    return {
      running: true,
      runId: this.activeRun.id,
      provider: 'opencode',
      status: this.activeRun.stopping ? 'stopping' : 'running',
    };
  }

  async start(request: ReviewAgentStartRequest): Promise<ReviewAgentStatus> {
    if (this.activeRun) return this.status();
    if (!request.repositoryRoot || !request.sessionId) throw new Error('Missing review agent session context');

    const run: ActiveRun = {
      id: createId('agent-run'),
      sessionId: request.sessionId,
      repositoryRoot: request.repositoryRoot,
      stopping: false,
      seenBusy: false,
      idlePolls: 0,
      startedAt: new Date().toISOString(),
    };
    this.activeRun = run;

    await this.saveRun(run, 'starting', 'Preparing opencode review prompt');
    await this.saveAgentState(run, 'starting', 'Preparing opencode review prompt');
    await this.saveProgress(run, 'planning', `Preparing review for ${request.files.length} changed file${request.files.length === 1 ? '' : 's'}`, request.files, []);

    const prompt = reviewPrompt(run, request.files);
    await writePrompt(request.repositoryRoot, request.sessionId, prompt);

    try {
      const opencode = await createOpencode({
        config: opencodeConfig(),
      });
      run.opencode = opencode;

      const created = await opencode.client.session.create({
        query: { directory: request.repositoryRoot },
        body: { title: `Diffuse review ${request.sessionId}` },
        throwOnError: true,
      });
      run.opencodeSessionId = created.data.id;
      await this.saveRun(run, 'planning', 'Created opencode review session');

      await opencode.client.session.promptAsync({
        path: { id: run.opencodeSessionId },
        query: { directory: request.repositoryRoot },
        body: {
          agent: process.env.DIFFUSE_OPENCODE_AGENT,
          model: opencodeModel(),
          parts: [{ type: 'text', text: prompt }],
        },
        throwOnError: true,
      });
      await this.saveRun(run, 'running', 'opencode review is running');
      await this.saveAgentState(run, 'running', 'opencode review is running');
      await this.saveProgress(run, 'running', 'opencode review is running', request.files, []);
      this.pollStatus(run, request.files);
    } catch (error) {
      this.activeRun = null;
      this.closeRun(run);
      await this.saveRun(run, 'failed', errorMessage(error));
      await this.saveAgentState(run, 'failed', errorMessage(error));
      await this.saveProgress(run, 'failed', errorMessage(error), request.files, []);
      throw error;
    }

    return this.status();
  }

  async stop(): Promise<ReviewAgentStatus> {
    const run = this.activeRun;
    if (!run) return { running: false };

    run.stopping = true;
    await this.saveRun(run, 'cancelling', 'Stopping opencode review');
    await this.saveAgentState(run, 'cancelled', 'Stopping opencode review');
    if (run.opencode && run.opencodeSessionId) {
      await run.opencode.client.session.abort({
        path: { id: run.opencodeSessionId },
        query: { directory: run.repositoryRoot },
        throwOnError: true,
      });
    }
    return this.status();
  }

  dispose(): void {
    if (this.activeRun) this.closeRun(this.activeRun);
    this.activeRun = null;
  }

  private pollStatus(run: ActiveRun, files: ChangedFile[]): void {
    run.pollTimer = setTimeout(() => {
      void this.checkStatus(run, files);
    }, 1000);
  }

  private async checkStatus(run: ActiveRun, files: ChangedFile[]): Promise<void> {
    if (this.activeRun?.id !== run.id || !run.opencode || !run.opencodeSessionId) return;

    try {
      const statuses = await run.opencode.client.session.status({
        query: { directory: run.repositoryRoot },
        throwOnError: true,
      });
      const status = statuses.data[run.opencodeSessionId];
      if (status?.type === 'busy') {
        run.seenBusy = true;
        await this.saveRun(run, 'running', 'opencode is reviewing changed files');
        await this.saveAgentState(run, 'running', 'opencode is reviewing changed files');
        this.pollStatus(run, files);
        return;
      }

      if (run.stopping) {
        await this.finishRun(run, files, 'cancelled', 'Review stopped');
        return;
      }

      if (!run.seenBusy && status?.type === 'idle' && run.idlePolls < 3) {
        run.idlePolls += 1;
        this.pollStatus(run, files);
        return;
      }

      if (run.seenBusy || status?.type === 'idle') {
        await this.finishRun(run, files, 'completed', 'Review completed');
        return;
      }

      this.pollStatus(run, files);
    } catch (error) {
      await this.finishRun(run, files, 'failed', errorMessage(error));
    }
  }

  private async finishRun(run: ActiveRun, files: ChangedFile[], status: 'completed' | 'failed' | 'cancelled', message: string): Promise<void> {
    this.activeRun = null;
    this.closeRun(run);
    await this.saveRun(run, status, message);
    await this.saveAgentState(run, status, message);
    await this.saveProgress(run, status, message, [], files.map(filePath));
  }

  private closeRun(run: ActiveRun): void {
    if (run.pollTimer) clearTimeout(run.pollTimer);
    run.opencode?.server.close();
    run.pollTimer = undefined;
    run.opencode = undefined;
  }

  private async saveAgentState(run: ActiveRun, status: string, message: string): Promise<void> {
    const now = new Date().toISOString();
    await this.coreRequest('saveReviewAgentState', {
      sessionId: run.sessionId,
      agent: {
        id: run.id,
        provider: 'opencode',
        status,
        currentPhase: status,
        lastThoughtSummary: message,
        startedAt: now,
        updatedAt: now,
      },
    });
  }

  private async saveRun(run: ActiveRun, status: ReviewRunStatus, message: string): Promise<void> {
    const now = new Date().toISOString();
    const finished = status === 'completed' || status === 'failed' || status === 'cancelled';
    const reviewRun: ReviewRun = {
      id: run.id,
      sessionId: run.sessionId,
      provider: 'opencode',
      status,
      currentPhase: status,
      message,
      opencodeSessionId: run.opencodeSessionId,
      startedAt: run.startedAt,
      updatedAt: now,
      ...(finished ? { completedAt: now } : {}),
    };
    await this.coreRequest('saveReviewRun', {
      sessionId: run.sessionId,
      run: reviewRun,
    });
  }

  private async saveProgress(run: ActiveRun, status: string, message: string, pendingFiles: ChangedFile[] | string[], completedFiles: string[]): Promise<void> {
    const pending = pendingFiles.map((file) => typeof file === 'string' ? file : filePath(file));
    await this.coreRequest('saveReviewProgress', {
      sessionId: run.sessionId,
      progress: {
        status,
        totalFiles: pending.length + completedFiles.length,
        reviewedFiles: completedFiles.length,
        pendingFiles: pending,
        completedFiles,
        activeFiles: pending.slice(0, 1),
        message,
        lastActivityAt: new Date().toISOString(),
      },
    });
  }
}

const opencodeConfig = () => {
  const model = opencodeModel();
  return model ? { model: `${model.providerID}/${model.modelID}` } : {};
};

const opencodeModel = () => {
  const value = process.env.DIFFUSE_OPENCODE_MODEL;
  if (!value) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  };
};

const writePrompt = async (repositoryRoot: string, sessionId: string, prompt: string): Promise<void> => {
  const promptDir = join(repositoryRoot, '.diffuse', 'reviews', 'sessions', sessionId, 'prompts');
  await mkdir(promptDir, { recursive: true });
  await writeFile(join(promptDir, 'initial.md'), prompt);
};

const reviewPrompt = (run: ActiveRun, files: ChangedFile[]): string => {
  const fileList = files.map((file) => `- ${filePath(file)} (${file.status})`).join('\n') || '- No changed files detected';

  return `You are the built-in Diffuse code review agent using opencode.

Review session: ${run.sessionId}
Agent run: ${run.id}

Read and follow the Diffuse Review Spec in docs/review-spec-v1.md if present.

Write review findings as JSON files under:
.diffuse/reviews/sessions/${run.sessionId}/threads/

Also keep progress and agent state up to date when useful:
.diffuse/reviews/sessions/${run.sessionId}/progress.json
.diffuse/reviews/sessions/${run.sessionId}/agents/${run.id}.json

Only review changed files. Do not edit application source files. Do not create comments for non-actionable observations. Prefer high-signal correctness, security, data-loss, race, and test-coverage findings.

Changed files:
${fileList}
`;
};

const filePath = (file: ChangedFile): string => file.newPath ?? file.oldPath ?? file.id;

const createId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
