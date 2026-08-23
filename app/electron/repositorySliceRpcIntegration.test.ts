import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchInfo, DiffTargetDefaults, OpenRepositoryResult, VersionInfo } from '../src/lib/protocol';
import { createRepositoryFixture, type RepositoryFixture } from '../src/test/repositoryFixture';
import { CoreRpcClient, CoreRpcError } from './coreRpcClient';

const executableName = platform() === 'win32' ? 'diffuse.exe' : 'diffuse';
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;
const backends = [
  { name: 'Zig', executable: resolve('../core/zig-out/bin', executableName) },
  { name: 'Rust', executable: resolve('../target/debug', executableName) },
] as const;

type BackendClient = {
  name: string;
  child: ChildProcessWithoutNullStreams;
  client: CoreRpcClient;
};

describe('repository RPC slice parity', () => {
  let dirtyFixture: RepositoryFixture;
  let cleanFixture: RepositoryFixture;
  let databaseDirectory: string;
  let clients: BackendClient[];

  beforeAll(() => {
    for (const backend of backends) {
      if (!existsSync(backend.executable))
        throw new Error(`Build the ${backend.name} core before running parity tests: ${backend.executable}`);
    }

    dirtyFixture = createRepositoryFixture();
    cleanFixture = createRepositoryFixture();
    git(cleanFixture.root, 'reset', '--hard', 'HEAD');
    git(cleanFixture.root, 'clean', '-fd');
    git(cleanFixture.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    databaseDirectory = mkdtempSync(join(tmpdir(), 'diffuse-rust-rpc-'));
    clients = backends.map((backend) => {
      const child = spawn(backend.executable, ['rpc'], {
        env: {
          ...process.env,
          DIFFUSE_WORKBENCH_DATABASE: join(databaseDirectory, `${backend.name.toLowerCase()}.sqlite3`),
        },
        stdio: 'pipe',
      });
      return { ...backend, child, client: new CoreRpcClient(child) };
    });
  });

  afterAll(async () => {
    const exits = (clients ?? []).map(({ child, client }) => {
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
      client.dispose();
      return exited;
    });
    await Promise.all(exits);
    dirtyFixture?.dispose();
    cleanFixture?.dispose();
    if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  });

  it('matches version and stable RPC errors', async () => {
    const results = await Promise.all(
      clients.map(async ({ client }) => {
        const version = await client.request<VersionInfo>('getVersion');
        const unknown = await rejectedRpc(client.request('unknownMethod'));
        const missingPath = await rejectedRpc(client.request('openRepository'));
        return { version, unknown, missingPath };
      }),
    );

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      version: { name: 'diffuse', version: appVersion },
      unknown: { code: -32601, message: 'MethodNotFound' },
      missingPath: { code: -32602, message: 'MissingParam' },
    });
  });

  it('matches dirty repository opening, defaults, and branches', async () => {
    const results = await Promise.all(clients.map(({ client }) => repositoryState(client, dirtyFixture.root)));

    expect(results[0]).toEqual(results[1]);
    expect(results[0].opened.root).toBe(dirtyFixture.root);
    expect(results[0].opened.head).toMatch(/^[0-9a-f]+$/);
    expect(results[0].defaults).toEqual({
      base: 'HEAD',
      includeStaged: true,
      includeUnstaged: true,
      dirty: true,
    });
    expect(results[0].branches).toContainEqual({ name: 'main', current: true });
  });

  it('matches clean upstream defaults and remote branch discovery', async () => {
    const results = await Promise.all(clients.map(({ client }) => repositoryState(client, cleanFixture.root)));

    expect(results[0]).toEqual(results[1]);
    expect(results[0].defaults).toEqual({
      base: 'origin/main',
      compare: 'HEAD',
      includeStaged: false,
      includeUnstaged: false,
      dirty: false,
      upstream: 'origin/main',
    });
    expect(results[0].branches).toEqual([
      { name: 'main', current: true },
      { name: 'origin/main', current: false },
    ]);
  });
});

async function repositoryState(client: CoreRpcClient, root: string) {
  const opened = await client.request<OpenRepositoryResult>('openRepository', { path: root });
  const defaults = await client.request<DiffTargetDefaults>('getDiffTargetDefaults');
  const branches = await client.request<BranchInfo[]>('listBranches');
  return { opened, defaults, branches };
}

async function rejectedRpc(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise;
    throw new Error('Expected RPC request to fail');
  } catch (error) {
    if (!(error instanceof CoreRpcError)) throw error;
    return { code: error.code, message: error.message };
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
}
