// Manager's own connection to Frameleaf Cloud, as a "backup machine": an identity made on this server,
// sign-in that proves possession of its key on every request, and the calls Server Backup needs.
// The contract is frameleaf-cloud's `docs/instance-contract.md` and `docs/cloud-backup.md` (FC-284, FC-286).
// The photo server has its own link; nothing here uses it or its key.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { z } from 'zod';

export const REPOSITORY_FORMAT = 'frameleaf-repository/1';

/** A refusal from Frameleaf Cloud, with the code a caller branches on. */
export class CloudError extends Error {
  override name = 'CloudError';
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly detail: string | null = null,
    readonly data: Record<string, unknown> | null = null,
    /** Seconds Cloud asked the caller to wait, when it said. */
    readonly retryAfterSec: number | null = null,
  ) {
    super(code);
  }
}

export interface Identity {
  /** Chosen here, once. The bucket and every right this machine has in Cloud hang on it and on the key. */
  instanceId: string;
  /** Ed25519, PKCS#8 PEM. Never sent anywhere. */
  privateKey: string;
  /** The key's RFC 7638 thumbprint: how Cloud names it. */
  kid: string;
  createdAt: string;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const seconds = (now: number) => Math.floor(now / 1000);

/** A time-ordered UUID (version 7), which is what Cloud accepts as an instance id. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function publicJwk(privateKey: string) {
  const { x } = createPublicKey(createPrivateKey(privateKey)).export({ format: 'jwk' });
  return { kty: 'OKP', crv: 'Ed25519', x: x! } as const;
}
const thumbprint = (jwk: { kty: string; crv: string; x: string }) =>
  createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');

export function createIdentity(now = Date.now()): Identity {
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { instanceId: uuidv7(now), privateKey, kid: thumbprint(publicJwk(privateKey)), createdAt: new Date(now).toISOString() };
}

/** A raw Ed25519 signature over `text`, as Cloud's signed statements use. */
export const signText = (identity: Identity, text: string) => sign(null, Buffer.from(text, 'utf8'), createPrivateKey(identity.privateKey)).toString('base64url');

const jws = (identity: Identity, header: object, payload: object) => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${signText(identity, input)}`;
};

/** The address a proof is bound to: no query, no fragment. */
const boundTo = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};

const Discovery = z.object({ issuer: z.url({ protocol: /^https?$/ }), api: z.url({ protocol: /^https?$/ }), validFor: z.number().int().min(60).max(604_800) });
const LinkStart = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().min(1).max(32),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const Registered = z.object({
  instanceId: z.string(),
  kind: z.string().optional(),
  owner: z.object({ accountId: z.string(), label: z.string(), email: z.string(), dataRegion: z.string() }),
});
export const Lease = z.object({
  leaseId: z.uuid(),
  operation: z.enum(['backup', 'prune']),
  acquiredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  heartbeatAfterSec: z.number().int().positive(),
});
export type Lease = z.infer<typeof Lease>;
const formats = z.array(z.object({ format: z.string(), version: z.number().int() }));
export const Grant = z.object({
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  endpoint: z.url({ protocol: /^https?$/ }),
  bucket: z.string().regex(/^fl-(sbx-)?(eu|na)-[0-9a-f-]{36}$/),
  quotaBytes: z.number().int().nonnegative(),
  readOnly: z.boolean(),
  storageId: z.uuid(),
  location: z.object({ locationId: z.string(), city: z.string(), country: z.string(), countryCode: z.string() }),
  objectFormats: z.object({ read: formats, write: formats }),
  capability: z.object({
    operation: z.enum(['upload', 'restore', 'prune']),
    expiresAt: z.iso.datetime(),
    refreshAfterSec: z.number().int().min(1).max(600),
    credentials: z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().min(1) }),
  }),
});
export type Grant = z.infer<typeof Grant>;
const Parent = z.object({ parent: z.object({ instanceId: z.string(), name: z.string(), attachedAt: z.string(), follows: z.boolean() }).nullable() });

type Operation = 'upload' | 'restore' | 'prune';
type Sent = { status: number; headers: Headers; body: unknown };

export class Cloud {
  private discovered: { issuer: string; api: string; until: number } | null = null;
  /** Proof-of-possession nonces, by origin. The sign-in host's never work on the API host. */
  private nonces = new Map<string, string>();
  private tokens = new Map<string, { token: string; until: number }>();

  constructor(
    /** `FRAMELEAF_CLOUD_URL`: where discovery is read from. */
    private url: string,
    private options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The same address rule the photo server applies: an address Cloud hands over must be on the configured
   * host, a subdomain of it, or (for frameleaf.cloud) a sibling under it; https unless the configured
   * address is itself http; the same port; no credentials. Otherwise a tampered answer could send a
   * signed assertion or a token somewhere else.
   */
  private trusted(name: string, value: string): string {
    const configured = new URL(this.url);
    const url = new URL(value);
    const host = configured.hostname.toLowerCase();
    const candidate = url.hostname.toLowerCase();
    const domain = host.endsWith('.frameleaf.cloud') ? 'frameleaf.cloud' : null;
    const port = (address: URL) => address.port || (address.protocol === 'http:' ? '80' : '443');
    const onCloud = candidate === host || candidate.endsWith(`.${host}`) || (domain !== null && (candidate === domain || candidate.endsWith(`.${domain}`)));
    if (
      (url.protocol !== 'https:' && !(configured.protocol === 'http:' && url.protocol === 'http:')) ||
      !onCloud ||
      port(url) !== port(configured) ||
      url.username ||
      url.password
    )
      throw new CloudError('cloud_address_untrusted', null, name);
    return value.replace(/\/+$/, '');
  }

  private async send(url: string, init: RequestInit): Promise<Sent> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'manual' });
    } catch {
      throw new CloudError('cloud_unreachable', null);
    }
    const nonce = response.headers.get('dpop-nonce');
    if (nonce) this.nonces.set(new URL(url).origin, nonce);
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new CloudError('cloud_answer_unreadable', response.status);
    }
    return { status: response.status, headers: response.headers, body };
  }

  async discovery(): Promise<{ issuer: string; api: string }> {
    if (this.discovered && this.discovered.until > this.now()) return this.discovered;
    const answer = await this.send(`${this.url.replace(/\/+$/, '')}/.well-known/frameleaf-services`, { method: 'GET' });
    const parsed = Discovery.safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) throw new CloudError('cloud_answer_unreadable', answer.status);
    this.discovered = {
      issuer: this.trusted('issuer', parsed.data.issuer),
      api: this.trusted('api', parsed.data.api),
      until: this.now() + Math.min(parsed.data.validFor, 3600) * 1000,
    };
    return this.discovered;
  }

  private proof(identity: Identity, method: string, url: string, token?: string) {
    const nonce = this.nonces.get(new URL(url).origin);
    return jws(
      identity,
      { typ: 'dpop+jwt', alg: 'EdDSA', jwk: publicJwk(identity.privateKey) },
      {
        jti: randomUUID(),
        htm: method,
        htu: boundTo(url),
        iat: seconds(this.now()),
        ...(nonce ? { nonce } : {}),
        ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}),
      },
    );
  }

  private refusal(answer: Sent): CloudError {
    const body = (answer.body ?? {}) as { code?: string; error?: string; detail?: string; data?: Record<string, unknown> };
    const after = Number(answer.headers.get('retry-after'));
    return new CloudError(body.code ?? body.error ?? 'cloud_refused', answer.status, typeof body.detail === 'string' ? body.detail : null, body.data ?? null, Number.isFinite(after) && after > 0 ? after : null);
  }
  private static wantsNonce = (answer: Sent) => {
    const body = (answer.body ?? {}) as { code?: string; error?: string };
    return (answer.status === 400 || answer.status === 401) && (body.code ?? body.error) === 'use_dpop_nonce';
  };

  /** Starts linking: Cloud answers with a short code for the owner to approve on the account site. */
  async startLink(identity: Identity, machine: { name: string; version: string; platform: string }) {
    const { issuer } = await this.discovery();
    const answer = await this.send(`${issuer}/device/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'frameleaf-link', instance_name: machine.name, version: machine.version, platform: machine.platform, jkt: identity.kid }),
    });
    const parsed = LinkStart.safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) throw this.refusal(answer);
    return {
      deviceCode: parsed.data.device_code,
      userCode: parsed.data.user_code,
      // Shown to the owner as a link, so it must be on Cloud too.
      approveAt: this.trusted('verification_uri_complete', parsed.data.verification_uri_complete),
      expiresInSec: parsed.data.expires_in,
      intervalSec: parsed.data.interval,
    };
  }

  /** One look at whether the owner has approved. `waiting` and `slower` mean ask again; the rest are final. */
  async pollLink(deviceCode: string): Promise<{ state: 'waiting' | 'slower' | 'refused' | 'expired' } | { state: 'approved'; linkToken: string }> {
    const { issuer } = await this.discovery();
    const answer = await this.send(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'frameleaf-link' }),
    });
    const body = (answer.body ?? {}) as { error?: string; access_token?: string };
    if (answer.status === 200 && typeof body.access_token === 'string') return { state: 'approved', linkToken: body.access_token };
    if (body.error === 'authorization_pending') return { state: 'waiting' };
    if (body.error === 'slow_down') return { state: 'slower' };
    if (body.error === 'access_denied') return { state: 'refused' };
    if (body.error === 'expired_token' || body.error === 'invalid_grant') return { state: 'expired' };
    throw this.refusal(answer);
  }

  /**
   * Registers this machine with the approved link token.
   * A Cloud from before backup machines existed ignores `kind` and links a photo server instead. That
   * can't be undone for this id and key, so it is unlinked and reported: the caller must throw the
   * identity away and never use it again.
   */
  async register(identity: Identity, linkToken: string, machine: { name: string; version: string; platform: string }) {
    const { api } = await this.discovery();
    const url = `${api}/v1/instances`;
    const body = JSON.stringify({
      instanceId: identity.instanceId,
      kind: 'backup-machine',
      name: machine.name,
      version: machine.version,
      platform: machine.platform,
      jwk: { ...publicJwk(identity.privateKey), kid: identity.kid },
      bootId: randomUUID(),
      // Declares proof-of-possession on every later call. A machine sends no heartbeat, so this is its one chance to.
      capabilities: ['dpop'],
      permissions: { allowRemoteEnable: false, allowBackupTrigger: false, allowEntitlementRefresh: false },
    });
    const once = () =>
      this.send(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${linkToken}`, dpop: this.proof(identity, 'POST', url), 'content-type': 'application/json' },
        body,
      });
    let answer = await once();
    // The first try always answers with the nonce to use. The link token is not spent by it.
    if (Cloud.wantsNonce(answer)) answer = await once();
    const parsed = Registered.safeParse(answer.body);
    if (answer.status !== 201 || !parsed.success) throw this.refusal(answer);
    if (parsed.data.kind !== 'backup-machine' || parsed.data.instanceId !== identity.instanceId) {
      await this.call(identity, 'DELETE', '/v1/instance').catch(() => undefined);
      throw new CloudError('cloud_too_old_for_backup_machines', null);
    }
    return { account: parsed.data.owner.label, email: parsed.data.owner.email, dataRegion: parsed.data.owner.dataRegion };
  }

  /** A ten-minute access token bound to this machine's key. Kept until a minute before it ends. */
  private async token(identity: Identity): Promise<string> {
    const { issuer, api } = await this.discovery();
    const key = `${identity.instanceId} ${identity.kid} ${api}`;
    const held = this.tokens.get(key);
    if (held && held.until > this.now()) return held.token;
    const url = `${issuer}/token`;
    const once = () => {
      const iat = seconds(this.now());
      return this.send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: this.proof(identity, 'POST', url) },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: identity.instanceId,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: jws(
            identity,
            { alg: 'EdDSA', typ: 'JWT', kid: identity.kid },
            { iss: identity.instanceId, sub: identity.instanceId, aud: url, jti: randomUUID(), iat, exp: iat + 120 },
          ),
          resource: api,
          scope: 'instance',
        }),
      });
    };
    let answer = await once();
    if (Cloud.wantsNonce(answer)) answer = await once();
    const body = (answer.body ?? {}) as { access_token?: string; token_type?: string; expires_in?: number };
    if (answer.status !== 200 || typeof body.access_token !== 'string' || body.token_type !== 'DPoP' || typeof body.expires_in !== 'number') throw this.refusal(answer);
    // The token must be bound to this key, or it is not ours to use.
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1] ?? '', 'base64url').toString() || '{}') as { cnf?: { jkt?: string } };
    if (claims.cnf?.jkt !== identity.kid) throw new CloudError('cloud_token_not_bound', null);
    this.tokens.set(key, { token: body.access_token, until: this.now() + (body.expires_in - 60) * 1000 });
    return body.access_token;
  }

  /** One call to an instance route. `path` may carry a query; the proof is bound to the path alone. */
  async call(identity: Identity, method: string, path: string, body?: unknown): Promise<unknown> {
    const { api } = await this.discovery();
    const url = `${api}${path}`;
    const once = async () => {
      const token = await this.token(identity);
      return this.send(url, {
        method,
        headers: { authorization: `DPoP ${token}`, dpop: this.proof(identity, method, url, token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    let answer = await once();
    if (Cloud.wantsNonce(answer)) answer = await once();
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    // Any other 401 means the token is no good any more; the next call signs in again.
    if (answer.status === 401) this.tokens.clear();
    throw this.refusal(answer);
  }

  unlink(identity: Identity) {
    return this.call(identity, 'DELETE', '/v1/instance');
  }

  /**
   * Ties this machine to the photo server it manages, so it shares that server's licence and plan.
   * The statement is signed by the photo server's key, not this machine's.
   */
  async attach(identity: Identity, attachment: { statement: unknown; signature: string }) {
    return Parent.parse(await this.call(identity, 'PUT', '/v1/backup-machine/parent', attachment)).parent;
  }
  async parent(identity: Identity) {
    return Parent.parse(await this.call(identity, 'GET', '/v1/backup-machine/parent')).parent;
  }

  async locations(identity: Identity) {
    return z.object({ locations: z.array(z.object({ locationId: z.string(), city: z.string(), country: z.string(), countryCode: z.string() })) }).parse(await this.call(identity, 'GET', '/v4/backup/locations')).locations;
  }

  private checked(answer: unknown, operation: Operation): Grant {
    const grant = Grant.parse(answer);
    const writes = grant.objectFormats.write.some((item) => `${item.format}/${item.version}` === REPOSITORY_FORMAT);
    if (grant.capability.operation !== operation || !writes) throw new CloudError('cloud_answer_unreadable', null);
    return grant;
  }
  /** The first credentials for a place. Storage is made on the first call. Upload and prune name the lease they run under. */
  async grant(identity: Identity, request: { locationId: string; operation: Operation; leaseId?: string }) {
    return this.checked(await this.call(identity, 'POST', '/v4/backup/grant', { ...request, objectFormat: REPOSITORY_FORMAT }), request.operation);
  }
  /** Fresh credentials for storage that already exists. Earlier ones keep working until they expire. */
  async rotate(identity: Identity, request: { operation: Operation; leaseId?: string }) {
    return this.checked(await this.call(identity, 'POST', '/v4/backup/grant/rotate', { ...request, objectFormat: REPOSITORY_FORMAT }), request.operation);
  }

  /** One backup or prune at a time per machine. Refused with `lease-held` while another is live. */
  async acquireLease(identity: Identity, operation: Lease['operation'], leaseId: string = randomUUID()) {
    return Lease.parse(await this.call(identity, 'POST', '/v4/backup/lease', { leaseId, operation }));
  }
  /** Every minute while a run goes. `lease-lost` means stop writing at once. */
  async heartbeat(identity: Identity, leaseId: string) {
    return Lease.parse(await this.call(identity, 'POST', '/v4/backup/lease/heartbeat', { leaseId }));
  }
  releaseLease(identity: Identity, leaseId: string) {
    return this.call(identity, 'DELETE', `/v4/backup/lease?leaseId=${encodeURIComponent(leaseId)}`);
  }

  usage(identity: Identity) {
    return this.call(identity, 'GET', '/v1/backup/usage') as Promise<{ bytesCurrent: number; accountBytesCurrent: number; allowanceBytes: number; readOnly: boolean; readOnlyReason: string | null }>;
  }
}
