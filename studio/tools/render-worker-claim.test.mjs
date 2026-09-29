import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { prepareOneClaim } from './render-worker-claim.mjs';

// HTTP contract fixtures, NOT renderer admission or production-server qualification.
async function fixture(t, { inputStatus = 200, redirect, loseLease = false, checksum } = {}) {
  const operationId = randomUUID();
  const claimToken = randomUUID();
  const sessionToken = randomUUID();
  const bytes = Buffer.from('authorized specimen');
  const requests = [];
  let heartbeats = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, session: request.headers['x-frameleaf-worker-session'],
      body: body ? JSON.parse(body) : undefined });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/render-workers/claims') {
      response.end(JSON.stringify({ operationId, claimToken, kind: 'studio-export', projectId: randomUUID(),
        revisionId: 'immutable-revision-7', snapshot: { studio: { stored: true, revision: 7, graph: { tracks: [] } } },
        settings: { format: 'mp4' }, inputs: [{ inputId: 'library-asset:fixture', resourceId: 'fixture',
          kind: 'library-asset', checksum: checksum ?? createHash('sha1').update(bytes).digest('base64'),
          url: `/api/render-workers/operations/${operationId}/inputs/signed-grant`,
          expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      }));
    } else if (request.url.endsWith('/heartbeat')) {
      heartbeats++;
      response.end(JSON.stringify({ leaseExtended: !(loseLease && heartbeats > 1), leaseMs: 90_000,
        pauseRequested: false, cancelRequested: false, refusal: null }));
    } else if (request.url.includes('/inputs/')) {
      response.statusCode = redirect ? 302 : inputStatus;
      if (redirect) response.setHeader('Location', redirect);
      response.end(bytes);
    } else if (request.url.endsWith('/fail')) {
      response.end(JSON.stringify({ accepted: true, refusal: null }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, claimToken, sessionToken,
    run: () => prepareOneClaim({ serverUrl: `http://127.0.0.1:${server.address().port}`, sessionToken }) };
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
