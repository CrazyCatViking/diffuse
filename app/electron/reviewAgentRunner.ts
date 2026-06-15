import { access, mkdir, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
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

type ReviewConfig = {
  provider: string;
  model?: string;
  agent?: string;
  maxParallelAgents: number;
  promptInstructions: string;
};

export type ReviewAgentStatus = {
  running: boolean;
  runIds?: string[];
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
  bridge?: ReviewToolBridge;
  pollTimer?: NodeJS.Timeout;
  stopping: boolean;
  seenBusy: boolean;
  idlePolls: number;
  startedAt: string;
};

export class ReviewAgentRunner {
  private activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly coreRequest: CoreRequest) {}

  status(): ReviewAgentStatus {
    if (this.activeRuns.size === 0) return { running: false };
    return {
      running: true,
      runIds: [...this.activeRuns.keys()],
      provider: 'opencode',
      status: [...this.activeRuns.values()].some((run) => run.stopping) ? 'stopping' : 'running',
    };
  }

  async start(request: ReviewAgentStartRequest): Promise<ReviewAgentStatus> {
    if (this.activeRuns.size > 0) return this.status();
    if (!request.repositoryRoot || !request.sessionId) throw new Error('Missing review agent session context');

    const config = await this.coreRequest<ReviewConfig>('getReviewConfig');
    const groups = partitionFiles(request.files, Math.max(1, Math.min(config.maxParallelAgents || 1, request.files.length || 1)));
    await Promise.all(groups.map((files, index) => this.startRun(request, config, files, index + 1, groups.length)));
    return this.status();
  }

  private async startRun(request: ReviewAgentStartRequest, config: ReviewConfig, files: ChangedFile[], index: number, total: number): Promise<void> {
    const run: ActiveRun = {
      id: createId('agent-run'),
      sessionId: request.sessionId,
      repositoryRoot: request.repositoryRoot,
      stopping: false,
      seenBusy: false,
      idlePolls: 0,
      startedAt: new Date().toISOString(),
    };
    this.activeRuns.set(run.id, run);

    await this.saveRun(run, 'starting', `Preparing opencode review prompt ${index}/${total}`);
    await this.saveAgentState(run, 'starting', `Preparing opencode review prompt ${index}/${total}`);
    await this.saveProgress(run, 'planning', `Preparing review shard ${index}/${total} for ${files.length} changed file${files.length === 1 ? '' : 's'}`, files, []);

    const prompt = reviewPrompt(run, files, config, index, total);
    await writePrompt(request.repositoryRoot, request.sessionId, run.id, prompt);
    await writeOpencodeTools(request.repositoryRoot);

    try {
      run.bridge = await ReviewToolBridge.start(this.coreRequest, run, files);
      process.env.DIFFUSE_REVIEW_BRIDGE_URL = run.bridge.url;
      process.env.DIFFUSE_REVIEW_BRIDGE_TOKEN = run.bridge.token;
      const opencode = await createOpencode({
        config: opencodeConfig(config),
      });
      run.opencode = opencode;

      const created = await opencode.client.session.create({
        query: { directory: request.repositoryRoot },
        body: { title: `Diffuse review ${request.sessionId} ${index}/${total}` },
        throwOnError: true,
      });
      run.opencodeSessionId = created.data.id;
      await this.saveRun(run, 'planning', 'Created opencode review session');

      await opencode.client.session.promptAsync({
        path: { id: run.opencodeSessionId },
        query: { directory: request.repositoryRoot },
        body: {
          agent: process.env.DIFFUSE_OPENCODE_AGENT ?? config.agent,
          model: opencodeModel(config),
          parts: [{ type: 'text', text: prompt }],
        },
        throwOnError: true,
      });
      await this.saveRun(run, 'running', 'opencode review is running');
      await this.saveAgentState(run, 'running', 'opencode review is running');
      await this.saveProgress(run, 'running', 'opencode review is running', files, []);
      this.pollStatus(run, files);
    } catch (error) {
      this.activeRuns.delete(run.id);
      this.closeRun(run);
      await this.saveRun(run, 'failed', errorMessage(error));
      await this.saveAgentState(run, 'failed', errorMessage(error));
      await this.saveProgress(run, 'failed', errorMessage(error), files, []);
      throw error;
    }
  }

  async stop(): Promise<ReviewAgentStatus> {
    if (this.activeRuns.size === 0) return { running: false };

    await Promise.all([...this.activeRuns.values()].map(async (run) => {
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
    }));
    return this.status();
  }

  dispose(): void {
    for (const run of this.activeRuns.values()) this.closeRun(run);
    this.activeRuns.clear();
  }

  private pollStatus(run: ActiveRun, files: ChangedFile[]): void {
    run.pollTimer = setTimeout(() => {
      void this.checkStatus(run, files);
    }, 1000);
  }

  private async checkStatus(run: ActiveRun, files: ChangedFile[]): Promise<void> {
    if (!this.activeRuns.has(run.id) || !run.opencode || !run.opencodeSessionId) return;

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
    this.activeRuns.delete(run.id);
    this.closeRun(run);
    await this.saveRun(run, status, message);
    await this.saveAgentState(run, status, message);
    await this.saveProgress(run, status, message, [], files.map(filePath));
  }

  private closeRun(run: ActiveRun): void {
    if (run.pollTimer) clearTimeout(run.pollTimer);
    run.opencode?.server.close();
    run.bridge?.close();
    run.pollTimer = undefined;
    run.opencode = undefined;
    run.bridge = undefined;
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
    const method = status === 'starting' ? 'createReviewRun' : finished ? 'finishReviewRun' : 'updateReviewRun';
    await this.coreRequest(method, {
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

const opencodeConfig = (config: ReviewConfig) => {
  const model = opencodeModel(config);
  return model ? { model: `${model.providerID}/${model.modelID}` } : {};
};

class ReviewToolBridge {
  private constructor(
    private readonly server: http.Server,
    readonly url: string,
    readonly token: string,
  ) {}

  static async start(coreRequest: CoreRequest, run: ActiveRun, files: ChangedFile[]): Promise<ReviewToolBridge> {
    const token = createId('tool-token');
    const server = http.createServer((request, response) => {
      void handleToolRequest(coreRequest, run, files, token, request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start review tool bridge');
    return new ReviewToolBridge(server, `http://127.0.0.1:${address.port}`, token);
  }

  close(): void {
    this.server.close();
  }
}

const handleToolRequest = async (coreRequest: CoreRequest, run: ActiveRun, files: ChangedFile[], token: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  try {
    if (request.method !== 'POST') return writeJson(response, 405, { error: 'Method not allowed' });
    if (request.headers.authorization !== `Bearer ${token}`) return writeJson(response, 401, { error: 'Unauthorized' });

    const body = await readJsonBody(request);
    if (request.url === '/add-comment') {
      const result = await coreRequest('addReviewCommentPayload', { sessionId: run.sessionId, runId: run.id, comment: body });
      return writeJson(response, 200, result);
    }

    if (request.url === '/set-progress') {
      const result = await coreRequest('saveReviewProgress', { sessionId: run.sessionId, progress: body });
      return writeJson(response, 200, result);
    }

    if (request.url === '/set-agent-state') {
      const result = await coreRequest('saveReviewAgentState', { sessionId: run.sessionId, agent: { ...body, id: run.id, provider: 'opencode' } });
      return writeJson(response, 200, result);
    }

    if (request.url === '/changed-files') return writeJson(response, 200, files);

    if (request.url === '/diff') {
      const fileId = stringField(body, 'fileId');
      const result = await coreRequest('getDiffRenderModel', {
        fileId,
        options: { mode: 'inline', context: 'full' },
        target: { includeStaged: true, includeUnstaged: true },
      });
      return writeJson(response, 200, result);
    }

    return writeJson(response, 404, { error: 'Unknown review tool endpoint' });
  } catch (error) {
    return writeJson(response, 500, { error: errorMessage(error) });
  }
};

const readJsonBody = (request: IncomingMessage): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('error', reject);
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
  });
};

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const stringField = (value: Record<string, unknown>, field: string): string => {
  const result = value[field];
  if (typeof result !== 'string' || result.trim().length === 0) throw new Error(`Missing ${field}`);
  return result;
};

const opencodeModel = (config: ReviewConfig) => {
  const value = process.env.DIFFUSE_OPENCODE_MODEL ?? config.model;
  if (!value) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  };
};

const writePrompt = async (repositoryRoot: string, sessionId: string, runId: string, prompt: string): Promise<void> => {
  const promptDir = join(repositoryRoot, '.diffuse', 'reviews', 'sessions', sessionId, 'prompts');
  await mkdir(promptDir, { recursive: true });
  await writeFile(join(promptDir, `${runId}.md`), prompt);
};

const writeOpencodeTools = async (repositoryRoot: string): Promise<void> => {
  const toolDir = join(repositoryRoot, '.opencode', 'tools');
  await mkdir(toolDir, { recursive: true });
  await ensureOpencodePackage(repositoryRoot);
  await writeFile(join(toolDir, 'diffuse_review.ts'), diffuseReviewToolSource());
};

const ensureOpencodePackage = async (repositoryRoot: string): Promise<void> => {
  const packagePath = join(repositoryRoot, '.opencode', 'package.json');
  try {
    await access(packagePath);
  } catch {
    await writeFile(packagePath, `${JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.17.7' } }, null, 2)}\n`);
  }
};

const diffuseReviewToolSource = (): string => `import { tool } from "@opencode-ai/plugin";

const callDiffuse = async (path: string, body: unknown) => {
  const url = process.env.DIFFUSE_REVIEW_BRIDGE_URL;
  const token = process.env.DIFFUSE_REVIEW_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("Diffuse review bridge is not configured");
  const response = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || "Diffuse review tool failed: " + response.status);
  return text;
};

export const add_comment = tool({
  description: "Add a validated Diffuse review comment anchored to a changed file line.",
  args: {
    filePath: tool.schema.string().describe("Changed file path to comment on"),
    side: tool.schema.enum(["old", "new"]).describe("Diff side"),
    startLine: tool.schema.number().describe("1-based start line"),
    endLine: tool.schema.number().describe("1-based end line"),
    body: tool.schema.string().describe("Actionable review comment"),
    severity: tool.schema.enum(["info", "low", "medium", "high", "critical"]).optional(),
    category: tool.schema.enum(["bug", "security", "performance", "maintainability", "test", "style", "question"]).optional(),
    confidence: tool.schema.enum(["low", "medium", "high"]).optional(),
    selectedText: tool.schema.string().optional(),
  },
  async execute(args) {
    return callDiffuse("/add-comment", args);
  },
});

export const set_progress = tool({
  description: "Update Diffuse review progress.",
  args: {
    status: tool.schema.enum(["idle", "planning", "running", "paused", "completed", "failed", "cancelled"]),
    message: tool.schema.string().optional(),
    totalFiles: tool.schema.number().optional(),
    reviewedFiles: tool.schema.number().optional(),
    activeFiles: tool.schema.array(tool.schema.string()).optional(),
    pendingFiles: tool.schema.array(tool.schema.string()).optional(),
    completedFiles: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args) {
    return callDiffuse("/set-progress", { ...args, lastActivityAt: new Date().toISOString() });
  },
});

export const set_agent_state = tool({
  description: "Update Diffuse review agent state with summarized activity.",
  args: {
    status: tool.schema.enum(["starting", "running", "idle", "completed", "failed", "cancelled"]),
    currentPhase: tool.schema.string().optional(),
    currentFile: tool.schema.string().optional(),
    lastThoughtSummary: tool.schema.string().optional(),
  },
  async execute(args) {
    return callDiffuse("/set-agent-state", { ...args, updatedAt: new Date().toISOString() });
  },
});

export const get_changed_files = tool({
  description: "Get the changed files assigned to this Diffuse review run.",
  args: {},
  async execute() {
    return callDiffuse("/changed-files", {});
  },
});

export const get_diff = tool({
  description: "Get the full diff render model for a changed file.",
  args: { fileId: tool.schema.string().describe("Changed file id/path") },
  async execute(args) {
    return callDiffuse("/diff", args);
  },
});
`;

const reviewPrompt = (run: ActiveRun, files: ChangedFile[], config: ReviewConfig, index: number, total: number): string => {
  const fileList = files.map((file) => `- ${filePath(file)} (${file.status})`).join('\n') || '- No changed files detected';

  return `You are the built-in Diffuse code review agent using opencode.

Review session: ${run.sessionId}
Agent run: ${run.id}
Review shard: ${index}/${total}

Read and follow the Diffuse Review Spec in docs/review-spec-v1.md if present.

Use the Diffuse review tools to inspect changes and add findings:
- diffuse_review_get_changed_files
- diffuse_review_get_diff
- diffuse_review_add_comment
- diffuse_review_set_progress
- diffuse_review_set_agent_state

Do not hand-write review thread JSON unless the tools are unavailable.

Also keep progress and agent state up to date when useful:
.diffuse/reviews/sessions/${run.sessionId}/progress.json
.diffuse/reviews/sessions/${run.sessionId}/agents/${run.id}.json

Only review the changed files assigned to this shard. Do not edit application source files.

Review instructions:
${config.promptInstructions}

Changed files:
${fileList}
`;
};

const filePath = (file: ChangedFile): string => file.newPath ?? file.oldPath ?? file.id;

const partitionFiles = (files: ChangedFile[], count: number): ChangedFile[][] => {
  if (files.length === 0) return [[]];

  const groups = Array.from({ length: Math.max(1, count) }, () => [] as ChangedFile[]);
  files.forEach((file, index) => {
    groups[index % groups.length].push(file);
  });
  return groups.filter((group) => group.length > 0);
};

const createId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
