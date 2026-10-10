import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cleanupWhisperRun, fetchWhisperPayload } from './whisper-worker.browser.mjs';

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


test('approved Whisper redirects are checked before transport and never forward credentials', async () => {
  const url = 'https://huggingface.co/synthetic/fixture/resolve/' + 'a'.repeat(40) + '/config.json';
  const exact = new Map([[url, { sha256: 'b'.repeat(64) }]]);
  for (const target of [
    'http://us.aws.cdn.hf.co/asset', 'https://other.example/asset',
    'https://user:password@us.aws.cdn.hf.co/asset', 'https://us.aws.cdn.hf.co:444/asset',
    'https://us.aws.cdn.hf.co/asset#fragment',
  ]) {
    const calls = [];
    await assert.rejects(fetchWhisperPayload(url, exact, async (request, options) => {
      calls.push(request);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.headers, undefined);
      return new Response(null, { status: 302, headers: { location: target } });
    }), /Whisper redirect/);
    assert.deepEqual(calls, [url], 'Disallowed destination is never contacted');
  }
  let contacted = false;
  await assert.rejects(fetchWhisperPayload(url + '?unapproved', exact, async () => {
    contacted = true;
  }), /Unapproved Whisper/);
  assert.equal(contacted, false);
});

test('approved Whisper redirect chain stays bound and bounded', async () => {
  const url = 'https://huggingface.co/synthetic/fixture/resolve/' + 'a'.repeat(40) + '/config.json';
  const exact = new Map([[url, { sha256: 'b'.repeat(64) }]]);
  const target = 'https://us.aws.cdn.hf.co/asset?signed=synthetic';
  const calls = [];
  const result = await fetchWhisperPayload(url, exact, async (request, options) => {
    calls.push({ request, signal: options.signal });
    return request === url
      ? new Response(null, { status: 302, headers: { location: target } })
      : new Response('approved synthetic bytes');
  });
  assert.deepEqual(calls.map(call => call.request), [url, target]);
  assert.equal(calls[0].signal, calls[1].signal, 'One deadline bounds the entire chain');
  assert.equal(result.redirects.length, 1);
  assert.equal(result.redirects[0].to, 'https://us.aws.cdn.hf.co/asset');
  assert.ok(!JSON.stringify(result.redirects).includes('signed=synthetic'));
  assert.match(result.redirects[0].targetSha256, /^[a-f0-9]{64}$/);
  assert.equal(await result.response.text(), 'approved synthetic bytes');
  let attempts = 0;
  await assert.rejects(fetchWhisperPayload(url, exact, async () => {
    attempts++;
    return new Response(null, { status: 302, headers: { location: target } });
  }), /Whisper redirect limit/);
  assert.equal(attempts, 6);
});


test('failed Whisper download responses retire their body before refusal', async () => {
  const url = 'https://huggingface.co/synthetic/fixture/resolve/' + 'a'.repeat(40) + '/config.json';
  const exact = new Map([[url, { sha256: 'b'.repeat(64) }]]);
  for (const status of [206, 404, 503]) {
    let cancelled = false;
    await assert.rejects(fetchWhisperPayload(url, exact, async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status })), /Whisper payload response/);
    assert.equal(cancelled, true);
  }
});
