import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cleanupWhisperRun } from './whisper-worker.browser.mjs';

for (const failure of ['close', 'cache']) {
  test(`owned ${failure} failure persists failed evidence and rejects qualification`, async () => {
    const report = { status: 'passed-controlled-native-worker-check', measured: { words: 23 } };
    const closed = []; let saved;
    await assert.rejects(() => cleanupWhisperRun(report,
      [async () => { closed.push('context'); if (failure === 'close') throw Error('context close failed'); },
        async () => { closed.push('browser'); }, async () => { closed.push('harness'); }, async () => { closed.push('server'); }],
      async () => { if (failure === 'cache') throw Error('cache removal failed'); },
      async () => { saved = structuredClone(report); }), /Whisper cleanup failed/);
    assert.deepEqual(closed, ['context', 'browser', 'harness', 'server'], 'Every owned close is attempted');
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.measured, { words: 23 }, 'Inference observations remain available');
    assert.equal(saved.cleanup.ownedModelCacheRemoved, failure !== 'cache');
    assert.equal(saved.cleanup.resources[0], failure === 'close' ? 'rejected' : 'fulfilled');
  });
}

test('cleanup failure preserves the earlier inference error', async () => {
  const original = Error('Original inference error');
  const report = { status: 'failed', error: String(original) }; let saved;
  await assert.rejects(async () => {
    try { throw original; }
    finally { await cleanupWhisperRun(report, [async () => { throw Error('close failed'); }], async () => {},
      async () => { saved = structuredClone(report); }); }
  }, error => error === original);
  assert.equal(saved.error, String(original));
  assert.equal(saved.status, 'failed');
  assert.match(saved.cleanupError, /Whisper cleanup failed/);
});

test('measured inference becomes passing only after successful owned cleanup', async () => {
  const report = { status: 'measured-controlled-native-worker-check', measured: { words: 23 } }; let saved;
  await cleanupWhisperRun(report, [async () => {}], async () => {}, async () => { saved = structuredClone(report); });
  assert.equal(saved.status, 'passed-controlled-native-worker-check');
  assert.equal(saved.cleanup.ownedModelCacheRemoved, true);
  assert.deepEqual(saved.cleanup.resources, ['fulfilled']);
});

test('uncaught cleanup refusal exits a CLI process nonzero without starting browser inference', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {cleanupWhisperRun} from ${JSON.stringify(new URL('./whisper-worker.browser.mjs', import.meta.url).href)};
     await cleanupWhisperRun({status:'passed-controlled-native-worker-check'},[async()=>{throw Error('close failed')}],async()=>{},async()=>{});`],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Whisper cleanup failed/);
});
