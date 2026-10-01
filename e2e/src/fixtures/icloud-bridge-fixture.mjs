/**
 * A fake iCloud Photos bridge for e2e (FL-68 / FL-144). TEST-ONLY: it never talks to Apple and is only
 * started by docker-compose.icloud-bridge-fixture.yml.
 *
 * It speaks protocol v1 exactly as icloud-bridge/api.md and icloud-bridge/main.go define it, and as
 * server/src/repositories/icloud-transport.repository.ts calls it:
 *
 *   - HTTPS only (a test-only CA under ./icloud-bridge/), every /v1/* route behind `Authorization: Bearer`.
 *   - Strict JSON bodies: unknown top-level fields, query strings and non-POST methods are 400 invalid_request.
 *   - Errors are `{version:1,error:{code,message}}` with the bridge's statuses (400/401/409/429/502).
 *   - POST /v1/auth: login (always asks for a verification code, like an Apple ID with 2FA), two-factor
 *     (a wrong code answers 200 `reauthentication-required`, exactly like the Go bridge, so the owner
 *     signs in again), validate, device-approval. The opaque session is `{version:1,state,appleId,upstream}`.
 *   - POST /v1/inventory: libraries (private, then shared phase), albums, assets (originals, then the
 *     hidden phase, `2*limit` raw records per rank page), changes (sync-token cursor), memberships.
 *     Cursors are opaque base64url JSON bound to kind, library, album and limit.
 *   - POST /v1/download: looks the master up again, recomputes the canonical resource fingerprint
 *     (409 resource_changed on mismatch, before any byte) and streams the bytes with X-ICloud-Session,
 *     X-ICloud-Resource-Fingerprint and X-ICloud-Resource-Size.
 *
 * The libraries are deterministic: each Apple account below has its own zone owner and its own PNGs
 * (generated here, distinct bytes per item), and some accounts have items hidden in iCloud.
 *
 * Test-only control (plain HTTP on its own port, never part of the protocol):
 *   GET  /__fixture/state                  per-account counters (inventory pages, downloads served/waiting)
 *   POST /__fixture/hold {appleId, allow}  let `allow` more downloads of that account through, then hold
 *                                          the rest until released (to reload or cancel mid-run)
 *   POST /__fixture/release {appleId}      let held downloads finish and stop holding
 *   POST /__fixture/reset                  forget counters and holds
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { crc32, deflateSync } from 'node:zlib';

const PORT = Number(process.env.ICLOUD_BRIDGE_FIXTURE_PORT ?? 9443);
const CONTROL_PORT = Number(process.env.ICLOUD_BRIDGE_FIXTURE_CONTROL_PORT ?? 9444);
const read = (name, fallback) =>
  readFileSync(process.env[name] ?? new URL(`./icloud-bridge/${fallback}`, import.meta.url));
const TOKEN = read('ICLOUD_BRIDGE_TOKEN_FILE', 'test-only-bridge-token').toString().trim();
const TLS = {
  cert: read('ICLOUD_BRIDGE_TLS_CERT_FILE', 'test-only-bridge.crt'),
  key: read('ICLOUD_BRIDGE_TLS_KEY_FILE', 'test-only-bridge.key'),
};
const MAX_BODY = 2 * 1024 ** 2;

const capabilities = {
  auth: ['login', 'two-factor', 'device-approval', 'validate'],
  inventory: ['libraries', 'albums', 'assets', 'changes', 'memberships'],
  download: ['resOriginalRes'],
  writes: false,
  sms: false,
};

/* ------------------------------------------------------------------ */
/* Deterministic Apple accounts                                        */
/* ------------------------------------------------------------------ */

/** Each account: its password, its verification code, its visible items and its items hidden in iCloud. */
const ACCOUNTS = {
  'alice@icloud.test': { password: 'alice-test-only', code: '246810', prefix: 'ALICE', visible: 3, hidden: 1 },
  'bob@icloud.test': { password: 'bob-test-only', code: '135791', prefix: 'BOB', visible: 2, hidden: 1 },
  'carol@icloud.test': { password: 'carol-test-only', code: '314159', prefix: 'CAROL', visible: 2, hidden: 0 },
  'dana@icloud.test': { password: 'dana-test-only', code: '271828', prefix: 'DANA', visible: 2, hidden: 1 },
  'erin@icloud.test': { password: 'erin-test-only', code: '161803', prefix: 'ERIN', visible: 6, hidden: 0 },
  'frank@icloud.test': { password: 'frank-test-only', code: '141421', prefix: 'FRANK', visible: 5, hidden: 0 },
};

/** A small valid RGB PNG whose pixels (and so bytes and checksums) are unique to `seed`. */
const png = (seed) => {
  const digest = createHash('sha256').update(seed).digest();
  const width = 24;
  const height = 16;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) {
      row.push(digest[(x + y) % 32], digest[(x * 3 + y) % 32], digest[(x + y * 5) % 32]);
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const field = (value, type) => ({ value, ...(type && { type }) });

/** Build every account's raw CloudKit records and the bytes behind each master's original. */
const buildLibrary = (appleId, account) => {
  const owner = `_${createHash('sha256').update(appleId).digest('hex').slice(0, 24)}`;
  const zone = { zoneName: 'PrimarySync', ownerRecordName: owner, zoneType: 'REGULAR_CUSTOM_ZONE' };
  const items = [];
  const total = account.visible + account.hidden;
  for (let index = 0; index < total; index++) {
    const hidden = index >= account.visible;
    const name = hidden
      ? `${account.prefix}_HIDDEN_${String(index - account.visible + 1).padStart(2, '0')}.PNG`
      : `${account.prefix}_${String(index + 1).padStart(4, '0')}.PNG`;
    const bytes = png(`${appleId}/${name}`);
    const masterId = `${account.prefix}-master-${index + 1}`;
    const assetId = `${account.prefix}-asset-${index + 1}`;
    const date = Date.UTC(2021, 4, 1 + index, 12, 0, 0);
    const master = {
      recordName: masterId,
      recordType: 'CPLMaster',
      recordChangeTag: `${masterId}-r1`,
      fields: {
        filenameEnc: field(Buffer.from(name).toString('base64'), 'ENCRYPTED_BYTES'),
        itemType: field('public.png', 'STRING'),
        resOriginalFileType: field('public.png', 'STRING'),
        resOriginalWidth: field(24, 'INT64'),
        resOriginalHeight: field(16, 'INT64'),
        resOriginalRes: field(
          {
            size: bytes.length,
            fileChecksum: createHash('sha1').update(bytes).digest('base64'),
            // Like Apple's signed URLs: dropped from the fingerprint and from what the server stores.
            downloadURL: `https://cvws.icloud-content.com/B/${masterId}/original?o=test-only`,
          },
          'ASSETID',
        ),
      },
    };
    const asset = {
      recordName: assetId,
      recordType: 'CPLAsset',
      recordChangeTag: `${assetId}-r1`,
      fields: {
        masterRef: field({ recordName: masterId, action: 'DELETE_SELF', zoneID: zone }, 'REFERENCE'),
        assetDate: field(date, 'TIMESTAMP'),
        addedDate: field(date + 60_000, 'TIMESTAMP'),
        isFavorite: field(0, 'INT64'),
        isHidden: field(hidden ? 1 : 0, 'INT64'),
      },
    };
    items.push({ name, hidden, bytes, master, asset });
  }
  return { owner, zone, items };
};

const LIBRARIES = new Map(
  Object.entries(ACCOUNTS).map(([appleId, account]) => [appleId, buildLibrary(appleId, account)]),
);

/* ------------------------------------------------------------------ */
/* Canonical resource fingerprint (icloud-bridge/main.go)              */
/* ------------------------------------------------------------------ */

const sensitiveKey = /url|token|expir|password|secret|credential|cookie|authorization|session|authattributes|scnt/i;
const sensitiveValue = /https?:\/\/|data:|bearer\s/i;
const allowed = (value) => typeof value !== 'string' || !sensitiveValue.test(value);
const canonical = (value) => {
  if (Array.isArray(value)) {
    return value.filter((item) => allowed(item)).map((item) => canonical(item));
  }
  if (value && typeof value === 'object') {
    const stable = {};
    for (const key of Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      if (!sensitiveKey.test(key) && allowed(value[key])) {
        stable[key] = canonical(value[key]);
      }
    }
    return stable;
  }
  return value;
};
// Go's encoding/json escapes <, >, & and U+2028/U+2029.
const goJson = (value) =>
  JSON.stringify(canonical(value)).replaceAll(
    /[<>&\u{2028}\u{2029}]/gu,
    (character) => String.raw`\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
const fingerprint = (descriptor) => createHash('sha256').update(goJson(descriptor)).digest('hex');

/* ------------------------------------------------------------------ */
/* Protocol plumbing                                                   */
/* ------------------------------------------------------------------ */

class Fault extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const bad = () => new Fault(400, 'invalid_request');
const MESSAGES = {
  invalid_request: 'Invalid bridge request.',
  unauthorized: 'Authentication required.',
  reauthentication_required: 'Apple authentication must be renewed.',
  device_approval_required: 'Approve access on a trusted Apple device.',
  resource_changed: 'The source resource changed; refresh inventory.',
  rate_limited: 'The request was throttled; retry later.',
  invalid_change_token: 'The change cursor expired; refresh inventory.',
  upstream_error: 'The Apple request could not be completed.',
  unsupported: 'This operation is unsupported.',
};

const writeJson = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
};
const writeError = (res, error) => {
  const fault = error instanceof Fault ? error : new Fault(502, 'upstream_error');
  writeJson(res, fault.status, { version: 1, error: { code: fault.code, message: MESSAGES[fault.code] } });
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw bad();
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || 'null');
  } catch {
    throw bad();
  }
};

const REQUEST_FIELDS = new Set([
  'action',
  'appleId',
  'password',
  'code',
  'session',
  'kind',
  'library',
  'albumId',
  'cursor',
  'limit',
  'recordId',
  'resourceKey',
  'expectedFingerprint',
]);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value) => (value === undefined || value === null ? '' : value);

/** Go decodes into a typed struct with DisallowUnknownFields: unknown keys or wrong types are invalid. */
const parseRequest = (body) => {
  if (!isObject(body) || Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) {
    throw bad();
  }
  for (const key of ['action', 'appleId', 'password', 'code', 'kind', 'albumId', 'cursor', 'recordId', 'resourceKey']) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
      throw bad();
    }
  }
  if (body.limit !== undefined && body.limit !== null && !Number.isInteger(body.limit)) {
    throw bad();
  }
  if (body.library !== undefined && body.library !== null) {
    const { library } = body;
    if (!isObject(library) || Object.keys(library).some((key) => key !== 'area' && key !== 'zoneID')) {
      throw bad();
    }
  }
  return body;
};

/** The session envelope: `{version:1,state,appleId,upstream}`; `upstream` stands in for rclone's Session. */
const restore = (raw) => {
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.upstream) || typeof raw.appleId !== 'string') {
    throw bad();
  }
  if (!LIBRARIES.has(raw.appleId) || raw.upstream.fixture !== 'icloud-bridge-fixture') {
    throw bad();
  }
  return { ...raw, upstream: { ...raw.upstream } };
};
const rotate = (session) => ({
  ...session,
  upstream: { ...session.upstream, rotation: Number(session.upstream.rotation ?? 0) + 1 },
});

const state = { accounts: new Map() };
const counters = (appleId) => {
  if (!state.accounts.has(appleId)) {
    state.accounts.set(appleId, {
      logins: 0,
      wrongCodes: 0,
      inventoryPages: 0,
      downloadsServed: 0,
      downloadsWaiting: 0,
      admitted: 0,
      hold: undefined,
      waiters: [],
      served: {},
    });
  }
  return state.accounts.get(appleId);
};

/* ------------------------------------------------------------------ */
/* /v1/auth                                                            */
/* ------------------------------------------------------------------ */

const auth = (q) => {
  let session;
  if (q.action === 'login') {
    const appleId = str(q.appleId).trim().toLowerCase();
    if (!appleId || appleId.length > 320 || !q.password || q.password.length > 4096 || q.session || q.code) {
      throw bad();
    }
    const account = ACCOUNTS[appleId];
    counters(appleId).logins++;
    session = {
      version: 1,
      state: 'reauthentication-required',
      appleId,
      upstream: { fixture: 'icloud-bridge-fixture', id: randomUUID(), rotation: 0 },
    };
    // A wrong password or unknown Apple ID fails SRP sign-in; main.go then answers reauthentication-required.
    if (account && q.password === account.password) {
      // Every fixture account has two-factor authentication: a code is pushed to a trusted device.
      session.state = 'awaiting-2fa';
    }
    return { version: 1, state: session.state, session, capabilities };
  }
  if (q.password || q.appleId) {
    throw bad();
  }
  session = restore(q.session);
  switch (q.action) {
    case 'two-factor': {
      if (session.state !== 'awaiting-2fa' || !/^\d{6}$/.test(str(q.code))) {
        throw bad();
      }
      if (q.code === ACCOUNTS[session.appleId].code) {
        session.state = 'connected';
      } else {
        // main.go: a failed Validate2FACode leaves the envelope in reauthentication-required.
        counters(session.appleId).wrongCodes++;
        session.state = 'reauthentication-required';
      }
      break;
    }
    case 'validate': {
      if (q.code) {
        throw bad();
      }
      if (session.state !== 'connected') {
        session.state = 'reauthentication-required';
      }
      break;
    }
    case 'device-approval': {
      if (q.code || (session.state !== 'awaiting-device-approval' && session.state !== 'connected')) {
        throw bad();
      }
      session.state = 'connected';
      break;
    }
    default: {
      throw bad();
    }
  }
  session = rotate(session);
  return { version: 1, state: session.state, session, capabilities };
};

/* ------------------------------------------------------------------ */
/* /v1/inventory                                                       */
/* ------------------------------------------------------------------ */

const scopeOf = (q) =>
  createHash('sha256')
    .update(JSON.stringify([q.kind, q.library ?? null, str(q.albumId), q.limit]))
    .digest('hex');
const decodeCursor = (q) => {
  const cursor = { s: scopeOf(q), r: 0, p: 0 };
  if (!q.cursor) {
    return cursor;
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
  } catch {
    throw bad();
  }
  if (!isObject(decoded) || decoded.s !== cursor.s) {
    throw bad();
  }
  const rank = decoded.r ?? 0;
  const phase = decoded.p ?? 0;
  if (!Number.isInteger(rank) || rank < 0 || !Number.isInteger(phase) || phase < 0 || phase > 2) {
    throw bad();
  }
  return { ...decoded, r: rank, p: phase };
};
const encodeCursor = (cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

const sameZone = (library, zone) =>
  isObject(library?.zoneID) &&
  library.zoneID.zoneName === zone.zoneName &&
  str(library.zoneID.ownerRecordName) === zone.ownerRecordName &&
  str(library.zoneID.zoneType) === zone.zoneType;

const inventory = (q) => {
  const session = restore(q.session);
  if (session.state !== 'connected') {
    throw new Fault(409, 'reauthentication_required');
  }
  q.limit ??= 100;
  if (q.limit < 1 || q.limit > 100) {
    throw bad();
  }
  if (str(q.albumId).length > 512) {
    throw bad();
  }
  const library = LIBRARIES.get(session.appleId);
  if (q.kind !== 'libraries') {
    if (!q.library || !['private', 'shared'].includes(q.library.area) || !isObject(q.library.zoneID)) {
      throw bad();
    }
    // A zone of another Apple account is not visible to this session.
    if (q.library.area !== 'private' || !sameZone(q.library, library.zone)) {
      throw new Fault(502, 'upstream_error');
    }
  }
  const cursor = decodeCursor(q);
  counters(session.appleId).inventoryPages++;
  let records = [];
  let complete = false;
  let next;
  switch (q.kind) {
    case 'libraries': {
      if (q.library || q.albumId || cursor.p > 1) {
        throw bad();
      }
      if (cursor.p === 0) {
        records = [{ zoneID: library.zone, area: 'private' }];
      }
      // Phase 1 is the shared database: these accounts have no iCloud Shared Photo Library.
      cursor.p++;
      complete = cursor.p === 2;
      if (!complete) {
        next = encodeCursor(cursor);
      }
      break;
    }
    case 'albums': {
      complete = true;
      break;
    }
    case 'assets':
    case 'memberships': {
      if (cursor.p > 1) {
        throw bad();
      }
      if (q.kind === 'memberships') {
        if (!q.albumId || cursor.p !== 0) {
          throw bad();
        }
        // No albums in these libraries: an album the server asks about has no members.
        complete = true;
        break;
      }
      const phase = library.items.filter((item) => item.hidden === (cursor.p === 1));
      const page = phase.slice(cursor.r, cursor.r + q.limit);
      records = page.flatMap((item) => [item.asset, item.master]);
      complete = records.length < 2 * q.limit;
      cursor.r += q.limit;
      if (complete && cursor.p === 0) {
        // Originals done; the hidden assets come in their own cursor phase.
        cursor.p = 1;
        cursor.r = 0;
        complete = false;
      }
      if (!complete) {
        next = encodeCursor(cursor);
      }
      break;
    }
    case 'changes': {
      // One zone change page: nothing changed since the scan; the token is returned for the next run.
      complete = true;
      next = encodeCursor({ ...cursor, t: `sync-token-${library.owner}` });
      break;
    }
    default: {
      throw bad();
    }
  }
  return {
    version: 1,
    session: rotate(session),
    records,
    ...(next && { nextCursor: next }),
    complete,
    capabilities,
  };
};

/* ------------------------------------------------------------------ */
/* /v1/download                                                        */
/* ------------------------------------------------------------------ */

const admit = (appleId) => {
  const account = counters(appleId);
  if (account.hold === undefined || account.admitted < account.hold) {
    account.admitted++;
    return Promise.resolve();
  }
  account.downloadsWaiting++;
  return new Promise((resolve) => {
    account.waiters.push(() => {
      account.downloadsWaiting--;
      account.admitted++;
      resolve();
    });
  });
};

const download = async (q, res) => {
  if (
    !q.library ||
    !['private', 'shared'].includes(q.library.area) ||
    !isObject(q.library.zoneID) ||
    !q.recordId ||
    q.recordId.length > 512
  ) {
    throw bad();
  }
  if (
    !['resOriginalRes', 'resOriginalVidComplRes', 'resOriginalAltRes', 'resJPEGFullRes', 'resVidFullRes'].includes(
      q.resourceKey,
    )
  ) {
    throw bad();
  }
  const session = restore(q.session);
  if (session.state !== 'connected') {
    throw new Fault(409, 'reauthentication_required');
  }
  const library = LIBRARIES.get(session.appleId);
  if (!sameZone(q.library, library.zone)) {
    throw new Fault(502, 'upstream_error');
  }
  const item = library.items.find(({ master }) => master.recordName === q.recordId);
  const descriptor = item?.master.fields[q.resourceKey]?.value;
  if (!item || !isObject(descriptor)) {
    throw new Fault(502, 'upstream_error');
  }
  const fp = fingerprint(descriptor);
  if (q.expectedFingerprint && q.expectedFingerprint !== fp) {
    throw new Fault(409, 'resource_changed');
  }
  await admit(session.appleId);
  const account = counters(session.appleId);
  account.downloadsServed++;
  account.served[item.name] = (account.served[item.name] ?? 0) + 1;
  res.writeHead(200, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'image/png',
    'content-length': item.bytes.length,
    'x-icloud-session': Buffer.from(JSON.stringify(rotate(session))).toString('base64url'),
    'x-icloud-resource-fingerprint': fp,
    'x-icloud-resource-size': String(item.bytes.length),
  });
  res.end(item.bytes);
};

/* ------------------------------------------------------------------ */
/* Servers                                                             */
/* ------------------------------------------------------------------ */

const authorized = (header) => {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  return timingSafeEqual(presented, createHash('sha256').update(TOKEN).digest());
};

const bridge = createHttpsServer(TLS, async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'https://icloud-bridge-fixture');
    if (url.pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, { version: 1, ready: true, fixture: 'icloud-bridge-fixture' });
      return;
    }
    if (!authorized(req.headers.authorization)) {
      throw new Fault(401, 'unauthorized');
    }
    if (url.search) {
      throw bad();
    }
    if (url.pathname === '/v1/capabilities' && req.method === 'GET') {
      writeJson(res, 200, { version: 1, capabilities });
      return;
    }
    if (req.method !== 'POST') {
      throw bad();
    }
    const q = parseRequest(await readBody(req));
    switch (url.pathname) {
      case '/v1/auth': {
        writeJson(res, 200, auth(q));
        return;
      }
      case '/v1/inventory': {
        writeJson(res, 200, inventory(q));
        return;
      }
      case '/v1/download': {
        await download(q, res);
        return;
      }
      default: {
        throw bad();
      }
    }
  } catch (error) {
    if (!res.headersSent) {
      writeError(res, error);
    } else {
      res.destroy();
    }
  }
});

const control = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__fixture/ping') {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/state' && req.method === 'GET') {
      const accounts = {};
      for (const appleId of Object.keys(ACCOUNTS)) {
        const { waiters, ...rest } = counters(appleId);
        accounts[appleId] = { ...rest, waiters: waiters.length };
      }
      writeJson(res, 200, {
        accounts,
        libraries: Object.fromEntries(
          [...LIBRARIES].map(([appleId, library]) => [
            appleId,
            library.items.map(({ name, hidden, bytes }) => ({
              name,
              hidden,
              size: bytes.length,
              sha1: createHash('sha1').update(bytes).digest('base64'),
              sha256: createHash('sha256').update(bytes).digest('base64'),
            })),
          ]),
        ),
      });
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    const body = (await readBody(req)) ?? {};
    switch (url.pathname) {
      case '/__fixture/hold': {
        if (!ACCOUNTS[body.appleId] || !Number.isInteger(body.allow) || body.allow < 0) {
          writeJson(res, 400, { error: 'appleId and allow required' });
          return;
        }
        const account = counters(body.appleId);
        account.hold = account.admitted + body.allow;
        writeJson(res, 200, { hold: account.hold });
        return;
      }
      case '/__fixture/release': {
        if (!ACCOUNTS[body.appleId]) {
          writeJson(res, 400, { error: 'appleId required' });
          return;
        }
        const account = counters(body.appleId);
        account.hold = undefined;
        for (const release of account.waiters.splice(0)) {
          release();
        }
        writeJson(res, 200, { released: true });
        return;
      }
      case '/__fixture/reset': {
        for (const account of state.accounts.values()) {
          for (const release of account.waiters.splice(0)) {
            release();
          }
        }
        state.accounts.clear();
        writeJson(res, 200, { reset: true });
        return;
      }
      default: {
        writeJson(res, 404, { error: 'not found' });
      }
    }
  } catch {
    writeJson(res, 400, { error: 'invalid request' });
  }
});

bridge.listen(PORT, () => console.log(`icloud-bridge-fixture (TEST-ONLY) listening on https :${PORT}`));
control.listen(CONTROL_PORT, () => console.log(`icloud-bridge-fixture control listening on http :${CONTROL_PORT}`));
