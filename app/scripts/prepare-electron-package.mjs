import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..');
const executableName = process.platform === 'win32' ? 'diffuse.exe' : 'diffuse';
const sourceCore = join(repoRoot, 'core', 'zig-out', 'bin', executableName);
const nativeDir = join(appRoot, 'build', 'native');
const nativeManifestPath = join(nativeDir, 'manifest.json');
const resourcesDir = join(appRoot, 'build', 'resources');
const destinationCore = join(resourcesDir, executableName);
const helperName = process.platform === 'win32' ? 'diffuse-rpc.exe' : 'diffuse-rpc';
const nativeArtifacts = {
  addon: { staged: join(nativeDir, 'diffuse_core.node'), destination: join(resourcesDir, 'native', 'diffuse_core.node') },
  helper: { staged: join(nativeDir, helperName), destination: join(resourcesDir, helperName) },
};

await rm(resourcesDir, { recursive: true, force: true });

let manifest;
try {
  manifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'));
} catch (error) {
  throw new Error(`Missing or invalid native staging manifest: ${nativeManifestPath}. Run pnpm native:stage:release.`, { cause: error });
}
if (manifest.version !== 1 || manifest.profile !== 'release') {
  throw new Error(`Electron packaging requires freshly staged release native artifacts; found profile ${manifest.profile ?? 'unknown'}.`);
}
for (const [kind, artifact] of Object.entries(nativeArtifacts)) {
  const recorded = manifest.artifacts?.[kind];
  if (!recorded || resolve(recorded.staged) !== artifact.staged) {
    throw new Error(`Native staging manifest does not describe the expected ${kind} artifact. Run pnpm native:stage:release.`);
  }
  await requireFile(recorded.source, `native ${kind} source`);
  await requireFile(artifact.staged, `staged native ${kind}`);
  const [sourceHash, stagedHash] = await Promise.all([sha256(recorded.source), sha256(artifact.staged)]);
  if (sourceHash !== recorded.sha256 || stagedHash !== recorded.sha256) {
    throw new Error(`Native ${kind} changed after staging. Run pnpm native:stage:release before packaging.`);
  }
}
await requireFile(sourceCore, 'Zig CLI');

await mkdir(join(resourcesDir, 'native'), { recursive: true });
await copyFile(sourceCore, destinationCore);
await Promise.all(Object.values(nativeArtifacts).map(({ staged, destination }) => copyFile(staged, destination)));

if (process.platform !== 'win32') {
  await chmod(destinationCore, 0o755);
  await chmod(nativeArtifacts.helper.destination, 0o755);
}

await writeFile(
  join(resourcesDir, 'metadata.json'),
  `${JSON.stringify(
    {
      version: packageJson.version,
      source: 'electron-builder',
      nativeProfile: manifest.profile,
      nativeAddonSha256: manifest.artifacts.addon.sha256,
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Electron package resources with Zig CLI, Rust helper, and native addon`);

async function requireFile(path, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(`Missing ${label}: ${path}`, { cause: error });
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
