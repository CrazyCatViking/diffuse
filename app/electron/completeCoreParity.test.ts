import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { coreEventNames, coreMethodNames, type CoreEvent, type CoreEventName, type CoreMethod } from '../src/lib/coreContract';
import type {
  ReviewAgentState,
  ReviewChatMessage,
  ReviewConfig,
  ReviewedFilesState,
  ReviewProgress,
  ReviewRun,
  ReviewSession,
  ReviewThread,
} from '../src/lib/protocol';
import { createRepositoryFixture, type RepositoryFixture } from '../src/test/repositoryFixture';
import { CoreRpcClient, CoreRpcError } from './coreRpcClient';

const executableName = platform() === 'win32' ? 'diffuse.exe' : 'diffuse';
const executables = {
  Zig: resolve('../core/zig-out/bin', executableName),
  Rust: resolve('../target/debug', executableName),
} as const;
const target = { base: 'HEAD', includeStaged: true, includeUnstaged: true };
const fixedTime = '2026-08-23T10:20:30.000Z';
const mockLspSource = String.raw`'use strict';

const documents = new Map();
let buffer = Buffer.alloc(0);
let initialized = false;
let shuttingDown = false;

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(Buffer.concat([header, body]));
}

function handleMessage(message) {
  const method = message.method;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
          hoverProvider: true,
          textDocumentSync: 1,
        },
      },
    });
    return;
  }
  if (method === 'initialized') {
    initialized = true;
    return;
  }
  if (method === 'textDocument/didOpen') {
    if (initialized) {
      const document = message.params.textDocument;
      documents.set(document.uri, document.text);
    }
    return;
  }
  if (method === 'textDocument/diagnostic') {
    const uri = message.params.textDocument.uri;
    const items = documents.has(uri)
      ? [
          {
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
            severity: 2,
            code: 'PARITY001',
            source: 'parity-mock',
            message: 'Fixed parity diagnostic',
          },
        ]
      : [];
    send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', items } });
    return;
  }
  if (method === 'textDocument/hover') {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: documents.has(uri)
        ? {
            contents: [
              { kind: 'markdown', value: '**Fixed parity hover**' },
              { kind: 'plaintext', value: 'Fixed plain hover' },
            ],
          }
        : null,
    });
    return;
  }
  if (method === 'shutdown') {
    shuttingDown = true;
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (method === 'exit') process.exit(shuttingDown ? 0 : 1);
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

function readMessages() {
  while (true) {
    let headerEnd = buffer.indexOf('\r\n\r\n');
    let separatorLength = 4;
    if (headerEnd === -1) {
      headerEnd = buffer.indexOf('\n\n');
      separatorLength = 2;
    }
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + separatorLength);
      continue;
    }
    const bodyStart = headerEnd + separatorLength;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});
`;

type BackendName = keyof typeof executables;
type JsonRecord = Record<string, unknown>;
type Captured = { ok: true; value: unknown } | { ok: false; error: JsonRecord };
type Backend = {
  name: BackendName;
  fixture: RepositoryFixture;
  sandbox: string;
  home: string;
  child: ChildProcessWithoutNullStreams;
  client: CoreRpcClient;
  events: CoreEvent[];
  stderr: string[];
};
type Difference = { path: string; zig: unknown; rust: unknown };
type Mismatch = { label: string; path: string; zig: unknown; rust: unknown };

describe('complete Zig and Rust core parity', () => {
  it('matches every core method, persistence artifact, event family, and RPC process behavior', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'diffuse-complete-parity-'));
    const mismatches: Mismatch[] = [];
    const exercised = new Set<CoreMethod>();
    let backends: Backend[] = [];

    try {
      for (const [name, executable] of Object.entries(executables)) {
        if (!existsSync(executable)) throw new Error(`Build the ${name} core before running parity tests: ${executable}`);
      }

      backends = (['Zig', 'Rust'] as const).map((name) => createBackend(name, testRoot));
      const [zig, rust] = backends;

      const compare = (label: string, values: [unknown, unknown]): void => {
        const normalized = [
          normalizeIntentionalDifferences(label, normalize(values[0], zig)),
          normalizeIntentionalDifferences(label, normalize(values[1], rust)),
        ] as const;
        if (
          isObject(normalized[0]) &&
          isObject(normalized[1]) &&
          typeof normalized[0].ok === 'boolean' &&
          typeof normalized[1].ok === 'boolean' &&
          normalized[0].ok !== normalized[1].ok
        ) {
          mismatches.push({ label, path: '$', zig: normalized[0], rust: normalized[1] });
          return;
        }
        const difference = firstDifference(normalized[0], normalized[1]);
        if (difference) mismatches.push({ label, ...difference });
      };
      const expectShape = (label: string, values: [Captured, Captured], expected: unknown): void => {
        for (const [index, backend] of backends.entries()) {
          const actual = values[index];
          const normalizedActual = normalize(actual, backend);
          const normalizedExpected = normalize({ ok: true, value: expected }, backend);
          const difference = firstDifference(normalizedExpected, normalizedActual);
          if (difference) {
            mismatches.push({
              label: `${label} (${backend.name})`,
              path: difference.path,
              zig: difference.zig,
              rust: difference.rust,
            });
          }
        }
      };
      const expectCapturedShape = (label: string, values: [Captured, Captured], expected: Captured): void => {
        for (const [index, backend] of backends.entries()) {
          const normalizedActual = normalize(values[index], backend);
          const normalizedExpected = normalize(expected, backend);
          const difference = firstDifference(normalizedExpected, normalizedActual);
          if (difference) {
            mismatches.push({
              label: `${label} (${backend.name})`,
              path: difference.path,
              zig: difference.zig,
              rust: difference.rust,
            });
          }
        }
      };
      const request = async (method: CoreMethod, params?: JsonRecord): Promise<[Captured, Captured]> => {
        exercised.add(method);
        const values = (await Promise.all(backends.map(({ client }) => capture(client, method, params)))) as [Captured, Captured];
        compare(method, values);
        return values;
      };

      compare('fixture HEAD', backends.map(({ fixture }) => git(fixture.root, 'rev-parse', 'HEAD')) as [string, string]);

      const parseErrors = (await Promise.all(backends.map(rawSyntaxError))) as [JsonRecord, JsonRecord];
      compare('malformed JSON-RPC request', parseErrors);
      const unknownMethods = (await Promise.all(backends.map(({ client }) => capture(client, 'methodThatDoesNotExist')))) as [
        Captured,
        Captured,
      ];
      compare('unknown method error', unknownMethods);

      await request('getVersion');
      const missingRepositoryPath = await request('openRepository');
      expectCapturedShape('openRepository missing path error', missingRepositoryPath, {
        ok: false,
        error: { name: 'CoreRpcError', code: -32602, message: 'MissingParam' },
      });
      exercised.add('openRepository');
      const openedRepositories = (await Promise.all([
        capture(zig.client, 'openRepository', { path: zig.fixture.root }),
        capture(rust.client, 'openRepository', { path: rust.fixture.root }),
      ])) as [Captured, Captured];
      compare('openRepository equivalent roots', openedRepositories);

      await request('getDiffTargetDefaults');
      await request('listBranches');
      const changedFiles = await request('listChangedFiles', { target });
      expectShape(
        'changed-file optional path omission',
        changedFiles.map((captured) => {
          if (!captured.ok) return captured;
          const added = (captured.value as JsonRecord[]).find((file) => file.id === 'src/new.ts');
          return { ok: true, value: added } satisfies Captured;
        }) as [Captured, Captured],
        {
          id: 'src/new.ts',
          newPath: 'src/new.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          signature: '<hash>',
        },
      );
      await request('getDiffRenderModel', {
        fileId: 'src/main.ts',
        options: { mode: 'inline', context: 'diff' },
        target,
      });
      await request('getSyntaxSpans', {
        fileId: 'src/main.ts',
        side: 'new',
        startLine: 1,
        endLine: 3,
        options: { context: 'diff' },
        target,
      });

      const lspConfig = await request('getLspConfigInfo');
      for (const [index, backend] of backends.entries()) {
        if (lspConfig[index].ok) {
          const servers = (lspConfig[index].value as JsonRecord).servers as JsonRecord[];
          if (!Array.isArray(servers) || servers.length !== 7) {
            mismatches.push({ label: `getLspConfigInfo server count (${backend.name})`, path: '$.servers', zig: 7, rust: servers });
          }
        }
      }
      await request('getLspInstallInfo', { serverId: 'fixture-copy-only', command: 'missing-lsp-command' });
      const copyOnlyInstall = await request('installLspServer', {
        serverId: 'fixture-copy-only',
        command: 'missing-lsp-command',
      });
      expectShape('copy-only LSP install result', copyOnlyInstall, {
        serverId: 'fixture-copy-only',
        command: 'missing-lsp-command',
        installed: false,
        message: 'This language server install is copy-only for now.',
      });
      const lspProgressOffsets = backends.map(({ events }) => events.length);
      await request('installLspServer', { serverId: 'rust-analyzer', command: 'missing-lsp-command' });
      const lspProgress = backends.map((backend, index) =>
        eventsSince(backend, lspProgressOffsets[index], 'lsp/installProgress').map(({ params }) => params),
      ) as [unknown, unknown];
      compare('lsp/installProgress events', lspProgress);
      await request('restartLspServer', { serverId: 'fixture-copy-only' });

      expectShape('mock LSP status', await request('getLspStatus', { fileId: 'src/main.ts', side: 'new', target }), {
        language: 'typescript',
        serverId: 'typescript',
        command: process.execPath,
        configured: true,
        installed: true,
        starting: false,
        running: false,
        configSource: 'user',
        message: 'LSP server ready',
      });
      expectShape('mock LSP diagnostics', await request('getLspDiagnostics', { fileId: 'src/main.ts', side: 'new', target }), {
        status: 'ok',
        language: 'typescript',
        serverId: 'typescript',
        diagnostics: [
          {
            line: 1,
            startColumn: 13,
            endColumn: 19,
            severity: 'warning',
            message: 'Fixed parity diagnostic',
            source: 'parity-mock',
            code: 'PARITY001',
          },
        ],
      });
      expectShape(
        'mock LSP hover',
        await request('getLspHover', {
          fileId: 'src/main.ts',
          side: 'new',
          line: 1,
          column: 13,
          target,
        }),
        {
          status: 'ok',
          language: 'typescript',
          serverId: 'typescript',
          contents: '**Fixed parity hover**\n\nFixed plain hover',
        },
      );

      const defaultConfig = await request('getReviewConfig');
      const config: ReviewConfig = {
        provider: 'opencode',
        model: 'fixture/model',
        agent: 'parity-reviewer',
        maxParallelAgents: 3,
        promptInstructions: 'Fixed parity instructions.',
      };
      await request('saveReviewConfig', { config });
      expectShape('saved review config shape', await request('getReviewConfig'), config);
      expectShape('missing active review shape', await request('getActiveReviewSession'), null);
      expectShape('missing review session list shape', await request('listReviewSessions'), []);

      const session: ReviewSession = {
        id: 'parity-session',
        repositoryRoot: zig.fixture.root,
        target,
        headAtCreation: 'fixed-head',
        createdAt: fixedTime,
        updatedAt: fixedTime,
        title: 'Complete parity review',
        status: 'active',
        participants: [
          { id: 'human-1', kind: 'human', displayName: 'Parity Human' },
          {
            id: 'agent-1',
            kind: 'ai',
            displayName: 'Parity Agent',
            agent: {
              provider: 'opencode',
              model: 'fixture/model',
              harnessId: 'harness-1',
              runId: 'run-provider-1',
              transcriptPath: 'transcripts/run-provider-1.jsonl',
            },
          },
        ],
      };
      const rustSession = { ...session, repositoryRoot: rust.fixture.root };
      const normalizedSession = { ...session, repositoryRoot: '<repo>' };
      exercised.add('createReviewSession');
      const createdSessions = (await Promise.all([
        capture(zig.client, 'createReviewSession', { session }),
        capture(rust.client, 'createReviewSession', { session: rustSession }),
      ])) as [Captured, Captured];
      compare('createReviewSession', createdSessions);
      expectShape('active review session shape', await request('getActiveReviewSession'), normalizedSession);
      expectShape('review session list shape', await request('listReviewSessions'), [normalizedSession]);

      expectShape('missing review progress shape', await request('getReviewProgress', { sessionId: session.id }), null);
      const progress: ReviewProgress = {
        status: 'running',
        totalFiles: 125,
        reviewedFiles: 2,
        activeFiles: ['src/main.ts'],
        pendingFiles: ['src/new.ts'],
        completedFiles: ['src/renamed.ts'],
        message: 'Fixed progress',
        lastActivityAt: fixedTime,
      };
      await request('saveReviewProgress', { sessionId: session.id, progress });
      expectShape('review progress round trip', await request('getReviewProgress', { sessionId: session.id }), progress);

      expectShape('missing reviewed-files shape', await request('getReviewedFiles', { sessionId: session.id }), { files: {} });
      const reviewedFiles = {
        files: {
          'src/main.ts': {
            fileId: 'src/main.ts',
            reviewedAt: fixedTime,
            reviewedBy: 'human-1',
            signature: 'fixed-signature-main',
            externalFileField: 'preserved',
          },
        },
        externalStateField: 7,
      } as unknown as ReviewedFilesState;
      await request('saveReviewedFiles', { sessionId: session.id, reviewedFiles });
      const updatedReviewed = await request('updateReviewedFiles', {
        sessionId: session.id,
        update: {
          files: {
            'src/new.ts': {
              fileId: 'src/new.ts',
              reviewedAt: fixedTime,
              reviewedBy: 'agent-1',
              signature: 'fixed-signature-new',
            },
          },
          removeFileIds: ['src/main.ts'],
        },
      });
      expectShape('reviewed-files update shape', updatedReviewed, {
        files: {
          'src/new.ts': {
            fileId: 'src/new.ts',
            reviewedAt: fixedTime,
            reviewedBy: 'agent-1',
            signature: 'fixed-signature-new',
          },
        },
        externalStateField: 7,
      });
      await request('getReviewedFiles', { sessionId: session.id });

      expectShape('missing review-agent list shape', await request('getReviewAgentStates', { sessionId: session.id }), []);
      const agent: ReviewAgentState = {
        id: 'agent-state-1',
        provider: 'opencode',
        status: 'running',
        currentPhase: 'reviewing',
        currentFile: 'src/main.ts',
        lastThoughtSummary: 'Fixed thought summary',
        reviewedFiles: ['src/renamed.ts'],
        startedAt: fixedTime,
        updatedAt: fixedTime,
      };
      await request('saveReviewAgentState', { sessionId: session.id, agent });
      expectShape('review-agent round trip', await request('getReviewAgentStates', { sessionId: session.id }), [agent]);

      expectShape('missing review-run list shape', await request('getReviewRuns', { sessionId: session.id }), []);
      const savedRun = reviewRun('run-saved', 'completed');
      await request('saveReviewRun', { sessionId: session.id, run: savedRun });
      const lifecycleRun = reviewRun('run-lifecycle', 'starting');
      await request('createReviewRun', { sessionId: session.id, run: lifecycleRun });
      const runningLifecycle = { ...lifecycleRun, status: 'running' as const, currentPhase: 'analysis', message: 'Analyzing' };
      await request('updateReviewRun', { sessionId: session.id, run: runningLifecycle });
      const finishedLifecycle = {
        ...runningLifecycle,
        status: 'completed' as const,
        currentPhase: 'done',
        message: 'Complete',
        completedAt: fixedTime,
      };
      await request('finishReviewRun', { sessionId: session.id, run: finishedLifecycle });
      await request('saveReviewRun', { sessionId: session.id, run: reviewRun('run-stale', 'running') });
      expectShape('stale review-run recovery count', await request('recoverStaleReviewRuns', { sessionId: session.id }), {
        recovered: 1,
      });
      await request('getReviewRuns', { sessionId: session.id });

      expectShape('missing review-thread list shape', await request('getReviewThreads', { sessionId: session.id }), []);
      const addedThread = reviewThread('thread-added', 'Initial fixed finding');
      await request('addReviewComment', { sessionId: session.id, comment: addedThread });
      const savedThread = reviewThread('thread-saved', 'Saved fixed finding');
      await request('saveReviewThread', { sessionId: session.id, thread: savedThread });
      const payloadThreads = await request('addReviewCommentPayload', {
        sessionId: session.id,
        runId: 'run-saved',
        comment: {
          filePath: 'src/main.ts',
          side: 'new',
          startLine: 1,
          endLine: 1,
          body: '  Payload finding  ',
          severity: 'medium',
          category: 'bug',
          confidence: 'high',
          selectedText: 'answer',
        },
      });
      for (const [index, backend] of backends.entries()) {
        if (payloadThreads[index].ok) {
          const value = payloadThreads[index].value as JsonRecord;
          const expectedKeys = [
            'anchor',
            'createdAt',
            'fileId',
            'id',
            'messages',
            'newPath',
            'sessionId',
            'source',
            'status',
            'updatedAt',
            'severity',
            'category',
            'confidence',
          ].sort();
          const keys = Object.keys(value).sort();
          if (!isDeepStrictEqual(keys, expectedKeys)) {
            mismatches.push({
              label: `addReviewCommentPayload omission shape (${backend.name})`,
              path: '$.keys',
              zig: expectedKeys,
              rust: keys,
            });
          }
        }
      }
      await request('getReviewThreads', { sessionId: session.id });

      expectShape('missing review-chat list shape', await request('getReviewChatMessages', { sessionId: session.id }), []);
      const chat: ReviewChatMessage = {
        id: 'chat-1',
        sessionId: session.id,
        role: 'assistant',
        body: 'Fixed chat body',
        createdAt: fixedTime,
        provider: 'opencode',
        runId: 'run-saved',
        context: {
          fileId: 'src/main.ts',
          selection: addedThread.anchor,
          threadIds: [addedThread.id],
        },
      };
      await request('saveReviewChatMessage', { sessionId: session.id, message: chat });
      expectShape('review-chat round trip', await request('getReviewChatMessages', { sessionId: session.id }), [chat]);

      const grammars = await request('listTreeSitterGrammars');
      for (const [index, backend] of backends.entries()) {
        if (grammars[index].ok) {
          const values = grammars[index].value as JsonRecord[];
          if (values.length !== 21 || values.some(({ id }) => ['ecma', 'html_tags', 'jsx'].includes(String(id)))) {
            mismatches.push({ label: `grammar listing (${backend.name})`, path: '$', zig: '21 installable grammars', rust: values });
          }
        }
      }
      const grammarProgressOffsets = backends.map(({ events }) => events.length);
      await request('installTreeSitterGrammar', { language: 'not-in-registry' });
      const grammarProgress = backends.map((backend, index) =>
        eventsSince(backend, grammarProgressOffsets[index], 'treeSitter/installProgress').map(({ params }) => params),
      ) as [unknown, unknown];
      compare('treeSitter/installProgress events', grammarProgress);
      expectShape('unknown grammar uninstall shape', await request('uninstallTreeSitterGrammar', { language: 'not-in-registry' }), {
        language: 'not-in-registry',
        uninstalled: false,
        message: 'language-not-in-registry',
      });
      await request('syncTreeSitterRegistry', { gitUrl: 'invalid://no-network-parity.test/registry.git' });

      const lifecycleOffsets = backends.map(({ events }) => events.length);
      await request('startSearch', {
        searchId: 'search-lifecycle',
        sessionId: session.id,
        query: 'answer',
        mode: 'content',
        filters: [],
        target,
      });
      await Promise.all(backends.map((backend) => waitForSearchTerminal(backend, 'search-lifecycle')));
      compare(
        'search lifecycle events',
        backends.map((backend, index) => searchEvents(backend, lifecycleOffsets[index], 'search-lifecycle')) as [unknown, unknown],
      );

      const cancelOffsets = backends.map(({ events }) => events.length);
      await request('startSearch', {
        searchId: 'search-cancel',
        sessionId: session.id,
        query: 'bulk parity line',
        mode: 'content',
        filters: [],
        target,
      });
      const cancelResult = await request('cancelSearch', { searchId: 'search-cancel' });
      expectShape('active search cancellation result', cancelResult, { cancelled: true });
      await Promise.all(backends.map((backend) => waitForSearchTerminal(backend, 'search-cancel')));
      const cancelledEvents = backends.map((backend, index) => searchEvents(backend, cancelOffsets[index], 'search-cancel')) as [
        CoreEvent[],
        CoreEvent[],
      ];
      compare('search cancellation events', cancelledEvents);
      for (const [index, backend] of backends.entries()) {
        if (!cancelledEvents[index].some(({ method }) => method === 'search/cancelled')) {
          mismatches.push({
            label: `search/cancelled event (${backend.name})`,
            path: '$.method',
            zig: 'search/cancelled',
            rust: cancelledEvents[index].map(({ method }) => method),
          });
        }
      }
      expectShape('inactive search cancellation result', await request('cancelSearch', { searchId: 'search-does-not-exist' }), {
        cancelled: false,
      });

      for (const backend of backends) {
        writeFileSync(
          join(backend.fixture.root, '.diffuse', 'reviews', 'sessions', session.id, 'reviewed-files.json'),
          '{invalid review json',
        );
      }
      const errorOffsets = backends.map(({ events }) => events.length);
      await request('startSearch', {
        searchId: 'search-error',
        sessionId: session.id,
        query: 'main',
        mode: 'files',
        filters: [],
        target,
      });
      await Promise.all(backends.map((backend) => waitForSearchTerminal(backend, 'search-error')));
      const searchErrorEvents = backends.map((backend, index) => searchEvents(backend, errorOffsets[index], 'search-error')) as [
        CoreEvent[],
        CoreEvent[],
      ];
      compare('search/error events', searchErrorEvents);
      for (const [index, backend] of backends.entries()) {
        if (!searchErrorEvents[index].some(({ method }) => method === 'search/error')) {
          mismatches.push({
            label: `search/error event (${backend.name})`,
            path: '$.method',
            zig: 'search/error',
            rust: searchErrorEvents[index].map(({ method }) => method),
          });
        }
      }
      await request('saveReviewedFiles', {
        sessionId: session.id,
        reviewedFiles: {
          files: {
            'src/new.ts': {
              fileId: 'src/new.ts',
              reviewedAt: fixedTime,
              reviewedBy: 'agent-1',
              signature: 'fixed-signature-new',
            },
          },
          externalStateField: 7,
        },
      });

      await sleep(1_200);
      const repositoryWatcherOffsets = backends.map(({ events }) => events.length);
      for (const backend of backends) writeFileSync(join(backend.fixture.root, 'watcher-probe.txt'), 'repository watcher parity\n');
      if (platform() === 'linux') {
        const repositoryWatcherEvents = (await Promise.all(
          backends.map((backend, index) =>
            waitForEvent(
              backend,
              repositoryWatcherOffsets[index],
              (event) => event.method === 'repository/changed' && event.params.paths.includes('watcher-probe.txt'),
            ),
          ),
        )) as [CoreEvent, CoreEvent];
        compare('repository watcher notification', repositoryWatcherEvents);
      } else {
        await waitForEvent(
          rust,
          repositoryWatcherOffsets[1],
          (event) => event.method === 'repository/changed' && event.params.paths.includes('watcher-probe.txt'),
        );
      }

      await sleep(1_200);
      const reviewWatcherOffsets = backends.map(({ events }) => events.length);
      for (const backend of backends) {
        writeFileSync(join(backend.fixture.root, '.diffuse', 'reviews', 'watcher-probe.json'), '{"watcher":true}\n');
      }
      if (platform() === 'linux') {
        const reviewWatcherEvents = (await Promise.all(
          backends.map((backend, index) =>
            waitForEvent(
              backend,
              reviewWatcherOffsets[index],
              (event) =>
                event.method === 'review/changed' &&
                Array.isArray(event.params.paths) &&
                event.params.paths.includes('.diffuse/reviews/watcher-probe.json'),
            ),
          ),
        )) as [CoreEvent, CoreEvent];
        compare('review watcher notification', reviewWatcherEvents);
      } else {
        await waitForEvent(
          rust,
          reviewWatcherOffsets[1],
          (event) =>
            event.method === 'review/changed' &&
            Array.isArray(event.params.paths) &&
            event.params.paths.includes('.diffuse/reviews/watcher-probe.json'),
        );
      }

      const directReviewEvents = backends.map(({ events }) =>
        events.find(
          (event) =>
            event.method === 'review/changed' &&
            'change' in event.params &&
            event.params.change === 'session.created' &&
            event.params.sessionId === session.id,
        ),
      ) as [CoreEvent | undefined, CoreEvent | undefined];
      compare('direct review/changed notification', directReviewEvents);

      compare('review persistence artifacts', [reviewArtifacts(zig), reviewArtifacts(rust)]);
      const observedFamilies = backends.map(({ events }) => new Set(events.map(({ method }) => method)));
      for (const [index, backend] of backends.entries()) {
        const requiredEvents =
          backend.name === 'Zig' && platform() !== 'linux'
            ? coreEventNames.filter((event) => event !== 'repository/changed')
            : coreEventNames;
        const missing = requiredEvents.filter((event) => !observedFamilies[index].has(event));
        if (missing.length > 0) {
          mismatches.push({
            label: `all core event families (${backend.name})`,
            path: '$',
            zig: coreEventNames,
            rust: [...observedFamilies[index]].sort(),
          });
        }
      }

      const missingMethods = coreMethodNames.filter((method) => !exercised.has(method));
      expect(missingMethods).toEqual([]);
      expect(defaultConfig.every((value) => value.ok)).toBe(true);
    } finally {
      const exits = await shutdownBackends(backends);
      for (const backend of backends) {
        const stderr = backend.stderr.join('').trim();
        if (stderr) {
          mismatches.push({
            label: `clean RPC stderr (${backend.name})`,
            path: '$',
            zig: backend.name === 'Zig' ? normalize(stderr, backend) : '',
            rust: backend.name === 'Rust' ? normalize(stderr, backend) : '',
          });
        }
      }
      if (exits.length === 2) {
        const difference = firstDifference(exits[0], exits[1]);
        if (difference) mismatches.push({ label: 'RPC EOF and child exit behavior', ...difference });
        for (const [index, exit] of exits.entries()) {
          if (exit.code !== 0 || exit.signal !== null) {
            mismatches.push({
              label: `clean RPC process exit (${backends[index].name})`,
              path: '$',
              zig: { code: 0, signal: null },
              rust: exit,
            });
          }
        }
      }
      for (const backend of backends) backend.fixture.dispose();
      rmSync(testRoot, { recursive: true, force: true });
    }

    if (mismatches.length > 0) {
      throw new Error(`Core parity mismatches (${mismatches.length}):\n${JSON.stringify(mismatches, null, 2)}`);
    }
  }, 180_000);
});

function createBackend(name: BackendName, testRoot: string): Backend {
  const fixture = createRepositoryFixture();
  const sandbox = join(testRoot, name.toLowerCase());
  const home = join(sandbox, 'home');
  const bin = join(sandbox, 'bin');
  mkdirSync(join(home, '.diffuse'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const mockLspPath = join(sandbox, 'mock-lsp.cjs');
  writeFileSync(mockLspPath, mockLspSource);
  writeFileSync(
    join(home, '.diffuse', 'lsp.json'),
    `${JSON.stringify({ lsp: { typescript: { command: process.execPath, args: [mockLspPath] } } }, null, 2)}\n`,
  );
  const registry = join(sandbox, 'tree-sitter');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, 'registry.json'), readFileSync(resolve('../core/src/core/tree_sitter_registry.json')));
  mkdirSync(join(fixture.root, 'bulk'), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    const body = Array.from({ length: 320 }, (_, line) => `bulk parity line ${index}-${line}`).join('\n');
    writeFileSync(join(fixture.root, 'bulk', `file-${String(index).padStart(3, '0')}.txt`), `${body}\n`);
  }
  writeFileSync(join(fixture.root, 'notes.data'), 'unknown language fixture\n');
  writeFileSync(join(fixture.root, 'README.md'), '# Deterministic fixture\n\nLSP parity change.\n');

  const rustup = join(bin, platform() === 'win32' ? 'rustup.cmd' : 'rustup');
  writeFileSync(rustup, platform() === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  chmodSync(rustup, 0o755);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    DIFFUSE_GRAMMARS_DIR: join(sandbox, 'grammars'),
    DIFFUSE_TREE_SITTER_REGISTRY_DIR: registry,
    DIFFUSE_WORKBENCH_DATABASE: join(sandbox, 'rust-workbench.sqlite3'),
  };
  if (platform() === 'win32') delete environment.LOCALAPPDATA;
  const child = spawn(executables[name], ['rpc'], { env: environment, stdio: 'pipe' });
  const stderr: string[] = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new CoreRpcClient(child);
  const events: CoreEvent[] = [];
  client.on('event', (event: CoreEvent) => events.push(event));
  return { name, fixture, sandbox, home, child, client, events, stderr };
}

async function capture(client: CoreRpcClient, method: string, params?: JsonRecord): Promise<Captured> {
  try {
    return { ok: true, value: await client.request(method, params) };
  } catch (error) {
    if (error instanceof CoreRpcError) {
      return {
        ok: false,
        error: {
          name: error.name,
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      };
    }
    return {
      ok: false,
      error: { name: error instanceof Error ? error.name : 'UnknownError', message: String(error) },
    };
  }
}

async function rawSyntaxError(backend: Backend): Promise<JsonRecord> {
  const pending = onceWithTimeout<CoreRpcError>(backend.client, 'rpcError', 5_000);
  backend.child.stdin.write('this is not JSON\n');
  const error = await pending;
  return { name: error.name, code: error.code, message: error.message };
}

function onceWithTimeout<T>(emitter: EventEmitter, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (value: T) => {
      clearTimeout(timer);
      resolvePromise(value);
    };
    emitter.once(event, listener);
  });
}

function reviewRun(id: string, status: ReviewRun['status']): ReviewRun {
  return {
    id,
    sessionId: 'parity-session',
    provider: 'opencode',
    status,
    currentPhase: 'fixed-phase',
    message: 'Fixed run message',
    opencodeSessionId: `opencode-${id}`,
    startedAt: fixedTime,
    updatedAt: fixedTime,
    ...(status === 'completed' ? { completedAt: fixedTime } : {}),
  };
}

function reviewThread(id: string, body: string): ReviewThread {
  return {
    id,
    sessionId: 'parity-session',
    fileId: 'src/main.ts',
    oldPath: 'src/main.ts',
    newPath: 'src/main.ts',
    anchor: {
      side: 'new',
      startLine: 1,
      endLine: 1,
      startColumn: 7,
      endColumn: 19,
      selectedText: 'answer',
      hunkHeader: '@@ -1 +1 @@',
      lineText: 'export const answer = 42;',
      diffTargetFingerprint: 'fixed-target-fingerprint',
    },
    status: 'open',
    severity: 'high',
    category: 'bug',
    confidence: 'high',
    source: { kind: 'agent', provider: 'opencode', agentRunId: 'run-saved' },
    createdAt: fixedTime,
    updatedAt: fixedTime,
    messages: [
      {
        id: `message-${id}`,
        authorId: 'agent-1',
        body,
        createdAt: fixedTime,
        updatedAt: fixedTime,
      },
    ],
  };
}

function eventsSince(backend: Backend, offset: number, family: CoreEventName): CoreEvent[] {
  return backend.events.slice(offset).filter(({ method }) => method === family);
}

function searchEvents(backend: Backend, offset: number, searchId: string): CoreEvent[] {
  return backend.events.slice(offset).filter((event) => 'searchId' in event.params && event.params.searchId === searchId);
}

async function waitForSearchTerminal(backend: Backend, searchId: string): Promise<CoreEvent> {
  return waitForEvent(
    backend,
    0,
    (event) =>
      'searchId' in event.params &&
      event.params.searchId === searchId &&
      ['search/done', 'search/cancelled', 'search/error'].includes(event.method),
    30_000,
  );
}

async function waitForEvent(
  backend: Backend,
  offset: number,
  predicate: (event: CoreEvent) => boolean,
  timeoutMs = 10_000,
): Promise<CoreEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = backend.events.slice(offset).find(predicate);
    if (event) return event;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${backend.name} core event`);
}

function reviewArtifacts(backend: Backend): JsonRecord {
  const root = join(backend.fixture.root, '.diffuse', 'reviews');
  const result: JsonRecord = {};
  for (const path of listFiles(root)) {
    const contents = readFileSync(join(root, path), 'utf8');
    try {
      result[path] = JSON.parse(contents);
    } catch {
      result[path] = contents;
    }
  }
  return result;
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  visit(root);
  return files.sort();
}

function normalizeIntentionalDifferences(label: string, value: unknown): unknown {
  if ((label === 'getReviewRuns' || label === 'getReviewThreads') && isObject(value) && value.ok === true && Array.isArray(value.value)) {
    return {
      ...value,
      value: [...value.value].sort((left, right) => String((left as JsonRecord).id).localeCompare(String((right as JsonRecord).id))),
    };
  }
  if ((label === 'repository watcher notification' || label === 'review watcher notification') && isObject(value)) {
    const params = isObject(value.params) ? value.params : undefined;
    if (params && Array.isArray(params.paths)) {
      return { ...value, params: { ...params, paths: [...new Set(params.paths)].sort() } };
    }
  }
  if (label === 'syncTreeSitterRegistry' && isObject(value) && value.ok === true && isObject(value.value) && value.value.synced === false) {
    return { ...value, value: { ...value.value, message: '<external-command-failed>' } };
  }
  return value;
}

function normalize(value: unknown, backend: Backend, key = ''): unknown {
  if (typeof value === 'string') {
    let normalized = value
      .replaceAll(backend.fixture.root, '<repo>')
      .replaceAll(backend.home, '<home>')
      .replaceAll(backend.sandbox, '<sandbox>')
      .replaceAll('\\', '/');
    normalized = normalized.replace(/\b(thread|msg)-(\d{10,})-/g, '$1-<timestamp>-');
    if (/^\d{10,}$/.test(normalized)) normalized = '<timestamp>';
    if (['head', 'signature'].includes(key) && /^[0-9a-f]{7,64}$/i.test(normalized)) normalized = '<hash>';
    return normalized;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, backend, key));
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return Object.fromEntries(
      Object.entries(object).map(([childKey, childValue]) => [
        childKey,
        childKey === 'installed' && ('serverId' in object || 'configured' in object)
          ? '<installed-tool>'
          : normalize(childValue, backend, childKey),
      ]),
    );
  }
  return value;
}

function firstDifference(zig: unknown, rust: unknown, path = '$'): Difference | null {
  if (isDeepStrictEqual(zig, rust)) return null;
  if (Array.isArray(zig) && Array.isArray(rust)) {
    if (zig.length !== rust.length) return { path, zig, rust };
    const zigIds = zig.map((item) => (isObject(item) && typeof item.id === 'string' ? item.id : null));
    const rustIds = rust.map((item) => (isObject(item) && typeof item.id === 'string' ? item.id : null));
    if (zigIds.every((id) => id !== null) && rustIds.every((id) => id !== null) && !isDeepStrictEqual(zigIds, rustIds)) {
      return { path: `${path} order`, zig: zigIds, rust: rustIds };
    }
    for (let index = 0; index < zig.length; index += 1) {
      const difference = firstDifference(zig[index], rust[index], `${path}[${index}]`);
      if (difference) return difference;
    }
  }
  if (isObject(zig) && isObject(rust)) {
    const keys = [...new Set([...Object.keys(zig), ...Object.keys(rust)])].sort((left, right) => {
      const priority = ['id', 'method'];
      const leftPriority = priority.indexOf(left);
      const rightPriority = priority.indexOf(right);
      if (leftPriority !== -1 || rightPriority !== -1) {
        return (leftPriority === -1 ? priority.length : leftPriority) - (rightPriority === -1 ? priority.length : rightPriority);
      }
      return left.localeCompare(right);
    });
    for (const key of keys) {
      if (!(key in zig)) return { path: `${path}.${key}`, zig: '<omitted>', rust: rust[key] };
      if (!(key in rust)) return { path: `${path}.${key}`, zig: zig[key], rust: '<omitted>' };
      const difference = firstDifference(zig[key], rust[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return { path, zig, rust };
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function shutdownBackends(backends: Backend[]): Promise<Array<{ code: number | null; signal: NodeJS.Signals | null }>> {
  const exits = backends.map(({ child }) => childExit(child));
  for (const { child } of backends) child.stdin.end();
  const results = await Promise.all(exits);
  for (const { client } of backends) client.dispose();
  return results;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
