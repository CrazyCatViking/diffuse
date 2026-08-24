import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..');
const profile = optionValue('--profile') ?? process.env.DIFFUSE_NATIVE_PROFILE ?? 'debug';

if (profile !== 'debug' && profile !== 'release') {
  throw new Error(`Invalid native profile "${profile}". Expected debug or release.`);
}

const targetOverride = optionValue('--target-dir') ?? process.env.CARGO_TARGET_DIR;
const targetDirectory = targetOverride ? resolve(process.cwd(), targetOverride) : join(repoRoot, 'target');
const profileDirectory = join(targetDirectory, profile);
const libraryName =
  process.platform === 'win32' ? 'diffuse_node.dll' : process.platform === 'darwin' ? 'libdiffuse_node.dylib' : 'libdiffuse_node.so';
const helperName = process.platform === 'win32' ? 'diffuse.exe' : 'diffuse';
const sources = {
  addon: join(profileDirectory, libraryName),
  helper: join(profileDirectory, helperName),
};
const stagingDirectory = join(appRoot, 'build', 'native');
const destinations = {
  addon: join(stagingDirectory, 'diffuse_core.node'),
  helper: join(stagingDirectory, process.platform === 'win32' ? 'diffuse-rpc.exe' : 'diffuse-rpc'),
};

await rm(stagingDirectory, { recursive: true, force: true });

for (const [kind, source] of Object.entries(sources)) {
  try {
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(
      `Cannot stage native ${kind}: expected ${source}. Build the Rust workspace with the ${profile} profile or pass --target-dir.`,
      { cause: error },
    );
  }
}

await mkdir(stagingDirectory, { recursive: true });
await Promise.all(Object.keys(sources).map((kind) => copyFile(sources[kind], destinations[kind])));
if (process.platform !== 'win32') await chmod(destinations.helper, 0o755);

const artifacts = {};
for (const kind of Object.keys(sources)) {
  artifacts[kind] = {
    source: sources[kind],
    staged: destinations[kind],
    sha256: await sha256(destinations[kind]),
  };
}

await writeFile(
  join(stagingDirectory, 'manifest.json'),
  `${JSON.stringify({ version: 1, profile, targetDirectory, artifacts }, null, 2)}\n`,
);

console.log(`Staged ${profile} native addon and Rust helper from ${profileDirectory}`);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
