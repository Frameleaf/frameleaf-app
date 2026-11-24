// Frameleaf Cloud for tests: shared by the Cloud client's tests and Server Backup's.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_FORMAT } from '../src/cloud-link.js';

export const ISSUER = 'https://id.frameleaf.cloud';
export const API = 'https://api.frameleaf.cloud';
export const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloud');
export const fixture = async (name: string) => JSON.parse(await readFile(join(fixtures, name), 'utf8'));
export const machine = { name: 'home-server', version: '1.2.24', platform: 'manager/linux' };
export const thumbprint = (jwk: { kty: string; crv: string; x: string }) => createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
export const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

/**
 * Frameleaf Cloud, as far as a backup machine meets it. It checks what the real service checks: every
 * signature, what each proof is bound to, the nonce for each host, and that nothing is replayed.
 */
export function standIn(options: { old?: boolean } = {}) {
  const state = {
    now: Date.parse('2026-11-17T12:00:00Z'),
    nonce: { [ISSUER]: 'issuer-1', [API]: 'api-1' } as Record<string, string>,
    seen: new Set<string>(),
    calls: [] as string[],
    pollsBeforeApproval: 1,
    devices: new Map<string, { jkt: string; polls: number }>(),
    linkTokens: new Map<string, string>(),
    instances: new Map<string, { jwk: { kty: string; crv: string; x: string }; kind: string; linked: boolean; name: string }>(),
    tokens: new Map<string, { instanceId: string; jkt: string }>(),
    lease: null as { leaseId: string; operation: string; holder: string } | null,
    entitled: true,
    chain: [] as { snapshotId: string; sequence: number; digest: string; record: unknown }[],
    grant: null as Record<string, any> | null,
    /** Laid over every grant, so a test can point storage at its own stand-in. */
    storage: {} as Record<string, unknown>,
    heartbeatAfterSec: 60,
    /** How many of the next snapshot records to refuse as if Cloud were down. */
    refuseSnapshots: 0,
    /** Which photo server vouches for which backup machine. */
    parents: new Map<string, string>(),
    purges: new Map<string, { id: string; status: string }>(),
    keyModes: new Map<string, string>(),
    escrows: new Map<string, Record<string, unknown>>(),
    takeovers: [] as { takeoverId: string; fromInstanceId: string; asker: string; status: string }[],
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
      state.instances.set(json.instanceId, { jwk: { kty: json.jwk.kty, crv: json.jwk.crv, x: json.jwk.x }, kind, linked: true, name: json.name });
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

    const shown = (item: (typeof state.takeovers)[number]) => ({
      takeoverId: item.takeoverId,
      fromInstanceId: item.fromInstanceId,
      status: item.status,
      requestedAt: new Date(state.now).toISOString(),
      expiresAt: new Date(state.now + 72 * 3_600_000).toISOString(),
      instanceId: item.status === 'approved' ? item.fromInstanceId : null,
      writesFrom: item.status === 'approved' ? new Date(state.now + 900_000).toISOString() : null,
    });
    // Still answered to a token the asker got before approval unlinked it.
    if (route === 'GET api/v1/backup-machine/takeover') {
      const mine = state.takeovers.findLast((item) => item.asker === held.instanceId);
      return mine ? answer(200, shown(mine)) : envelope(404, 'not-found');
    }
    if (route === 'GET api/v1/backup-machine/takeover/candidates')
      return answer(200, {
        machines: [...state.instances]
          .filter(([id, other]) => id !== held.instanceId && other.kind === 'backup-machine' && state.chain.length > 0)
          .map(([id, other]) => ({ instanceId: id, name: other.name, lastBackupAt: new Date(state.now).toISOString() })),
      });
    if (route === 'POST api/v1/backup-machine/takeover') {
      const from = state.instances.get(json.fromInstanceId);
      if (!from || from.kind !== 'backup-machine' || json.fromInstanceId === held.instanceId) return envelope(404, 'not-found');
      const again = state.takeovers.find((item) => item.asker === held.instanceId && item.fromInstanceId === json.fromInstanceId && item.status === 'pending');
      if (again) return answer(200, shown(again));
      const made = { takeoverId: randomUUID(), fromInstanceId: json.fromInstanceId as string, asker: held.instanceId, status: 'pending' };
      state.takeovers.push(made);
      return answer(201, shown(made));
    }

    if (route === 'PUT api/v1/backup-machine/parent') {
      const { statement, signature } = json;
      const parent = state.instances.get(statement.parentInstanceId);
      const signed = `frameleaf-backup-machine-attach-v1\n${JSON.stringify({ version: statement.version, parentInstanceId: statement.parentInstanceId, machineInstanceId: statement.machineInstanceId, issuedAt: statement.issuedAt, signerKid: statement.signerKid })}`;
      const good =
        parent?.kind === 'server' &&
        statement.machineInstanceId === held.instanceId &&
        statement.signerKid === thumbprint(parent.jwk) &&
        verify(null, Buffer.from(signed), createPublicKey({ key: parent.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
      if (good) state.parents.set(held.instanceId, statement.parentInstanceId);
      return good ? answer(200, { parent: { instanceId: statement.parentInstanceId, name: 'Family library', attachedAt: new Date(state.now).toISOString(), follows: true } }) : envelope(422, 'request-invalid');
    }
    if (route === 'PUT api/v1/backup/settings') {
      state.keyModes.set(held.instanceId, json.keyMode);
      if (json.keyMode !== 'server') state.escrows.delete(held.instanceId);
      return answer(200, { keyMode: json.keyMode, scheduleEnabled: json.scheduleEnabled });
    }
    if (route.endsWith(' api/v1/backup/escrow')) {
      if (method === 'GET') return state.escrows.has(held.instanceId) ? answer(200, { ...state.escrows.get(held.instanceId), updatedAt: new Date(state.now).toISOString() }) : envelope(404, 'not-found');
      if (state.keyModes.get(held.instanceId) !== 'server') return envelope(409, 'escrow-not-allowed');
      if (json.kdf?.name !== 'scrypt' || json.cipher !== 'aes-256-gcm' || typeof json.ciphertext !== 'string') return envelope(422, 'request-invalid');
      state.escrows.set(held.instanceId, json);
      return answer(200, { ...json, updatedAt: new Date(state.now).toISOString() });
    }
    if (route.endsWith(' api/v1/backup/purge')) {
      const purge = state.purges.get(held.instanceId);
      const shown = (item: typeof purge) => ({ id: item!.id, status: item!.status, requestedBy: 'instance', requestedAt: new Date(state.now).toISOString(), holdUntil: new Date(state.now + 30 * 86_400_000).toISOString(), purgeBy: new Date(state.now + 90 * 86_400_000).toISOString(), cancellable: true, cancelledAt: null, purgedAt: null });
      if (method === 'GET') return purge ? answer(200, shown(purge)) : envelope(404, 'not-found');
      if (method === 'POST') {
        if (!state.grant) return envelope(404, 'not-found');
        const open = purge?.status === 'held' ? purge : { id: randomUUID(), status: 'held' };
        state.purges.set(held.instanceId, open);
        return answer(200, shown(open));
      }
      if (purge?.status !== 'held') return envelope(409, 'request-invalid');
      purge.status = 'cancelled';
      return answer(200, shown(purge));
    }
    if (route === 'GET api/v1/backup/usage')
      return answer(200, { bytesCurrent: 412e9, bytesNoncurrent: 0, objects: 10, includedBytes: 1e12, accountBytesCurrent: 450e9, extraBlocks: 0, allowanceBytes: 1e12, blockBytes: 1e12, readOnly: false, readOnlyReason: null });
    if (route === 'GET api/v4/backup/locations')
      return answer(200, { version: 2, locations: [{ locationId: 'loc-01', cityId: 'ashburn', city: 'Ashburn', country: 'United States', countryCode: 'US', probeUrl: 'https://s3.us-east-1.backup.frameleaf.cloud/' }] });

    if (route === 'POST api/v4/backup/lease') {
      if (state.lease && state.lease.leaseId !== json.leaseId)
        return envelope(409, 'lease-held', { retryable: true, data: { operation: state.lease.operation, retryAfterSec: 240 } }, { 'retry-after': '240' });
      const fresh = !state.lease;
      state.lease = { leaseId: json.leaseId, operation: json.operation, holder: held.instanceId };
      return answer(fresh ? 201 : 200, { leaseId: json.leaseId, operation: json.operation, acquiredAt: new Date(state.now).toISOString(), expiresAt: new Date(state.now + 300_000).toISOString(), heartbeatAfterSec: state.heartbeatAfterSec });
    }
    if (route === 'POST api/v4/backup/lease/heartbeat')
      return state.lease?.leaseId === json.leaseId
        ? answer(200, { leaseId: json.leaseId, operation: state.lease!.operation, acquiredAt: new Date(state.now).toISOString(), expiresAt: new Date(state.now + 300_000).toISOString(), heartbeatAfterSec: state.heartbeatAfterSec })
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
      state.grant = { ...(await fixture('capability-repository-upload.json')), ...state.storage };
      state.grant.capability = { ...state.grant.capability, operation: json.operation };
      return answer(created ? 201 : 200, state.grant);
    }
    if (route === 'POST api/v2/backup/snapshots') {
      const { descriptor, signature } = json;
      const signed = `frameleaf-backup-snapshot-v2\n${JSON.stringify({ version: descriptor.version, instanceId: descriptor.instanceId, vaultId: descriptor.vaultId, snapshotId: descriptor.snapshotId, sequence: descriptor.sequence, previousDigest: descriptor.previousDigest, createdAt: descriptor.createdAt, manifest: { format: descriptor.manifest.format, formatVersion: descriptor.manifest.formatVersion, keyVersion: descriptor.manifest.keyVersion, objectKey: descriptor.manifest.objectKey, versionId: descriptor.manifest.versionId, ciphertextSha256: descriptor.manifest.ciphertextSha256 }, signerKid: descriptor.signerKid })}`;
      const sound =
        descriptor.instanceId === held.instanceId &&
        descriptor.signerKid === held.jkt &&
        descriptor.manifest.format === 'frameleaf-repository' &&
        descriptor.manifest.objectKey === `r/v1/${descriptor.vaultId}/s/${String(descriptor.sequence).padStart(12, '0')}-${descriptor.manifest.objectKey.split('-').at(-1)}` &&
        /^[0-9a-f]{16,64}$/.test(descriptor.manifest.objectKey.split('-').at(-1)) &&
        descriptor.manifest.versionId !== 'null' &&
        verify(null, Buffer.from(signed), createPublicKey({ key: instance.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
      if (!sound) return envelope(422, 'request-invalid');
      if (state.refuseSnapshots > 0 && state.refuseSnapshots--) return envelope(503, 'unavailable', { retryable: true });
      const replay = state.chain.find((item) => item.snapshotId === descriptor.snapshotId);
      if (replay) return answer(200, replay.record);
      const head = state.chain.at(-1);
      if (descriptor.sequence !== (head?.sequence ?? 0) + 1 || descriptor.previousDigest !== (head?.digest ?? null)) return envelope(409, 'snapshot-conflict');
      const digest = createHash('sha256').update(signed).digest('hex');
      const record = { descriptor, signature, digest, signerJwk: { ...instance.jwk, kid: held.jkt }, receivedAt: new Date(state.now).toISOString() };
      state.chain.push({ snapshotId: descriptor.snapshotId, sequence: descriptor.sequence, digest, record });
      return answer(200, record);
    }
    if (route === 'GET api/v2/backup/snapshots') {
      // Oldest first, a page at a time, with the newest entry on every page (FC-284).
      const vaultId = url.searchParams.get('vaultId');
      const afterSequence = Number(url.searchParams.get('afterSequence') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const shown = state.chain.filter((item) => (item.record as { descriptor: { vaultId: string } }).descriptor.vaultId === vaultId);
      const head = shown.at(-1);
      const page = shown.filter((item) => item.sequence > afterSequence).slice(0, limit);
      const last = page.at(-1);
      return answer(200, {
        snapshots: page.map((item) => item.record),
        head: head ? { sequence: head.sequence, digest: head.digest } : null,
        nextAfterSequence: last && last.sequence < head!.sequence ? last.sequence : null,
      });
    }
    if (route === 'POST api/v1/backup/runs')
      return /^r\/v1\/[0-9a-f-]{36}\/s\/\d{12}-[0-9a-f]{16,64}$/.test(json.manifestKey ?? '') || json.manifestKey === null ? answer(200, { ...json, receivedAt: new Date(state.now).toISOString() }) : envelope(422, 'request-invalid');
    return envelope(404, 'not-found');
  };
  /** What the owner's approval does (FC-287): the asker's key becomes the older machine's only key, and the id it linked as is unlinked. */
  const approve = () => {
    const request = state.takeovers.findLast((item) => item.status === 'pending')!;
    const asker = state.instances.get(request.asker)!;
    const from = state.instances.get(request.fromInstanceId)!;
    Object.assign(from, { jwk: asker.jwk, name: asker.name, linked: true });
    asker.linked = false;
    for (const [token, held] of state.tokens) if (held.instanceId === request.fromInstanceId) state.tokens.delete(token);
    state.lease = null;
    // The photo server vouched for the old installation, not this one.
    state.parents.delete(request.fromInstanceId);
    request.status = 'approved';
  };
  return { state, approve, fetch: handle as typeof fetch };
}
