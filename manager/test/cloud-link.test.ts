import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Cloud, CloudError, Grant, Lease, REPOSITORY_FORMAT, createIdentity, publicJwk, signText, uuidv7, type Identity } from '../src/cloud-link.js';

const ISSUER = 'https://id.frameleaf.cloud';
const API = 'https://api.frameleaf.cloud';
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloud');
const fixture = async (name: string) => JSON.parse(await readFile(join(fixtures, name), 'utf8'));
const machine = { name: 'home-server', version: '1.2.24', platform: 'manager/linux' };
const thumbprint = (jwk: { kty: string; crv: string; x: string }) => createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
const refused = (code: string, status?: number) => (error: unknown) => error instanceof CloudError && error.code === code && (status === undefined || error.status === status);

/**
 * Frameleaf Cloud, as far as a backup machine meets it. It checks what the real service checks: every
 * signature, what each proof is bound to, the nonce for each host, and that nothing is replayed.
 */
function standIn(options: { old?: boolean } = {}) {
  const state = {
    now: Date.parse('2026-11-17T12:00:00Z'),
    nonce: { [ISSUER]: 'issuer-1', [API]: 'api-1' } as Record<string, string>,
    seen: new Set<string>(),
    calls: [] as string[],
    pollsBeforeApproval: 1,
    devices: new Map<string, { jkt: string; polls: number }>(),
    linkTokens: new Map<string, string>(),
    instances: new Map<string, { jwk: { kty: string; crv: string; x: string }; kind: string; linked: boolean }>(),
    tokens: new Map<string, { instanceId: string; jkt: string }>(),
    lease: null as { leaseId: string; operation: string; holder: string } | null,
    entitled: true,
    grant: null as Record<string, any> | null,
    discovery: { version: 1, validFor: 3600, issuer: ISSUER, api: API, ml: {} } as Record<string, unknown>,
  };
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const envelope = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    answer(status, { code, message: code, retryable: false, requestId: 'r', ...extra }, headers);

  /** Returns the proof's key thumbprint, or the refusal to send back. */
  const proof = (request: { method: string; url: URL; headers: Headers }, oauth: boolean, token?: string): string | Response => {
    const origin = request.url.origin;
    const challenge = () => (oauth ? answer(400, { error: 'use_dpop_nonce' }, { 'dpop-nonce': state.nonce[origin]! }) : envelope(401, 'use_dpop_nonce', {}, { 'dpop-nonce': state.nonce[origin]! }));
    const bad = (detail: string) => (oauth ? answer(400, { error: 'invalid_dpop_proof', error_description: detail }) : envelope(401, 'invalid_dpop_proof', { detail }));
    const [head, body, signature] = (request.headers.get('dpop') ?? '').split('.');
    if (!head || !body || !signature) return bad('missing');
    const header = decode(head);
    const payload = decode(body);
    if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || header.jwk?.d || header.kid) return bad('header');
    if (!verify(null, Buffer.from(`${head}.${body}`), createPublicKey({ key: header.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) return bad('signature');
    if (payload.htm !== request.method) return bad('htm');
    if (payload.htu !== `${origin}${request.url.pathname}`) return bad('htu');
    if (Math.abs(payload.iat * 1000 - state.now) > 60_000) return bad('iat');
    if (payload.nonce !== state.nonce[origin]) return challenge();
    if (state.seen.has(payload.jti)) return bad('replayed');
    state.seen.add(payload.jti);
    if ((payload.ath ?? null) !== (token ? createHash('sha256').update(token).digest('base64url') : null)) return bad('ath');
    return thumbprint(header.jwk);
  };

  const handle = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const text = init.body instanceof URLSearchParams ? init.body.toString() : ((init.body as string | undefined) ?? '');
    const form = new URLSearchParams(headers.get('content-type')?.includes('urlencoded') ? text : '');
    const json = headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : {};
    const route = `${method} ${url.origin === ISSUER ? 'id' : 'api'}${url.pathname}`;
    state.calls.push(route);

    if (route === 'GET api/.well-known/frameleaf-services') return answer(200, state.discovery);

    if (route === 'POST id/device/auth') {
      assert.equal(form.get('client_id'), 'frameleaf-link');
      assert.deepEqual([form.get('instance_name'), form.get('version'), form.get('platform')], [machine.name, machine.version, machine.platform]);
      const deviceCode = randomBytes(8).toString('hex');
      state.devices.set(deviceCode, { jkt: form.get('jkt')!, polls: 0 });
      return answer(200, { device_code: deviceCode, user_code: 'BCDF-GHJK', verification_uri: 'https://frameleaf.cloud/device', verification_uri_complete: 'https://frameleaf.cloud/device?user_code=BCDF-GHJK', expires_in: 600, interval: 5 });
    }

    if (route === 'POST id/token' && form.get('grant_type')?.endsWith('device_code')) {
      // The link token comes back as a bearer token: no proof is sent while polling.
      assert.equal(headers.get('dpop'), null);
      const device = state.devices.get(form.get('device_code')!);
      if (!device) return answer(400, { error: 'invalid_grant' });
      if (device.polls++ < state.pollsBeforeApproval) return answer(400, { error: 'authorization_pending' });
      const linkToken = `link-${randomBytes(6).toString('hex')}`;
      state.linkTokens.set(linkToken, device.jkt);
      return answer(200, { access_token: linkToken, expires_in: 600, token_type: 'Bearer', scope: 'instance:link' });
    }

    if (route === 'POST id/token') {
      const jkt = proof({ method, url, headers }, true);
      if (typeof jkt !== 'string') return jkt;
      const [head, body, signature] = form.get('client_assertion')!.split('.') as [string, string, string];
      const header = decode(head);
      const claims = decode(body);
      const instance = state.instances.get(form.get('client_id')!);
      const valid =
        instance?.linked &&
        header.alg === 'EdDSA' &&
        header.typ === 'JWT' &&
        header.kid === thumbprint(instance.jwk) &&
        header.kid === jkt &&
        verify(null, Buffer.from(`${head}.${body}`), createPublicKey({ key: instance.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')) &&
        claims.iss === form.get('client_id') &&
        claims.sub === claims.iss &&
        claims.aud === `${ISSUER}/token` &&
        claims.exp - claims.iat <= 300 &&
        !state.seen.has(claims.jti);
      if (!valid || form.get('resource') !== API || form.get('scope') !== 'instance' || form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        return answer(400, { error: 'invalid_client' });
      state.seen.add(claims.jti);
      const token = `h.${Buffer.from(JSON.stringify({ sub: claims.iss, cnf: { jkt }, frameleaf_kid: jkt })).toString('base64url')}.${randomBytes(8).toString('hex')}`;
      state.tokens.set(token, { instanceId: claims.iss, jkt });
      return answer(200, { access_token: token, token_type: 'DPoP', expires_in: 600, scope: 'instance' });
    }

    if (route === 'POST api/v1/instances') {
      const jkt = proof({ method, url, headers }, false);
      if (typeof jkt !== 'string') return jkt;
      const linkToken = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (state.linkTokens.get(linkToken) !== json.jwk?.kid || json.jwk.kid !== jkt) return envelope(401, 'invalid_token');
      state.linkTokens.delete(linkToken);
      assert.match(json.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.deepEqual(json.capabilities, ['dpop']);
      assert.equal(json.jwk.d, undefined);
      const kind = options.old ? 'server' : (json.kind ?? 'server');
      state.instances.set(json.instanceId, { jwk: { kty: json.jwk.kty, crv: json.jwk.crv, x: json.jwk.x }, kind, linked: true });
      return answer(201, {
        instanceId: json.instanceId,
        ...(kind === 'backup-machine' ? { kind } : {}),
        oidc: { issuer: ISSUER, clientId: json.instanceId, scope: 'openid email profile', roleClaim: 'frameleaf_role', storageLabelClaim: '' },
        services: {},
        owner: { accountId: randomUUID(), label: 'Taylor household', email: 'owner@example.test', dataRegion: 'na' },
      });
    }

    // Everything below is an instance route: a bound token, and a proof that names it.
    const token = headers.get('authorization')?.replace(/^DPoP /, '') ?? '';
    const held = state.tokens.get(token);
    if (!held || !headers.get('authorization')?.startsWith('DPoP ')) return envelope(401, 'invalid_token');
    const jkt = proof({ method, url, headers }, false, token);
    if (typeof jkt !== 'string') return jkt;
    if (jkt !== held.jkt) return envelope(401, 'invalid_token');
    const instance = state.instances.get(held.instanceId)!;

    if (route === 'DELETE api/v1/instance') {
      instance.linked = false;
      return answer(204, null);
    }
    if (instance.kind !== 'backup-machine') return envelope(403, 'forbidden');

    if (route === 'PUT api/v1/backup-machine/parent') {
      const { statement, signature } = json;
      const parent = state.instances.get(statement.parentInstanceId);
      const signed = `frameleaf-backup-machine-attach-v1\n${JSON.stringify({ version: statement.version, parentInstanceId: statement.parentInstanceId, machineInstanceId: statement.machineInstanceId, issuedAt: statement.issuedAt, signerKid: statement.signerKid })}`;
      const good =
        parent?.kind === 'server' &&
        statement.machineInstanceId === held.instanceId &&
        statement.signerKid === thumbprint(parent.jwk) &&
        verify(null, Buffer.from(signed), createPublicKey({ key: parent.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
      return good ? answer(200, { parent: { instanceId: statement.parentInstanceId, name: 'Family library', attachedAt: new Date(state.now).toISOString(), follows: true } }) : envelope(422, 'request-invalid');
    }
    if (route === 'GET api/v4/backup/locations')
      return answer(200, { version: 2, locations: [{ locationId: 'loc-01', cityId: 'ashburn', city: 'Ashburn', country: 'United States', countryCode: 'US', probeUrl: 'https://s3.us-east-1.backup.frameleaf.cloud/' }] });

    if (route === 'POST api/v4/backup/lease') {
      if (state.lease && state.lease.leaseId !== json.leaseId)
        return envelope(409, 'lease-held', { retryable: true, data: { operation: state.lease.operation, retryAfterSec: 240 } }, { 'retry-after': '240' });
      const fresh = !state.lease;
      state.lease = { leaseId: json.leaseId, operation: json.operation, holder: held.instanceId };
      return answer(fresh ? 201 : 200, { leaseId: json.leaseId, operation: json.operation, acquiredAt: new Date(state.now).toISOString(), expiresAt: new Date(state.now + 300_000).toISOString(), heartbeatAfterSec: 60 });
    }
    if (route === 'POST api/v4/backup/lease/heartbeat')
      return state.lease?.leaseId === json.leaseId
        ? answer(200, { leaseId: json.leaseId, operation: state.lease!.operation, acquiredAt: new Date(state.now).toISOString(), expiresAt: new Date(state.now + 300_000).toISOString(), heartbeatAfterSec: 60 })
        : envelope(409, 'lease-lost');
    if (route === 'DELETE api/v4/backup/lease') {
      if (state.lease?.leaseId === url.searchParams.get('leaseId')) state.lease = null;
      return answer(204, null);
    }

    if (route === 'POST api/v4/backup/grant' || route === 'POST api/v4/backup/grant/rotate') {
      if (json.objectFormat !== REPOSITORY_FORMAT) return envelope(426, 'backup-protocol-required');
      if (!state.entitled) return envelope(402, 'entitlement-missing', { data: { missing: 'licence' } });
      if (route.endsWith('rotate') && !state.grant) return envelope(404, 'not-found');
      if (json.operation === 'restore' ? json.leaseId !== undefined : state.lease?.leaseId !== json.leaseId) return envelope(json.operation === 'restore' ? 422 : 409, json.operation === 'restore' ? 'request-invalid' : 'lease-lost');
      const created = !state.grant;
      state.grant = { ...(await fixture('capability-repository-upload.json')) };
      state.grant.capability = { ...state.grant.capability, operation: json.operation };
      return answer(created ? 201 : 200, state.grant);
    }
    return envelope(404, 'not-found');
  };
  return { state, fetch: handle as typeof fetch };
}

const connect = (options: { old?: boolean } = {}) => {
  const cloud = standIn(options);
  return { ...cloud, client: new Cloud(API, { fetch: cloud.fetch, now: () => cloud.state.now }) };
};

/** A machine that has been through linking. */
async function linked(options: { old?: boolean } = {}) {
  const made = connect(options);
  const identity = createIdentity(made.state.now);
  const started = await made.client.startLink(identity, machine);
  await made.client.pollLink(started.deviceCode);
  const approved = await made.client.pollLink(started.deviceCode);
  assert.equal(approved.state, 'approved');
  const account = await made.client.register(identity, (approved as { linkToken: string }).linkToken, machine);
  return { ...made, identity, started, account };
}

test('an identity is a version 7 id and a key named by its thumbprint', () => {
  const first = uuidv7(1_000);
  const later = uuidv7(2_000);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(first < later);
  const identity = createIdentity();
  assert.equal(identity.kid, thumbprint(publicJwk(identity.privateKey)));
  assert.equal(identity.kid.length, 43);
  assert.match(identity.privateKey, /BEGIN PRIVATE KEY/);
});

test('linking shows a code, waits for approval and registers as a backup machine', async () => {
  const { state, started, account, identity } = await linked();
  assert.deepEqual([started.userCode, started.approveAt, started.intervalSec], ['BCDF-GHJK', 'https://frameleaf.cloud/device?user_code=BCDF-GHJK', 5]);
  assert.deepEqual(account, { account: 'Taylor household', email: 'owner@example.test', dataRegion: 'na' });
  assert.equal(state.instances.get(identity.instanceId)?.kind, 'backup-machine');
  // Registration is sent twice: the first answer only says which nonce to use.
  assert.equal(state.calls.filter((call) => call === 'POST api/v1/instances').length, 2);
});

test('a Cloud that links it as a photo server is refused, and the link is undone', async () => {
  await assert.rejects(linked({ old: true }), refused('cloud_too_old_for_backup_machines'));
});

test('calls sign in once, prove the key each time, and follow a changed nonce', async () => {
  const { state, client, identity } = await linked();
  assert.equal((await client.locations(identity))[0]!.locationId, 'loc-01');
  await client.locations(identity);
  // One sign-in (asked twice, for its nonce), reused by both calls.
  assert.equal(state.calls.filter((call) => call === 'POST id/token').length - 2, 2);

  // The API's nonce moves on: the next call is told so once, and is sent again with the new one.
  state.nonce[API] = 'api-2';
  await client.locations(identity);
  assert.equal(state.calls.filter((call) => call === 'GET api/v4/backup/locations').length, 4);

  // A token that stops working is dropped; the next call signs in again.
  state.tokens.clear();
  await assert.rejects(client.locations(identity), refused('invalid_token', 401));
  assert.equal((await client.locations(identity)).length, 1);

  // Ten minutes on, the held token is past its use-by time and a new one is fetched first.
  const before = state.calls.filter((call) => call === 'POST id/token').length;
  state.now += 10 * 60_000;
  await client.locations(identity);
  assert.ok(state.calls.filter((call) => call === 'POST id/token').length > before);
});

test('attaching needs a statement signed by the photo server’s own key', async () => {
  const { state, client, identity } = await linked();
  const server: Identity = createIdentity(state.now);
  state.instances.set(server.instanceId, { jwk: publicJwk(server.privateKey), kind: 'server', linked: true });
  const statement = { version: 1, parentInstanceId: server.instanceId, machineInstanceId: identity.instanceId, issuedAt: new Date(state.now).toISOString(), signerKid: server.kid };
  const signature = signText(server, `frameleaf-backup-machine-attach-v1\n${JSON.stringify(statement)}`);

  assert.deepEqual(await client.attach(identity, { statement, signature }), { instanceId: server.instanceId, name: 'Family library', attachedAt: new Date(state.now).toISOString(), follows: true });
  // Signed by the machine itself: not the photo server's word.
  await assert.rejects(client.attach(identity, { statement, signature: signText(identity, `frameleaf-backup-machine-attach-v1\n${JSON.stringify(statement)}`) }), refused('request-invalid', 422));
});

test('credentials come only under a lease, and one run holds it at a time', async () => {
  const { state, client, identity } = await linked();
  await assert.rejects(client.grant(identity, { locationId: 'loc-01', operation: 'upload', leaseId: randomUUID() }), refused('lease-lost', 409));

  const lease = await client.acquireLease(identity, 'backup');
  const grant = await client.grant(identity, { locationId: 'loc-01', operation: 'upload', leaseId: lease.leaseId });
  assert.deepEqual([grant.capability.operation, grant.region, grant.bucket.startsWith('fl-')], ['upload', 'us-east-1', true]);
  assert.ok(grant.capability.credentials.sessionToken);
  assert.equal((await client.rotate(identity, { operation: 'upload', leaseId: lease.leaseId })).capability.operation, 'upload');
  assert.equal((await client.heartbeat(identity, lease.leaseId)).leaseId, lease.leaseId);
  // Restores need no lease, and may not name one.
  assert.equal((await client.rotate(identity, { operation: 'restore' })).capability.operation, 'restore');

  await assert.rejects(client.acquireLease(identity, 'prune'), (error: unknown) => refused('lease-held', 409)(error) && (error as CloudError).retryAfterSec === 240);
  await client.releaseLease(identity, lease.leaseId);
  assert.equal((await client.acquireLease(identity, 'prune')).operation, 'prune');

  state.entitled = false;
  await assert.rejects(client.rotate(identity, { operation: 'restore' }), (error: unknown) => refused('entitlement-missing', 402)(error) && (error as CloudError).data?.missing === 'licence');
});

test('an address Cloud hands over must be on Cloud', async () => {
  for (const issuer of ['https://id.frameleaf.example', 'http://id.frameleaf.cloud', 'https://id.frameleaf.cloud:8443', 'https://user:pass@id.frameleaf.cloud']) {
    const { state, client } = connect();
    state.discovery.issuer = issuer;
    await assert.rejects(client.discovery(), refused('cloud_address_untrusted'), issuer);
  }
  const { client } = connect();
  assert.deepEqual(await client.discovery().then(({ issuer, api }) => [issuer, api]), [ISSUER, API]);
});

test('Cloud’s own example answers still read the way this client expects', async () => {
  const pinned: Record<string, string> = {
    'capability-repository-upload.json': '19779b163029c660b491e500228f76bf7ad6359d514d0551875ac8d5bf46775c',
    'lease.json': '99fad84cc5533127a0a9edd3763c3f1ca7e48d21a330f04b394a12d5fc190755',
  };
  for (const [name, hash] of Object.entries(pinned)) assert.equal(createHash('sha256').update(await readFile(join(fixtures, name))).digest('hex'), hash, name);
  assert.equal(Grant.parse(await fixture('capability-repository-upload.json')).capability.operation, 'upload');
  assert.equal(Lease.parse(await fixture('lease.json')).heartbeatAfterSec, 60);
});
