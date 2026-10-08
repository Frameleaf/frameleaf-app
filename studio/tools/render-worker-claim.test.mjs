import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
const { prepareOneClaim } = await import(process.env.FRAMELEAF_CLAIM_TEST_MODULE ?? './render-worker-claim.mjs');

const sharp = createRequire(new URL('../engine/package.json', import.meta.url))('sharp');

// HTTP contract fixtures, NOT renderer admission or production-server qualification.
async function fixture(t, { inputStatus = 200, redirect, loseLease = false, checksum, sourceBytes, cancelAt, artifactInputDigest = 'a'.repeat(64) } = {}) {
  const operationId = randomUUID();
  const claimToken = randomUUID();
  const sessionToken = randomUUID();
  const bytes = sourceBytes ?? await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const requests = [];
  let heartbeats = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, session: request.headers['x-frameleaf-worker-session'],
      body: body ? JSON.parse(body) : undefined });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/render-workers/claims') {
      // Actual production DTO uses MediaOperationKind.StudioExport's underscore wire value.
      if (body && JSON.parse(body).kinds.some((kind) => kind !== 'studio_export')) {
        response.statusCode = 400; response.end('{}'); return;
      }
      response.end(JSON.stringify({ operationId, claimToken, kind: 'studio_export', projectId: randomUUID(),
        revisionId: 'immutable-revision-7', artifactInputDigest, snapshot: { studio: { resources: [{ key: 'library-asset:fixture', kind: 'library-asset', id: 'fixture', graphPath: '/timeline/items/0', grant: 'render', checksum: checksum ?? createHash('sha1').update(bytes).digest('base64') }], stored: true, revision: 7, graph: {
          metadata: { width: 32, height: 32, fps: 24 },
          timeline: { tracks: [], items: [{ type: 'image', mediaId: 'fixture' }] },
        } } },
        settings: { format: 'mp4' }, inputs: [{ inputId: 'library-asset:fixture', resourceId: 'fixture',
          kind: 'library-asset', checksum: checksum ?? createHash('sha1').update(bytes).digest('base64'),
          url: `/api/render-workers/operations/${operationId}/inputs/signed-grant`,
          expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      }));
    } else if (request.url.endsWith('/heartbeat')) {
      heartbeats++;
      response.end(JSON.stringify({ leaseExtended: !(loseLease && heartbeats > 1), leaseMs: 90_000,
        pauseRequested: false, cancelRequested: heartbeats === cancelAt, refusal: null }));
    } else if (request.url.includes('/inputs/')) {
      response.statusCode = redirect ? 302 : inputStatus;
      if (redirect) response.setHeader('Location', redirect);
      response.end(bytes);
    } else if (request.url.endsWith('/complete') || request.url.endsWith('/cancel-ack')) {
      response.end(JSON.stringify({ accepted: true, refusal: null }));
    } else if (request.url.endsWith('/fail')) {
      response.end(JSON.stringify({ accepted: true, refusal: null }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, claimToken, sessionToken,
    run: (execute) => prepareOneClaim({ execute, serverUrl: `http://127.0.0.1:${server.address().port}`, sessionToken }) };
}

test('downloads only the claim grant, binds all writes, then fails without publishing', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.errorCode, 'worker_executor_unavailable');
  assert.equal(result.published, false);
  assert.equal(f.requests.filter((request) => request.path.includes('/inputs/')).length, 1);
  for (const request of f.requests) {
    assert.equal(request.session, f.sessionToken);
    if (request.path.includes('/operations/') && request.body) assert.equal(request.body.claimToken, f.claimToken);
    assert.ok(!/complete|validation|progress/.test(request.path));
  }
  assert.equal(f.requests.at(-1).body.errorCode, 'worker_executor_unavailable');
});

test('a revoked grant refuses preparation and produces no render output', async (t) => {
  const f = await fixture(t, { inputStatus: 403 });
  assert.equal((await f.run()).errorCode, 'worker_input_preparation_failed');
  assert.equal(f.requests.at(-1).body.errorCode, 'worker_input_preparation_failed');
});

test('changed source bytes are refused before executor handoff', async (t) => {
  const f = await fixture(t, { checksum: '0'.repeat(64) });
  assert.equal((await f.run()).errorCode, 'worker_input_preparation_failed');
});

test('a valid grant and matching checksum cannot prepare text as an image', async (t) => {
  const f = await fixture(t, { sourceBytes: Buffer.from('authorized specimen') });
  assert.equal((await f.run()).errorCode, 'worker_input_preparation_failed');
  assert.equal(f.requests.at(-1).body.errorCode, 'worker_input_preparation_failed');
});

test('redirected grants never forward the session or source request to another origin', async (t) => {
  let leakedRequests = 0;
  const receiver = createServer((_request, response) => { leakedRequests++; response.end('unexpected'); });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { receiver.close(resolve); receiver.closeAllConnections(); }));
  const f = await fixture(t, { redirect: `http://127.0.0.1:${receiver.address().port}/steal` });
  assert.equal((await f.run()).errorCode, 'worker_input_preparation_failed');
  assert.equal(leakedRequests, 0);
});

test('lease loss stops input reads and every subsequent write', async (t) => {
  const f = await fixture(t, { loseLease: true });
  assert.equal((await f.run()).status, 'lease_lost');
  assert.deepEqual(f.requests.map((request) => request.path.split('/').at(-1)), ['claims', 'heartbeat', 'heartbeat']);
});

// Executor plumbing oracle only: the fake HTTP service is never represented as renderer or
// production route qualification. Actual GPU/output measurement is retained separately.
test('explicit executor consumes the immutable prepared source and accepted completion replaces fail', async (t) => {
  const f = await fixture(t);
  let consumed = false;
  const result = await f.run(async ({ engineInputs, claim, request }) => {
    consumed = true;
    assert.equal(engineInputs.input.project.timeline.items[0].mediaId, 'fixture');
    return request(`/api/render-workers/operations/${claim.operationId}/complete`, {
      claimToken: claim.claimToken, artifactSequence: 0, resultAssetId: null });
  });
  assert.equal(consumed, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, true);
  assert.equal(f.requests.at(-1).path.split('/').at(-1), 'complete');
  assert.equal(f.requests.some((entry) => entry.path.endsWith('/fail')), false);
});

test('cancel closes executor and removes private input serving before release acknowledgement', async (t) => {
  const f = await fixture(t, { cancelAt: 4 });
  let released = false;
  let localUrl;
  const result = await f.run(async ({ engineInputs, registerRelease, heartbeat }) => {
    localUrl = engineInputs.input.media[0].url;
    registerRelease(async () => { released = true; });
    await heartbeat();
    assert.fail('cancel must stop the executor');
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(released, true);
  await assert.rejects(fetch(localUrl));
  assert.equal(f.requests.at(-1).path.split('/').at(-1), 'cancel-ack');
  assert.equal(f.requests.at(-1).body.released, true);
});

test('invalid server digest refuses before reading inputs or invoking executor', async (t) => {
  for (const artifactInputDigest of ['', 'x'.repeat(64), 'a'.repeat(63)]) {
    const f = await fixture(t, { artifactInputDigest });
    let invoked = false;
    const result = await f.run(async () => { invoked = true; });
    assert.equal(result.errorCode, 'worker_input_preparation_failed');
    assert.equal(invoked, false);
    assert.equal(f.requests.some(request => request.path.includes('/inputs/')), false);
  }
});
