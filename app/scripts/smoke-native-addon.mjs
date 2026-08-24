import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonPath = resolve(process.argv[2] ?? resolve(appRoot, 'build/native/diffuse_core.node'));
const helperPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const require = createRequire(import.meta.url);
const loaded = require(addonPath);
const candidate = loaded?.default ?? loaded;
const createCore =
  typeof candidate === 'function'
    ? candidate
    : typeof candidate?.createCore === 'function'
      ? candidate.createCore
      : typeof candidate?.DiffuseCore === 'function'
        ? (options) => new candidate.DiffuseCore(options)
        : undefined;

if (!createCore) throw new Error(`Native addon has no supported factory export: ${addonPath}`);

const core = createCore({
  databasePath: ':memory:',
  onEventBatch: () => undefined,
  ...(helperPath ? { syntaxRunnerPath: helperPath } : {}),
});
const version = await core.getVersion();
if (version?.name !== 'diffuse' || typeof version.version !== 'string') {
  throw new Error(`Native addon returned invalid version information: ${JSON.stringify(version)}`);
}
const health = await core.health();
if (health?.status !== 'healthy') throw new Error(`Native addon is not healthy: ${JSON.stringify(health)}`);
await Promise.all([core.shutdown(), core.shutdown()]);

console.log(`Loaded ${addonPath} with ${process.release.name} ${process.versions.node}`);
