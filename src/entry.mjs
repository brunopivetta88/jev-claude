import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { run } from './run.mjs';

/** Absolute ceiling on a hook process, whatever else goes wrong. */
const HARD_DEADLINE_MS = 8000;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Wires one harness adapter to the core: stdin -> decision -> stdout/exit code.
 * @param {{ normalize: (p: any) => any, emit: (d: any, e: any) => {stdout: string, stderr: string, exitCode: number} }} adapter
 */
export async function main(adapter) {
  const watchdog = setTimeout(() => {
    // Fail open, loudly enough to debug but quietly enough not to derail a turn.
    process.stderr.write('jev-guard: hook exceeded its deadline, allowing\n');
    process.exit(0);
  }, HARD_DEADLINE_MS);
  watchdog.unref?.();

  let payload = {};
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0); // Unparseable input is not something to block on.
  }

  const evt = adapter.normalize(payload);
  const cfg = loadConfig(evt.cwd, process.env);
  if (!isAbsolute(cfg.stateDir)) cfg.stateDir = resolve(evt.cwd, cfg.stateDir);

  const { decision } = await run(evt, cfg);
  const out = adapter.emit(decision, evt);

  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  clearTimeout(watchdog);
  process.exit(out.exitCode);
}
