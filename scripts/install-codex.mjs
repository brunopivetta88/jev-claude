#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Installs the Codex hook pack by merging into ~/.codex/hooks.json (default)
 * or <repo>/.codex/hooks.json (--project). Existing hooks are preserved:
 * this only appends jev-guard's own entries, and it is idempotent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '..', 'bin', 'codex-hook.mjs');
const template = JSON.parse(readFileSync(join(here, '..', 'codex', 'hooks.json'), 'utf8'));

const project = process.argv.includes('--project');
const target = project
  ? join(process.cwd(), '.codex', 'hooks.json')
  : join(homedir(), '.codex', 'hooks.json');

const rendered = JSON.parse(JSON.stringify(template).replaceAll('__JEV_GUARD_BIN__', bin));

let existing = { hooks: {} };
if (existsSync(target)) {
  try {
    existing = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    console.error(`Refusing to overwrite unparseable ${target}: ${error.message}`);
    process.exit(1);
  }
}
existing.hooks ??= {};

const isOurs = (entry) =>
  JSON.stringify(entry).includes('jev-guard') || JSON.stringify(entry).includes(bin);

let added = 0;
for (const [event, entries] of Object.entries(rendered.hooks)) {
  const current = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
  const kept = current.filter((e) => !isOurs(e)); // replace our own, keep everyone else's
  existing.hooks[event] = [...kept, ...entries];
  added += entries.length;
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`);

console.log(`jev-guard: wrote ${added} hook entries to ${target}`);
console.log(`jev-guard: hook binary -> ${bin}`);
console.log('jev-guard: set TYPESAFE_API_KEY, then start Codex. Mode defaults to shadow.');
