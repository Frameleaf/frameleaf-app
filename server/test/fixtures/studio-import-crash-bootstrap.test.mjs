import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadAdmittedWorker } from './studio-import-crash-bootstrap.mjs';

const task = { controlGroup: `/fl111_crash_${'a'.repeat(32)}.slice` };

test('wrong, missing and unreadable membership cannot load tsx or the worker', async () => {
  let loads = 0;
  const load = async () => loads++;
  await assert.rejects(loadAdmittedWorker(task, async () => '0::/system.slice/driver.service', load));
  await assert.rejects(loadAdmittedWorker({}, async () => `0::${task.controlGroup}`, load));
  await assert.rejects(
    loadAdmittedWorker(
      task,
      async () => {
        throw new Error('unreadable');
      },
      load,
    ),
  );
  assert.equal(loads, 0);
});

test('mock transform helper inherits membership only after completed admission readback', async () => {
  const order = [];
  let membership;
  const read = async () => {
    order.push('readback');
    await Promise.resolve();
    membership = `0::${task.controlGroup}`;
    return membership;
  };
  await loadAdmittedWorker(task, read, async (received) => {
    assert.equal(received, task);
    order.push('loader');
    // Model fork inheritance at loader invocation; no process or kernel operation occurs.
    const helperMembership = membership;
    assert.equal(helperMembership, `0::${task.controlGroup}`);
    order.push('helper');
  });
  assert.deepEqual(order, ['readback', 'loader', 'helper']);
});

test('launch has no preload and bootstrap static imports are builtin-only', async () => {
  const bootstrap = await readFile(new URL('studio-import-crash-bootstrap.mjs', import.meta.url), 'utf8');
  const driver = await readFile(new URL('studio-import-crash-driver.py', import.meta.url), 'utf8');
  const imports = bootstrap
    .matchAll(/^import .* from '([^']+)';$/gm)
    .map((match) => match[1])
    .toArray();
  assert.equal(imports.length, 4);
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')));
  assert.ok(!bootstrap.includes('node:child_process'));
  assert.match(driver, /subprocess\.Popen\(\[task\['node'\], str\(BOOTSTRAP\)\]/);
  assert.ok(!driver.includes("'--import'"));
  assert.match(
    bootstrap,
    /await import\('tsx\/esm\/api'\)[\s\S]*register\([\s\S]*await import\('\.\/studio-import-crash-worker\.ts'\)/,
  );
  const admission = driver.indexOf("'child_admission_failed'");
  assert.ok(admission >= 0 && admission < driver.indexOf('child.stdin.write'));
  assert.match(driver, /digest\(BOOTSTRAP\) == record\['bootstrapSha256'\]/);
});
