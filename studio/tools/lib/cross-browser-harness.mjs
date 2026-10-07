// FL-112: a shared substitute for Playwright's `page.route()`, which geckodriver (Firefox) and
// safaridriver (Safari) have no equivalent for - both are plain WebDriver classic, HTTP+JSON only,
// with no network-interception hook. Every `*.browser.mjs` matrix script's substitutions
// (synthetic HTML entrypoints, a substituted resource-policy.json, blocking external/binary
// requests during admission checks) need to come from somewhere a real HTTP client can see, so
// this serves them from a real local origin instead of an in-process browser hook.
//
// It runs as a forward proxy, not a second web server the scripts navigate to: the browser (any
// of the three) is launched with its proxy settings pointed at this harness, and scripts keep
// navigating to the *real* Studio origin (`STUDIO_TEST_ORIGIN`) exactly as they do today. Every
// request the browser makes - same-origin module loads included - arrives here first:
//   - a request whose host:port doesn't match `upstream` is a real external request (a CDN, a
//     font host, anything not the Studio dev server) and gets denied and recorded, never
//     forwarded. This is the "proxy prefs pointing at a deny-all" from the design: the harness
//     itself *is* that deny-all, with the one exception of the Studio origin it's fronting.
//   - a request matching an `overrides` entry (checked in order) gets that entry's response
//     instead of ever reaching the real dev server - the replacement for `page.route()`'s
//     `route.fulfill()`.
//   - everything else is proxied through to `upstream` unchanged.
// `CONNECT` is tunnelled only to `upstream` itself (browsers send WebSockets that way) and refused
// for every other host, so HTTPS anywhere else is denied and recorded like any external request.
//
// `observations` replaces Playwright's `route.request()` introspection (which WebDriver has
// nothing like): every request the harness sees is appended, in order, as
// `{ method, url, kind: 'override' | 'proxied' | 'blocked' }`.
import http from 'node:http';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

/** Absence is qualified only when this reopen window contains transparent browser project traffic. */
export function assertProjectOnlyReopen(observations, upstream, projectId) {
  const origin = new URL(upstream);
  assert.equal(origin.protocol, 'http:', 'project-only reopen requires an observable HTTP origin');
  assert.ok(!observations.some(r => r.kind === 'tunnelled'), 'opaque CONNECT traffic cannot qualify project-only reopen');
  const requests = observations.map(r => ({...r, path: new URL(r.url, origin).pathname}));
  assert.ok(requests.some(r => r.method === 'GET' && r.kind === 'proxied' &&
    new URL(r.url).origin === origin.origin && r.path === `/api/studio/projects/${encodeURIComponent(projectId)}`),
  'project-only reopen requires a project-bound browser GET within the observation window');
  assert.ok(!requests.some(r => /^\/api\/(?:assets(?:\/search)?|search(?:\/.*)?)$/.test(r.path)),
    'project-only reopen must not search or list assets');
  return requests;
}

/**
 * @param {object} options
 * @param {string} options.upstream - the real Studio origin to front, e.g. http://127.0.0.1:5186.
 * @param {Array<{test: (url: URL, req: import('node:http').IncomingMessage) => boolean, respond: (url: URL, req: import('node:http').IncomingMessage) => (object | Promise<object>)}>} [options.overrides]
 *   Checked in order; the first whose `test` returns true has its `respond` result
 *   (`{ status = 200, contentType = 'text/plain', headers, body }`) sent back verbatim.
 */
export function createHarness({ upstream, overrides = [] } = {}) {
  if (!upstream) {
    throw new Error('createHarness requires an upstream origin');
  }
  const upstreamUrl = new URL(upstream);
  const observations = [];
  // HTTP server.close() does not dispose upgraded/CONNECT sockets. Own both ends so a
  // matrix session cannot leave an admitted tunnel alive after its harness is closed.
  const tunnelSockets = new Set();
  let closing = false;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      observations.push({ method: req.method, url: req.url, kind: 'error', error: String(error) });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  const isUpstreamRequest = (url) => url.host === upstreamUrl.host;

  // A browser tunnels WebSockets (Vite's HMR client) through its proxy with CONNECT, so a tunnel to
  // the Studio origin itself is opened; overrides never apply inside it. Any other CONNECT (HTTPS to
  // anywhere else) is refused - see module doc.
  server.on('connect', (req, socket, head) => {
    if (closing) {
      observations.push({ method: 'CONNECT', url: req.url, kind: 'blocked' });
      socket.destroy();
      return;
    }
    if (req.url !== upstreamUrl.host) {
      observations.push({ method: 'CONNECT', url: req.url, kind: 'blocked' });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    observations.push({ method: 'CONNECT', url: req.url, kind: 'tunnelled' });
    const upstreamSocket = net.connect(Number(upstreamUrl.port || 80), upstreamUrl.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    tunnelSockets.add(socket);
    tunnelSockets.add(upstreamSocket);
    const drop = () => { socket.destroy(); upstreamSocket.destroy(); };
    upstreamSocket.on('error', drop);
    socket.on('error', drop);
    socket.on('close', () => { tunnelSockets.delete(socket); drop(); });
    upstreamSocket.on('close', () => { tunnelSockets.delete(upstreamSocket); drop(); });
  });

  async function handleRequest(req, res) {
    // A forward proxy receives the absolute URL as the request line; a direct client (as in this
    // module's own tests) sends only the path, so fall back to treating the harness itself as the
    // target host in that case.
    const requestUrl = req.url.startsWith('http')
      ? new URL(req.url)
      : new URL(req.url, `http://${req.headers.host}`);

    if (!isUpstreamRequest(requestUrl)) {
      observations.push({ method: req.method, url: requestUrl.href, kind: 'blocked' });
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked by the cross-browser harness (deny-all proxy)');
      return;
    }

    for (const override of overrides) {
      if (override.test(requestUrl, req)) {
        const response = await override.respond(requestUrl, req);
        observations.push({ method: req.method, url: requestUrl.href, kind: 'override' });
        res.writeHead(response.status ?? 200, {
          'content-type': response.contentType ?? 'text/plain',
          ...response.headers,
        });
        res.end(response.body ?? '');
        return;
      }
    }

    observations.push({ method: req.method, url: requestUrl.href, kind: 'proxied' });
    const target = new URL(requestUrl.pathname + requestUrl.search, upstreamUrl);
    const upstreamRes = await new Promise((resolve, reject) => {
      const proxyReq = http.request(
        target,
        { method: req.method, headers: { ...req.headers, host: upstreamUrl.host } },
        resolve,
      );
      proxyReq.on('error', reject);
      req.pipe(proxyReq);
    });
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  }

  return {
    observations,
    /** Starts listening and returns this harness's own `http://127.0.0.1:<port>` origin. */
    async listen(port = 0) {
      server.listen(port);
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      // Fence admission before server.close() or the tunnel sweep: an accepted HTTP
      // connection can finish parsing CONNECT headers after shutdown has started.
      closing = true;
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of tunnelSockets) socket.destroy();
      await closed;
    },
  };
}
