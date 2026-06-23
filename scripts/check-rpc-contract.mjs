import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const zigHandlersDir = join(root, 'core/src/app');
const tsContractPath = join(root, 'app/src/lib/coreContract.ts');

const zigMethods = readZigMethods();
const tsMethods = readTypeScriptMethods();

const missingInTypeScript = [...zigMethods].filter((method) => !tsMethods.has(method)).sort();
const missingInZig = [...tsMethods].filter((method) => !zigMethods.has(method)).sort();

if (missingInTypeScript.length > 0 || missingInZig.length > 0) {
  console.error('RPC contract drift detected.');
  if (missingInTypeScript.length > 0) {
    console.error('\nRegistered in Zig but missing from app/src/lib/coreContract.ts:');
    for (const method of missingInTypeScript) console.error(`  - ${method}`);
  }
  if (missingInZig.length > 0) {
    console.error('\nListed in app/src/lib/coreContract.ts but missing from Zig handlers:');
    for (const method of missingInZig) console.error(`  - ${method}`);
  }
  process.exit(1);
}

console.log(`RPC contract check passed (${zigMethods.size} methods).`);

function readZigMethods() {
  const methods = new Set();
  const handlerFiles = readdirSync(zigHandlersDir)
    .filter((name) => name.endsWith('_handlers.zig'))
    .map((name) => join(zigHandlersDir, name));

  const pattern = /server\.handle\(\s*"([^"]+)"\s*,/g;
  for (const filePath of handlerFiles) {
    const source = readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(pattern)) methods.add(match[1]);
  }

  return methods;
}

function readTypeScriptMethods() {
  const source = readFileSync(tsContractPath, 'utf8');
  const arrayMatch = source.match(/coreMethodNames\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!arrayMatch) {
    console.error('Could not find coreMethodNames in app/src/lib/coreContract.ts.');
    process.exit(1);
  }

  const methods = new Set();
  const pattern = /'([^']+)'/g;
  for (const match of arrayMatch[1].matchAll(pattern)) methods.add(match[1]);
  return methods;
}
