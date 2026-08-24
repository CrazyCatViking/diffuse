import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executableName = platform() === 'win32' ? 'diffuse.exe' : 'diffuse';
const executable = resolve('../target/debug', executableName);
const vitest = resolve('node_modules/vitest/vitest.mjs');
const databaseDirectory = mkdtempSync(join(tmpdir(), 'diffuse-rust-integration-'));
let result;
try {
  result = spawnSync(process.execPath, [vitest, 'run', 'electron/coreRpcIntegration.test.ts'], {
    env: {
      ...process.env,
      DIFFUSE_CORE_EXECUTABLE: executable,
      DIFFUSE_WORKBENCH_DATABASE: join(databaseDirectory, 'workbench.sqlite3'),
    },
    stdio: 'inherit',
  });
} finally {
  rmSync(databaseDirectory, { recursive: true, force: true });
}

if (result.error) throw result.error;
process.exit(result.status ?? 1);
