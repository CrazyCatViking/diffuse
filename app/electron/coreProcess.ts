import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreRpcClient } from './coreRpcClient';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startCoreProcess(): CoreRpcClient {
  const executable = resolveCoreExecutable();
  const registryDir = resolveTreeSitterRegistryDir();
  const child = spawn(executable, ['rpc'], {
    env: {
      ...process.env,
      DIFFUSE_TREE_SITTER_REGISTRY_DIR: registryDir,
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  return new CoreRpcClient(child);
}

function resolveCoreExecutable(): string {
  const devCandidates = [
    resolve(__dirname, '../../../core/zig-out/bin/diffuse'),
    resolve(process.cwd(), '../core/zig-out/bin/diffuse'),
  ];

  for (const candidate of devCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const packagedPath = join(process.resourcesPath, 'diffuse');
  if (existsSync(packagedPath)) return packagedPath;

  return devCandidates[0];
}

function resolveTreeSitterRegistryDir(): string {
  const configured = process.env.DIFFUSE_TREE_SITTER_REGISTRY_DIR;
  if (configured) return configured;

  const devCandidates = [
    resolve(__dirname, '../../../diffuse-tree-sitter'),
    resolve(__dirname, '../../../../diffuse-tree-sitter'),
    resolve(process.cwd(), '../diffuse-tree-sitter'),
    resolve(process.cwd(), '../../diffuse-tree-sitter'),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(join(candidate, 'registry.json'))) return candidate;
  }

  const cacheDir = join(resolveHomeDir(), '.diffuse', 'tree-sitter');
  syncTreeSitterRegistry(cacheDir);
  return cacheDir;
}

function syncTreeSitterRegistry(cacheDir: string): void {
  const gitUrl = process.env.DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL;
  if (!gitUrl) return;

  mkdirSync(dirname(cacheDir), { recursive: true });
  if (existsSync(join(cacheDir, '.git'))) {
    spawnSync('git', ['-C', cacheDir, 'pull', '--ff-only'], { stdio: 'ignore' });
    return;
  }

  spawnSync('git', ['clone', '--depth', '1', gitUrl, cacheDir], { stdio: 'ignore' });
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}
