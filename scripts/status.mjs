#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { readDecisions } from '../src/state.mjs';

const cwd = process.cwd();
const cfg = loadConfig(cwd, process.env);
if (!isAbsolute(cfg.stateDir)) cfg.stateDir = resolve(cwd, cfg.stateDir);

const decisions = readDecisions(cfg, 200);
const byAction = {};
const bySignal = {};
let jevCalls = 0;
let latencyTotal = 0;

for (const d of decisions) {
  const key = d.shadowed || d.action === 'allow' ? (d.rawAction ?? d.action) : d.action;
  byAction[key] = (byAction[key] ?? 0) + 1;
  for (const r of d.reasons ?? []) bySignal[r.signal] = (bySignal[r.signal] ?? 0) + 1;
  if (d.jev === 'jev') {
    jevCalls += 1;
    latencyTotal += d.latencyMs ?? 0;
  }
}

const line = (k, v) => console.log(`${k.padEnd(22)} ${v}`);

console.log('jev-guard status');
console.log('----------------');
line('mode', cfg.enforcing ? 'enforce (decisions are applied)' : 'shadow (log only)');
line('api key', cfg.apiKey ? 'set' : 'MISSING — deterministic rules only');
line('model', cfg.model);
line('timeout', `${cfg.timeoutMs}ms`);
line('state dir', cfg.stateDir);
line('decisions on record', decisions.length);
if (jevCalls) line('avg jev latency', `${Math.round(latencyTotal / jevCalls)}ms over ${jevCalls} calls`);

console.log('\noutcomes (raw, before shadow downgrade)');
for (const [action, count] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) {
  line(`  ${action}`, count);
}

const signals = Object.entries(bySignal).sort((a, b) => b[1] - a[1]);
if (signals.length) {
  console.log('\nsignals that crossed a threshold');
  for (const [signal, count] of signals) line(`  ${signal}`, count);
} else {
  console.log('\nno signal has crossed a threshold yet');
}
