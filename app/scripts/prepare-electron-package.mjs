import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..');
const executableName = process.platform === 'win32' ? 'diffuse.exe' : 'diffuse';
const sourceCore = join(repoRoot, 'core', 'zig-out', 'bin', executableName);
const resourcesDir = join(appRoot, 'build', 'resources');
const destinationCore = join(resourcesDir, executableName);

await rm(resourcesDir, { recursive: true, force: true });
await mkdir(resourcesDir, { recursive: true });
await copyFile(sourceCore, destinationCore);

if (process.platform !== 'win32') {
  await chmod(destinationCore, 0o755);
}

await writeFile(
  join(resourcesDir, 'metadata.json'),
  `${JSON.stringify(
    {
      version: packageJson.version,
      source: 'electron-builder',
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Electron package resources from ${sourceCore}`);
