// Synthetic Library implementing the Connect protocol 1 surface the Make modules use
// (docs/developer/connect-api.md). Strict where a real Library is strict; no real media.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { MAKE_CALLBACK } from './iml.mjs';

export const ORIGIN = 'https://library.test';
export const CLIENT_ID = 'make-public-client';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ALBUM_WRITABLE = id(9001);
export const ALBUM_READ_ONLY = id(9002);
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

export async function startLibrary({ assets = 230 } = {}) {
  const state = {
    requests: [],
    codes: new Map(),
    grants: new Map(),
    access: new Map(),
    refresh: new Map(),
    receipts: new Map(),
    uploads: new Map(),
    albums: [
      { id: ALBUM_WRITABLE, name: 'Trips', workspace: 'photo', canRead: true, canWrite: true },
      { id: ALBUM_READ_ONLY, name: 'Family', workspace: 'photo', canRead: true, canWrite: false },
    ],
    assets: Array.from({ length: assets }, (_, n) => ({
      id: id(n + 1),
      type: 'IMAGE',
      title: null,
      description: `Photo ${n + 1}`,
      width: 4000,
      height: 3000,
      duration: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) - n * 60_000).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    })),
    events: [],
    fail: [],
  };
  const token = (prefix) => `${prefix}${randomBytes(24).toString('base64url')}`;
  const issue = (grant) => {
    const access = token('fla_');
    const refresh = token('flr_');
    state.access.set(access, { grant, expires: Date.now() + 3600_000 });
    state.refresh.set(refresh, { grant, spent: false });
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, scope: grant.scopes.join(' ') };
  };
  const pushEvent = (event, assetId, detail = {}) =>
    state.events.unshift({
      event,
      deliveryId: id(50_000 + state.events.length),
      occurredAt: new Date(Date.UTC(2026, 1, 1) + state.events.length * 1000).toISOString(),
      subject: { kind: 'asset', id: assetId, name: null },
      detail,
    });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, ORIGIN);
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const reply = (status, body, headers = {}) => {
      const binary = Buffer.isBuffer(body);
      res.writeHead(status, { 'content-type': binary ? 'image/jpeg' : 'application/json', ...headers });
      res.end(binary ? body : body === undefined ? '' : JSON.stringify(body));
    };
    const form = () => Object.fromEntries(new URLSearchParams(raw.toString()));
    const json = () => (raw.length ? JSON.parse(raw.toString()) : {});
    const injected = state.fail.findIndex((rule) => url.pathname.endsWith(rule.path) && req.method === rule.method);
    if (injected >= 0) {
      const [rule] = state.fail.splice(injected, 1);
      return reply(rule.status, { message: rule.message ?? 'Injected failure' }, rule.headers);
    }

    // OAuth
    if (url.pathname === '/api/oauth/apps/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      if (
        q.client_id !== CLIENT_ID ||
        q.redirect_uri !== MAKE_CALLBACK ||
        q.response_type !== 'code' ||
        q.code_challenge_method !== 'S256' ||
        !/^[\w-]{43}$/.test(q.code_challenge ?? '') ||
        q.resource !== `${ORIGIN}/api/connect`
      )
        return reply(400, { error: 'invalid_request' });
      const code = token('code_');
      state.codes.set(code, { challenge: q.code_challenge, scopes: q.scope.split(' '), resource: q.resource });
      return reply(302, undefined, { location: `${MAKE_CALLBACK}?code=${code}&state=${q.state ?? ''}&iss=${ORIGIN}` });
    }
    if (url.pathname === '/api/oauth/apps/token' && req.method === 'POST') {
      const body = form();
      if (body.client_id !== CLIENT_ID || body.resource !== `${ORIGIN}/api/connect`) return reply(400, { error: 'invalid_client' });
      if (body.grant_type === 'authorization_code') {
        const found = state.codes.get(body.code);
        state.codes.delete(body.code);
        const verifier = body.code_verifier ?? '';
        if (
          !found ||
          body.redirect_uri !== MAKE_CALLBACK ||
          verifier.length < 43 ||
          verifier.length > 128 ||
          createHash('sha256').update(verifier).digest('base64url') !== found.challenge
        )
          return reply(400, { error: 'invalid_grant' });
        const grant = { id: id(70_000 + state.grants.size), scopes: found.scopes, revoked: false };
        state.grants.set(grant.id, grant);
        return reply(200, issue(grant));
      }
      if (body.grant_type === 'refresh_token') {
        const found = state.refresh.get(body.refresh_token);
        if (!found || found.grant.revoked) return reply(400, { error: 'invalid_grant' });
        if (found.spent) {
          found.grant.revoked = true; // reuse of a rotated refresh token revokes the grant
          return reply(400, { error: 'invalid_grant' });
        }
        found.spent = true;
        return reply(200, issue(found.grant));
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/api/oauth/apps/revoke' && req.method === 'POST') {
      const body = form();
      const found = state.refresh.get(body.token);
      if (found && body.client_id === CLIENT_ID) found.grant.revoked = true;
      return reply(200, {});
    }

    // Connect
    if (!url.pathname.startsWith('/api/connect/')) return reply(404, { message: 'Not found' });
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const session = state.access.get(bearer);
    if (!session || session.grant.revoked || session.expires <= Date.now()) return reply(401, { message: 'Unauthorized' });
    const grant = session.grant;
    const need = (scope) => grant.scopes.includes(scope) || (reply(403, { message: `Missing ${scope}` }), false);
    const path = url.pathname.slice('/api/connect'.length);
    const route = (method, pattern) => req.method === method && pattern.exec(path);
    const asset = (assetId) => state.assets.find((entry) => entry.id === assetId);
    let match;

    if (route('GET', /^\/capabilities$/))
      return reply(200, {
        protocolVersion: 1,
        server: { id: 'library-synthetic', name: 'Synthetic Library' },
        displayIdentity: { name: 'Test Person' },
        connection: { grantId: grant.id, libraryUserId: id(1) },
        scopes: grant.scopes,
        albums: state.albums,
      });
    if (route('GET', /^\/albums$/)) return need('library:read') && reply(200, { items: state.albums });
    if (route('GET', /^\/assets$/)) {
      if (!need('library:read')) return;
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('size') ?? 50);
      if (!(page >= 1) || !(size >= 1 && size <= 100)) return reply(400, { message: 'Invalid page' });
      return reply(200, { items: state.assets.slice((page - 1) * size, page * size), total: state.assets.length, page, size });
    }
    if ((match = route('GET', /^\/assets\/([\da-f-]{36})$/)))
      return need('library:read') && (asset(match[1]) ? reply(200, asset(match[1])) : reply(404, { message: 'Not found' }));
    if ((match = route('GET', /^\/assets\/([\da-f-]{36})\/rendition$/))) {
      if (!need('library:read')) return;
      if (!['thumbnail', 'preview', 'display'].includes(url.searchParams.get('variant'))) return reply(400, { message: 'Bad variant' });
      return asset(match[1]) ? reply(200, JPEG, { 'content-disposition': `inline; filename="${match[1]}.jpg"` }) : reply(404, { message: 'Not found' });
    }
    if (route('POST', /^\/albums$/)) {
      if (!need('albums:write')) return;
      const body = json();
      const key = `album:${body.requestId}`;
      if (!state.receipts.has(key)) {
        const album = { id: id(9100 + state.albums.length), name: body.name, workspace: body.workspace, canRead: true, canWrite: true };
        state.albums.push(album);
        state.receipts.set(key, album);
      }
      return reply(201, state.receipts.get(key));
    }
    if ((match = route('POST', /^\/albums\/([\da-f-]{36})\/assets$/))) {
      if (!need('albums:write')) return;
      if (!state.albums.find((album) => album.id === match[1])?.canWrite) return reply(403, { message: 'Album is not writable' });
      const { assetIds } = json();
      for (const assetId of assetIds) pushEvent('album.asset.added', assetId, { albumId: match[1] });
      return reply(201, assetIds.map((assetId) => (asset(assetId) ? { id: assetId, success: true } : { id: assetId, success: false, error: 'not_found' })));
    }
    if ((match = route('POST', /^\/assets\/([\da-f-]{36})\/tags$/))) {
      if (!need('tags:write')) return;
      return asset(match[1]) ? reply(201, { tagIds: json().tags.map((_, n) => id(80_000 + n)) }) : reply(404, { message: 'Not found' });
    }
    if (route('POST', /^\/uploads$/)) {
      if (!need('photos:upload')) return;
      const body = json();
      const payload = JSON.stringify(body);
      const prior = state.receipts.get(`upload:${body.requestId}`);
      if (prior) return prior.payload === payload ? reply(201, view(state.uploads.get(prior.uploadId))) : reply(409, { message: 'Request ID payload changed' });
      if (!state.albums.find((album) => album.id === body.albumId)?.canWrite) return reply(403, { message: 'Album is not writable' });
      if (!/^[a-f\d]{64}$/.test(body.sha256) || !Number.isInteger(body.size) || !body.contentType || !body.fileCreatedAt)
        return reply(400, { message: 'Invalid upload' });
      const upload = { id: id(60_000 + state.uploads.size), size: body.size, sha256: body.sha256, bytes: Buffer.alloc(0), state: 'receiving', requestId: body.requestId };
      state.uploads.set(upload.id, upload);
      state.receipts.set(`upload:${body.requestId}`, { payload, uploadId: upload.id });
      return reply(201, view(upload));
    }
    if ((match = route('PATCH', /^\/uploads\/([\da-f-]{36})$/))) {
      const upload = state.uploads.get(match[1]);
      if (!upload) return reply(404, { message: 'Not found' });
      if (
        req.headers['upload-draft-interop-version'] !== '9' ||
        req.headers['content-type'] !== 'application/partial-upload' ||
        Number(req.headers['upload-offset']) !== upload.bytes.length
      )
        return reply(409, { message: 'Offset mismatch' });
      if (upload.state !== 'receiving') return reply(409, { message: 'Upload is closed' });
      upload.bytes = Buffer.concat([upload.bytes, raw]);
      if (req.headers['upload-complete'] === '?1')
        upload.state = upload.bytes.length === upload.size && createHash('sha256').update(upload.bytes).digest('hex') === upload.sha256 ? 'verified' : 'rejected';
      return reply(200, view(upload));
    }
    if ((match = route('POST', /^\/uploads\/([\da-f-]{36})\/commit$/))) {
      const upload = state.uploads.get(match[1]);
      const body = json();
      if (!upload || body.requestId !== upload.requestId || body.sha256 !== upload.sha256) return reply(409, { message: 'Request ID payload changed' });
      if (upload.state === 'verified') {
        upload.receipt = { assetId: id(40_000 + state.assets.length), status: 'created', sha256: upload.sha256 };
        state.assets.unshift({ ...state.assets[0], id: upload.receipt.assetId });
        upload.state = 'published';
        pushEvent('asset.ready', upload.receipt.assetId);
      }
      return upload.receipt ? reply(200, upload.receipt) : reply(409, { message: 'Upload is not verified' });
    }
    if (route('GET', /^\/events\/latest$/)) {
      if (!need('events:read')) return;
      const type = url.searchParams.get('type');
      const albumId = url.searchParams.get('albumId');
      const cursor = url.searchParams.get('cursor');
      if (cursor && !/^c\d+$/.test(cursor)) return reply(410, { message: 'This event cursor has expired' });
      const offset = cursor ? Number(cursor.slice(1)) : 0;
      const matching = state.events
        .slice(0, 1000)
        .filter((event) => (!type || event.event === type) && (!albumId || event.detail.albumId === albumId));
      const items = matching.slice(offset, offset + 100);
      const hasMore = offset + 100 < matching.length;
      return reply(200, { items, nextCursor: hasMore ? `c${offset + 100}` : null, hasMore, bounded: true });
    }
    return reply(404, { message: 'Not found' });
  });
  const view = (upload) => ({
    id: upload.id,
    offset: upload.bytes.length,
    size: upload.size,
    state: upload.state,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...(upload.receipt && { receipt: upload.receipt }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  // Make reaches the Library over public HTTPS; tests map that origin onto the loopback server.
  const fetchLibrary = (url, init) => {
    if (!url.startsWith(`${ORIGIN}/`)) throw new Error(`Request left the Library origin: ${url}`);
    return fetch(local + url.slice(ORIGIN.length), init);
  };
  const consent = async (authorizeUrl) => {
    const response = await fetchLibrary(authorizeUrl.toString(), { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location?.startsWith(`${MAKE_CALLBACK}?`)) throw new Error(`Consent failed (${response.status})`);
    return Object.fromEntries(new URL(location).searchParams);
  };
  return {
    state,
    fetch: fetchLibrary,
    consent,
    pushEvent,
    expireAccess: () => state.access.forEach((entry) => (entry.expires = 0)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
