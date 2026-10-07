import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { assertProjectOnlyReopen, createHarness } from './cross-browser-harness.mjs';

async function startFakeUpstream(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// A minimal proxy-aware GET: sends the absolute URL as the request line, the way a browser
// configured with an HTTP proxy does - not the plain-path form a direct client would send.
function proxiedGet(harnessOrigin, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const harness = new URL(harnessOrigin);
    const req = http.request(
      { host: harness.hostname, port: harness.port, method: 'GET', path: absoluteUrl },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('project-only reopen requires a project-bound transparent browser GET within its observation window', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('{}'));
  const harness = createHarness({upstream: upstream.url});
  try {
    const origin = await harness.listen();
    await proxiedGet(origin, upstream.url + '/api/studio/projects/fixture');
    const offset = harness.observations.length;
    assert.throws(() => assertProjectOnlyReopen(harness.observations.slice(offset), upstream.url, 'fixture'), /project-bound browser GET/);
    await proxiedGet(origin, upstream.url + '/api/studio/projects/fixture');
    assert.equal(assertProjectOnlyReopen(harness.observations.slice(offset), upstream.url, 'fixture').length, 1);
    await proxiedGet(origin, upstream.url + '/api/assets/search');
    assert.throws(() => assertProjectOnlyReopen(harness.observations.slice(offset), upstream.url, 'fixture'), /search or list assets/);
  } finally { await harness.close(); await upstream.close(); }
});

test('project-only reopen refuses a proxied POST metadata search after a valid project GET', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('{}'));
  const harness = createHarness({upstream: upstream.url});
  try {
    const origin = await harness.listen();
    await proxiedGet(origin, upstream.url + '/api/studio/projects/fixture');
    await new Promise((resolve, reject) => {
      const req = http.request(origin, {method: 'POST', path: upstream.url + '/api/search/metadata',
        headers: {'content-type': 'application/json'}}, res => {
        res.resume(); res.on('end', resolve);
      });
      req.on('error', reject); req.end('{}');
    });
    assert.deepEqual(harness.observations.map(r => r.method), ['GET', 'POST']);
    assert.throws(() => assertProjectOnlyReopen(harness.observations, upstream.url, 'fixture'), /search or list assets/);
  } finally { await harness.close(); await upstream.close(); }
});

test('empty, opaque, wrong-project and substituted reopen observations cannot qualify', () => {
  const base = 'http://127.0.0.1:9004';
  const project = {method: 'GET', url: base + '/api/studio/projects/fixture', kind: 'proxied'};
  const tunnel = {method: 'CONNECT', url: '127.0.0.1:9004', kind: 'tunnelled'};
  for (const observations of [[], [tunnel], [project, tunnel],
    [{...project, url: base + '/api/studio/projects/other'}],
    [{...project, url: 'http://127.0.0.1:9005/api/studio/projects/fixture'}],
    [{...project, kind: 'override'}], [{...project, kind: 'blocked'}]])
    assert.throws(() => assertProjectOnlyReopen(observations, base, 'fixture'), /project-bound browser GET|opaque/);
  assert.throws(() => assertProjectOnlyReopen([{...project, url: project.url.replace('http:', 'https:')}], base.replace('http:', 'https:'), 'fixture'), /HTTP origin/);
  for (const method of ['GET', 'POST'])
    for (const path of ['/api/assets', '/api/assets/search', '/api/search', '/api/search/metadata'])
      assert.throws(() => assertProjectOnlyReopen([project, {...project, method, url: base + path}], base, 'fixture'), /search or list assets/);
});

test('proxies an upstream request through unchanged when nothing overrides it', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end(`hello ${req.url}`));
  const harness = createHarness({ upstream: upstream.url });
  const harnessOrigin = await harness.listen();
  try {
    const { status, body } = await proxiedGet(harnessOrigin, `${upstream.url}/src/module.ts`);
    assert.equal(status, 200);
    assert.equal(body, 'hello /src/module.ts');
    assert.deepEqual(
      harness.observations.map((o) => o.kind),
      ['proxied'],
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('serves an override instead of ever reaching upstream', async () => {
  let upstreamHit = false;
  const upstream = await startFakeUpstream((req, res) => {
    upstreamHit = true;
    res.end('should not see this');
  });
  const harness = createHarness({
    upstream: upstream.url,
    overrides: [
      {
        test: (url) => url.pathname === '/effects-matrix',
        respond: () => ({ contentType: 'text/html', body: '<title>Effects matrix</title>' }),
      },
    ],
  });
  const harnessOrigin = await harness.listen();
  try {
    const { status, body } = await proxiedGet(harnessOrigin, `${upstream.url}/effects-matrix`);
    assert.equal(status, 200);
    assert.equal(body, '<title>Effects matrix</title>');
    assert.equal(upstreamHit, false);
    assert.deepEqual(
      harness.observations.map((o) => o.kind),
      ['override'],
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('denies and records a request to a real external origin instead of forwarding it', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('upstream'));
  const harness = createHarness({ upstream: upstream.url });
  const harnessOrigin = await harness.listen();
  try {
    const { status, body } = await proxiedGet(harnessOrigin, 'http://fonts.example.com/font.woff2');
    assert.equal(status, 403);
    assert.match(body, /deny-all/);
    assert.deepEqual(harness.observations, [
      { method: 'GET', url: 'http://fonts.example.com/font.woff2', kind: 'blocked' },
    ]);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('refuses HTTPS CONNECT to anywhere other than the upstream origin, and records it', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('upstream'));
  const harness = createHarness({ upstream: upstream.url });
  const harnessOrigin = await harness.listen();
  try {
    const harnessUrl = new URL(harnessOrigin);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: harnessUrl.hostname,
        port: harnessUrl.port,
        method: 'CONNECT',
        path: 'fonts.example.com:443',
      });
      req.on('connect', (res) => resolve(res));
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(
      harness.observations.map((o) => o.kind),
      ['blocked'],
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('tunnels a CONNECT to the upstream origin itself (Chromium tunnels WebSockets that way)', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('upstream'));
  const upstreamServer = http.createServer((req, res) => res.end('upstream'));
  upstreamServer.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  await upstream.close();
  await new Promise((resolve) => upstreamServer.listen(0, resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstreamServer.address().port}`;
  const harness = createHarness({ upstream: upstreamOrigin });
  const harnessOrigin = await harness.listen();
  try {
    const harnessUrl = new URL(harnessOrigin);
    const upstreamUrl = new URL(upstreamOrigin);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: harnessUrl.hostname,
        port: harnessUrl.port,
        method: 'CONNECT',
        path: `${upstreamUrl.hostname}:${upstreamUrl.port}`,
      });
      req.on('connect', (res, socket) => resolve({ res, socket }));
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.res.statusCode, 200);
    response.socket.destroy();
    assert.deepEqual(
      harness.observations.map((o) => o.kind),
      ['tunnelled'],
    );
  } finally {
    await harness.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});

test('checks overrides in order and only ever uses the first match', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('upstream'));
  const harness = createHarness({
    upstream: upstream.url,
    overrides: [
      { test: () => true, respond: () => ({ body: 'first' }) },
      { test: () => true, respond: () => ({ body: 'second' }) },
    ],
  });
  const harnessOrigin = await harness.listen();
  try {
    const { body } = await proxiedGet(harnessOrigin, `${upstream.url}/anything`);
    assert.equal(body, 'first');
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('inspected CONNECT cannot bypass substitutions, origin checks or upgrade refusal', {timeout: 5_000}, async () => {
  const hits = [];
  const upstream = await startFakeUpstream((req, res) => { hits.push(req.url); res.end('ordinary module'); });
  let foreignHits = 0;
  const foreign = await startFakeUpstream((req, res) => { foreignHits++; res.end('foreign bytes'); });
  const harness = createHarness({ upstream: upstream.url, inspectConnect: true,
    overrides: [{test: url => url.pathname === '/weights.bin', respond: () => ({status: 403, body: 'no model bytes'})}],
  });
  const origin = new URL(await harness.listen());
  const authority = new URL(upstream.url).host;
  const exchange = async (payload, target = authority) => {
    const socket = net.connect(Number(origin.port), origin.hostname);
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    const ended = once(socket, 'end');
    await once(socket, 'connect');
    socket.write(Buffer.concat([Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), Buffer.from(payload)]));
    try { await ended; return Buffer.concat(chunks).toString(); }
    finally { socket.destroy(); }
  };
  try {
    assert.match(await exchange(`GET /weights.bin HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`), /403 Forbidden[\s\S]*no model bytes/);
    assert.deepEqual(hits, [], 'model request inside CONNECT must not reach upstream');
    assert.match(await exchange(`GET /module.js HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`), /ordinary module/);
    assert.deepEqual(hits, ['/module.js']);
    assert.match(await exchange('GET http://models.example/weights.bin HTTP/1.1\r\nHost: models.example\r\nConnection: close\r\n\r\n'), /403 Forbidden/);
    assert.match(await exchange(`GET https://${authority}/weights.bin HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`), /403 Forbidden/);
    assert.match(await exchange(`GET /?token=hmr HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`), /403 Forbidden/);
    assert.match(await exchange(`GET /unknown HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`), /403 Forbidden/);
    assert.match(await exchange('GET /bad-host HTTP/1.1\r\nHost: [invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /403 Forbidden/);
    assert.match(await exchange(Buffer.from([0x16, 0x03, 0x01, 0, 0])), /400 Bad Request/);
    assert.match(await exchange(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), /403 Forbidden/);
    assert.match(await exchange('', 'models.example:443'), /403 Forbidden/);
    assert.deepEqual(hits, ['/module.js'], 'refused upgrades and opaque traffic must never reach upstream');
    assert.ok(!harness.observations.some(o => o.kind === 'tunnelled'));
    assert.ok(harness.observations.some(o => o.kind === 'override' && o.url === upstream.url + '/weights.bin'));
    assert.ok(harness.observations.some(o => o.kind === 'proxied' && o.url === upstream.url + '/module.js'));
    assert.ok(harness.observations.some(o => o.kind === 'blocked' && o.upgradeProtocol === 'vite-hmr'));
    assert.ok(harness.observations.some(o => o.kind === 'error' && o.url === upstream.url + '/unknown'));
    assert.ok(harness.observations.some(o => o.kind === 'error' && o.method === 'CONNECT'));
    const alternate = `//${new URL(foreign.url).host}/weights.bin`;
    for (const response of [
      await proxiedGet(`http://${origin.host}`, upstream.url + alternate),
      {body: await exchange(`GET ${upstream.url}${alternate} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`)},
    ]) assert.match(response.body, /ordinary module/);
    assert.equal(foreignHits, 0, 'a double-slash path must never replace the checked authority');
    assert.deepEqual(hits, ['/module.js', alternate, alternate]);
  } finally { await harness.close(); await upstream.close(); await foreign.close(); }
});

test('inspected CONNECT sockets close with their harness', {timeout: 5_000}, async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('observed body'));
  const harness = createHarness({upstream: upstream.url, inspectConnect: true});
  const origin = new URL(await harness.listen());
  const authority = new URL(upstream.url).host;
  const socket = net.connect(Number(origin.port), origin.hostname);
  try {
    let received = '';
    const body = new Promise(resolve => socket.on('data', chunk => {
      received += chunk.toString();
      if (received.includes('observed body')) resolve();
    }));
    await once(socket, 'connect');
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\nGET /live HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    await body;
    assert.ok(harness.observations.some(o => o.kind === 'proxied' && o.url === upstream.url + '/live'));
    const closed = once(socket, 'close');
    await harness.close();
    await closed;
    assert.equal(socket.destroyed, true);
  } finally { socket.destroy(); await harness.close(); await upstream.close(); }
});

// Use a real TCP peer and verify data reaches it before exercising teardown. Closing
// only the HTTP listener must not count as disposal of an established tunnel.
for (const termination of ['harness shutdown', 'client disconnect']) {
  test(`disposes both CONNECT peers on ${termination}`, { timeout: 5_000 }, async (t) => {
    const upstreamServer = net.createServer();
    const upstreamConnected = once(upstreamServer, 'connection');
    await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    let clientSocket;
    let upstreamSocket;
    const upstreamOrigin = `http://127.0.0.1:${upstreamServer.address().port}`;
    const harness = createHarness({ upstream: upstreamOrigin });
    const harnessUrl = new URL(await harness.listen());
    t.after(async () => {
      clientSocket?.destroy();
      upstreamSocket?.destroy();
      await harness.close();
      await new Promise((resolve) => upstreamServer.close(resolve));
    });
    const connected = await new Promise((resolve, reject) => {
      const req = http.request({
        host: harnessUrl.hostname, port: harnessUrl.port,
        method: 'CONNECT', path: new URL(upstreamOrigin).host,
      });
      req.on('connect', (res, socket) => resolve({ res, socket }));
      req.on('error', reject);
      req.end();
    });
    clientSocket = connected.socket;
    [upstreamSocket] = await upstreamConnected;
    assert.equal(connected.res.statusCode, 200);
    const received = once(upstreamSocket, 'data');
    clientSocket.write('session frame');
    assert.equal((await received)[0].toString(), 'session frame');
    const clientClosed = once(clientSocket, 'close');
    const upstreamClosed = once(upstreamSocket, 'close');
    // Consume EOF even when there is no further application data.
    clientSocket.resume();
    upstreamSocket.resume();
    if (termination === 'harness shutdown') await harness.close();
    else clientSocket.destroy();
    await Promise.all([clientClosed, upstreamClosed]);
    assert.equal(clientSocket.destroyed, true);
    assert.equal(upstreamSocket.destroyed, true);
    assert.deepEqual(harness.observations.map((entry) => entry.kind), ['tunnelled']);
  });
}

test('refuses CONNECT completed on an accepted connection after shutdown starts', { timeout: 5_000 }, async (t) => {
  let upstreamConnections = 0;
  const upstreamServer = net.createServer((socket) => {
    upstreamConnections++;
    socket.end();
  });
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstreamServer.address().port}`;
  const upstreamHost = new URL(upstreamOrigin).host;
  let releaseBarrier;
  let enteredBarrier;
  const barrierEntered = new Promise((resolve) => { enteredBarrier = resolve; });
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const harness = createHarness({
    upstream: upstreamOrigin,
    overrides: [{
      test: (url) => url.pathname === '/shutdown-barrier',
      respond: async () => {
        enteredBarrier();
        await barrier;
        return { body: 'barrier released' };
      },
    }],
  });
  const harnessUrl = new URL(await harness.listen());
  const client = net.connect(Number(harnessUrl.port), harnessUrl.hostname);
  t.after(async () => {
    releaseBarrier();
    client.destroy();
    await harness.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  await once(client, 'connect');
  client.resume();
  // The pending response proves the socket is accepted and active (not an idle
  // socket server.close() can reap). CONNECT is deliberately missing its final CRLF.
  client.write(`GET ${upstreamOrigin}/shutdown-barrier HTTP/1.1\r\nHost: ${upstreamHost}\r\n\r\n` +
    `CONNECT ${upstreamHost} HTTP/1.1\r\nHost: ${upstreamHost}\r\n`);
  await barrierEntered;
  const clientClosed = once(client, 'close');
  const closed = harness.close();
  client.write('\r\n');
  await Promise.all([clientClosed, closed]);
  assert.equal(upstreamConnections, 0, 'late CONNECT must not open an upstream socket');
  assert.deepEqual(harness.observations.filter((entry) => entry.method === 'CONNECT'), [
    { method: 'CONNECT', url: upstreamHost, kind: 'blocked' },
  ]);
});
