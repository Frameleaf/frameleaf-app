// No preload, transformation, third-party module or child process before lane admission.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

async function loadWorker(task) {
  const { register } = await import('tsx/esm/api');
  register({ tsconfig: process.env.TSX_TSCONFIG_PATH });
  const { runCrashWorker } = await import('./studio-import-crash-worker.ts');
  await runCrashWorker(task);
}

// Dependency substitution is only for pure admission controls; the CLI uses both defaults.
export async function loadAdmittedWorker(
  task,
  membership = () => readFile('/proc/self/cgroup', 'utf8'),
  load = loadWorker,
) {
  assert.match(task.controlGroup, /^\/fl111_crash_[a-f0-9]{32}\.slice$/);
  const observed = await membership();
  assert.equal(observed.trim(), `0::${task.controlGroup}`);
  // Any transform service spawned by tsx now inherits the already verified lane.
  await load(task);
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  // Also bound a parked child or admitted worker whose controller disappears.
  // eslint-disable-next-line unicorn/no-process-exit
  const deadline = setTimeout(() => process.exit(124), 45_000);
  try {
    assert.equal(process.platform, 'linux');
    assert.ok(process.getuid() > 0 && process.getgid() > 0);
    const lines = input[Symbol.asyncIterator]();
    emit({ state: 'parked', pid: process.pid });
    const first = await lines.next();
    assert.ok(!first.done);
    await loadAdmittedWorker(JSON.parse(first.value));
  } catch {
    // Never emit credentials, paths, media, arbitrary input or application errors.
    emit({ state: 'failed', error: 'crash_worker_refused' });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    input.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
