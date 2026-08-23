import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zigAppDir = join(root, 'core/src/app');
const tsContractPath = join(root, 'app/src/lib/coreContract.ts');
const tsContract = readFileSync(tsContractPath, 'utf8');

const zigMethodOccurrences = readZigMethodOccurrences();
const tsMethodOccurrences = readStringArray('coreMethodNames');
const tsMethodMapOccurrences = readTypeKeys('CoreMethods', /^  ([A-Za-z][A-Za-z0-9]*):/gm);
const tsEventOccurrences = readStringArray('coreEventNames');
const tsEventMapOccurrences = readTypeKeys('CoreEventMap', /^  '([^']+)':/gm);
const zigEventOccurrences = readZigEventOccurrences();

let failed = false;
failed ||= reportDuplicates('Zig RPC registrations', zigMethodOccurrences);
failed ||= reportDuplicates('TypeScript coreMethodNames', tsMethodOccurrences);
failed ||= reportDuplicates('TypeScript CoreMethods keys', tsMethodMapOccurrences);
failed ||= reportDuplicates('TypeScript coreEventNames', tsEventOccurrences);
failed ||= reportDuplicates('TypeScript CoreEventMap keys', tsEventMapOccurrences);

failed ||= compareSets(
  'RPC registration and runtime method list drift',
  occurrenceSet(zigMethodOccurrences),
  'registered in Zig',
  occurrenceSet(tsMethodOccurrences),
  'listed in coreMethodNames',
);
failed ||= compareSets(
  'RPC runtime list and method-map drift',
  occurrenceSet(tsMethodOccurrences),
  'listed in coreMethodNames',
  occurrenceSet(tsMethodMapOccurrences),
  'defined in CoreMethods',
);
failed ||= compareSets(
  'Core event producer and runtime event-list drift',
  occurrenceSet(zigEventOccurrences),
  'emitted by Zig',
  occurrenceSet(tsEventOccurrences),
  'listed in coreEventNames',
);
failed ||= compareSets(
  'Core runtime event-list and event-map drift',
  occurrenceSet(tsEventOccurrences),
  'listed in coreEventNames',
  occurrenceSet(tsEventMapOccurrences),
  'defined in CoreEventMap',
);

if (failed) process.exit(1);

console.log(
  `RPC contract check passed (${occurrenceSet(zigMethodOccurrences).size} methods, ${occurrenceSet(zigEventOccurrences).size} events).`,
);

function readZigMethodOccurrences() {
  const handlerFiles = readdirSync(zigAppDir)
    .filter((name) => name.endsWith('_handlers.zig'))
    .sort()
    .map((name) => join(zigAppDir, name));
  return readMatches(handlerFiles, /server\.handle\(\s*"([^"]+)"\s*,/g);
}

function readZigEventOccurrences() {
  const eventSourceFiles = readdirSync(zigAppDir)
    .filter((name) => name.endsWith('.zig'))
    .sort()
    .map((name) => join(zigAppDir, name));
  return readMatches(eventSourceFiles, /\{\\"jsonrpc\\":\\"2\.0\\",\\"method\\":\\"([^"\\]+)\\"/g);
}

function readMatches(filePaths, pattern) {
  const occurrences = [];
  for (const filePath of filePaths) {
    const source = readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(pattern)) {
      occurrences.push({
        name: match[1],
        location: `${basename(filePath)}:${lineNumber(source, match.index)}`,
      });
    }
  }
  return occurrences;
}

function readStringArray(name) {
  const match = tsContract.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  if (!match) failNow(`Could not find ${name} in app/src/lib/coreContract.ts.`);

  const occurrences = [];
  for (const item of match[1].matchAll(/'([^']+)'/g)) {
    occurrences.push({
      name: item[1],
      location: `${basename(tsContractPath)}:${lineNumber(tsContract, match.index + item.index)}`,
    });
  }
  return occurrences;
}

function readTypeKeys(name, pattern) {
  const marker = `export type ${name} =`;
  const markerIndex = tsContract.indexOf(marker);
  if (markerIndex === -1) failNow(`Could not find ${name} in app/src/lib/coreContract.ts.`);
  const openBrace = tsContract.indexOf('{', markerIndex + marker.length);
  const closeBrace = findMatchingBrace(tsContract, openBrace);
  if (openBrace === -1 || closeBrace === -1) failNow(`Could not parse ${name} in app/src/lib/coreContract.ts.`);

  const body = tsContract.slice(openBrace + 1, closeBrace);
  const occurrences = [];
  for (const match of body.matchAll(pattern)) {
    occurrences.push({
      name: match[1],
      location: `${basename(tsContractPath)}:${lineNumber(tsContract, openBrace + 1 + match.index)}`,
    });
  }
  return occurrences;
}

function findMatchingBrace(source, openBrace) {
  if (openBrace === -1) return -1;
  let depth = 0;
  let quote = null;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function reportDuplicates(label, occurrences) {
  const grouped = new Map();
  for (const occurrence of occurrences) {
    const entries = grouped.get(occurrence.name) ?? [];
    entries.push(occurrence);
    grouped.set(occurrence.name, entries);
  }
  const duplicates = [...grouped].filter(([, entries]) => entries.length > 1);
  if (duplicates.length === 0) return false;

  console.error(`${label} contain duplicate names:`);
  for (const [name, entries] of duplicates) {
    console.error(`  - ${name}: ${entries.map((entry) => entry.location).join(', ')}`);
  }
  return true;
}

function compareSets(label, left, leftLabel, right, rightLabel) {
  const onlyLeft = [...left].filter((name) => !right.has(name)).sort();
  const onlyRight = [...right].filter((name) => !left.has(name)).sort();
  if (onlyLeft.length === 0 && onlyRight.length === 0) return false;

  console.error(`${label}:`);
  if (onlyLeft.length > 0) console.error(`  Only ${leftLabel}: ${onlyLeft.join(', ')}`);
  if (onlyRight.length > 0) console.error(`  Only ${rightLabel}: ${onlyRight.join(', ')}`);
  return true;
}

function occurrenceSet(occurrences) {
  return new Set(occurrences.map((occurrence) => occurrence.name));
}

function lineNumber(source, index = 0) {
  return source.slice(0, index).split('\n').length;
}

function failNow(message) {
  console.error(message);
  process.exit(1);
}
