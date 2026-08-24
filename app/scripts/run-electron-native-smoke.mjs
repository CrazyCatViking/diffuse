import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const worker = resolve(appRoot, 'scripts/smoke-native-addon.mjs');
const addon = resolve(process.argv[2] ?? resolve(appRoot, 'build/native/diffuse_core.node'));
const helper = process.argv[3] ? resolve(process.argv[3]) : undefined;
const result = spawnSync(electron, [worker, addon, ...(helper ? [helper] : [])], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Electron native addon smoke failed with exit code ${result.status ?? 'unknown'}.`);
