import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  const configured = process.env.DIFFUSE_CORE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;

  const executableName = process.platform === 'win32' ? 'diffuse.exe' : 'diffuse';

  const devCandidates = [
    resolve(__dirname, '../../../core/zig-out/bin', executableName),
    resolve(process.cwd(), '../core/zig-out/bin', executableName),
  ];

  for (const candidate of devCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const packagedCandidates = [join(process.resourcesPath, executableName), join(process.resourcesPath, 'core', executableName)];
  for (const candidate of packagedCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const installRoot = process.env.DIFFUSE_INSTALL_ROOT ?? defaultInstallRoot();
  const installedPath = join(installRoot, 'core', executableName);
  if (existsSync(installedPath)) return installedPath;

  return devCandidates[0];
}

function defaultInstallRoot(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'Diffuse');
  return join(resolveHomeDir(), '.local', 'share', 'diffuse');
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
  return cacheDir;
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}
