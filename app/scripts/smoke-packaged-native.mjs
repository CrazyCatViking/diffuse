import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = resolve(process.argv[2] ?? resolve(appRoot, 'dist'));
const addon = await findFile(distDirectory, 'diffuse_core.node');
if (!addon || dirname(addon).split(/[\\/]/).at(-1) !== 'native') {
  throw new Error(`Packaged native addon was not found below ${distDirectory}.`);
}

const resourcesDirectory = dirname(dirname(addon));
const executableName = process.platform === 'win32' ? 'diffuse.exe' : 'diffuse';
const helperName = process.platform === 'win32' ? 'diffuse-rpc.exe' : 'diffuse-rpc';
const helper = join(resourcesDirectory, helperName);
const zigCli = join(resourcesDirectory, executableName);
const application =
  process.platform === 'darwin'
    ? join(resourcesDirectory, '..', 'MacOS', executableName)
    : join(dirname(resourcesDirectory), executableName);

await Promise.all([application, helper, zigCli].map((path) => access(path)));
const worker = resolve(appRoot, 'scripts/smoke-native-addon.mjs');
const result = spawnSync(application, [worker, addon, helper], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Packaged native smoke failed with exit code ${result.status ?? 'unknown'}.`);
console.log(`Smoked unpacked application native resources in ${resourcesDirectory}`);

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const match = await findFile(path, name);
      if (match) return match;
    }
  }
  return undefined;
}
