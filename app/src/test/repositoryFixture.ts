import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Diffuse Test',
  GIT_AUTHOR_EMAIL: 'diffuse@example.test',
  GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Diffuse Test',
  GIT_COMMITTER_EMAIL: 'diffuse@example.test',
  GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
};

export type RepositoryFixture = {
  root: string;
  dispose(): void;
};

export function createRepositoryFixture(): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), 'diffuse-rpc-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Deterministic fixture\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, 'src', 'legacy.ts'), 'export const legacy = true;\n');
  writeFileSync(join(root, 'docs', 'removed.md'), 'This file will be deleted.\n');

  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'deterministic baseline');

  writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'src', 'new.ts'), 'export const added = "fixture";\n');
  git(root, 'add', 'src/new.ts');
  git(root, 'mv', 'src/legacy.ts', 'src/renamed.ts');
  rmSync(join(root, 'docs', 'removed.md'));

  return {
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { env: gitEnvironment, stdio: 'pipe' });
}
