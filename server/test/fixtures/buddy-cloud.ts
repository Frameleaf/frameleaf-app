import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import z from 'zod';
import { verifyBuddyGrant } from 'src/utils/buddy-backup-protocol.js';
import {
  BuddyAcceptRequest,
  BuddyAction,
  BuddyGrantClaims,
  BuddyGrantRequest,
  BuddyGrantResponse,
  BuddyInviteRequest,
  BuddyPairing,
  BuddyStatusReport,
  BuddyVerifyRequest,
} from 'src/utils/frameleaf-buddy.js';
import {
  cloudBackupSettingsSchema,
  cloudMlSettingsSchema,
  licenseStateSchema,
  remoteAccessSettingsSchema,
} from 'src/utils/frameleaf-cloud-settings.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { type FakeCloudAnswer, type FakeCloudRequest, mintToken, startFakeCloud } from 'test/fake-frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

export type BuddySide = 'a' | 'b';
export const BUDDY_SIDES = ['a', 'b'] as const;
export const buddyHost = (side: BuddySide) => `r.buddyfixture${side.repeat(4)}.buddy.test`;
export const buddyPort = (side: BuddySide) => (side === 'a' ? 38_443 : 38_444);
const publicKey = z.strictObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().length(43) });
const permissions = z.strictObject({
  allowRemoteEnable: z.boolean(),
  allowBackupTrigger: z.boolean(),
  allowEntitlementRefresh: z.boolean(),
});
const heartbeat = z.strictObject({
  version: z.string().max(128),
  bootId: z.uuid(),
  uptimeSec: z.number().int().nonnegative(),
  health: z.strictObject({
    database: z.enum(['ok', 'error']),
    storage: z.enum(['ok', 'error']),
    jobs: z.enum(['ok', 'error']),
  }),
  endpoints: z.array(z.strictObject({ kind: z.string().max(32), url: z.url() })).max(16),
  remoteAccess: z.strictObject({ enabled: z.literal(false), relayConnected: z.literal(false), direct: z.boolean() }),
  permissions,
  licenseKid: z.string().max(128).nullable(),
  capabilities: z.array(z.string().min(1).max(32)).max(16).optional(),
  remoteAccessSettings: remoteAccessSettingsSchema.optional(),
  cloudMl: cloudMlSettingsSchema.optional(),
  cloudBackup: cloudBackupSettingsSchema.optional(),
  licenseState: licenseStateSchema.optional(),
});
type Instance = { side: BuddySide; id: string; key: z.infer<typeof publicKey>; jkt: string };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const answer = (body: unknown): FakeCloudAnswer => ({ status: 200, body });
const refused = (): FakeCloudAnswer => ({
  status: 403,
  body: { code: 'fixture-binding-refused', message: 'Fixture identity or scope refused', retryable: false },
});
const strictForm = <T extends z.ZodType>(request: FakeCloudRequest, schema: T): z.infer<T> => {
  const entries = [...request.form()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error('Duplicate coordinator form field');
  }
  return schema.parse(Object.fromEntries(entries));
};

/** Only the coordinator is simulated. All peer proofs, ciphertext, receipts and publication are real app code. */
export const startBuddyCloud = async () => {
  const cloud = await startFakeCloud({
    listenHost: '0.0.0.0',
    listenPort: 30_186,
    advertisedHost: 'host.docker.internal',
  });
  const accounts = { a: randomUUID(), b: randomUUID() };
  const instances = new Map<BuddySide, Instance>();
  const devices = new Map<string, { side: BuddySide; jkt: string; expires: number; used: boolean }>();
  const links = new Map<string, { side: BuddySide; jkt: string; expires: number }>();
  const tokens = new Map<string, Instance>();
  const assertions = new Set<string>();
  const errors: string[] = [];
  const reports = new Map<string, z.infer<typeof BuddyStatusReport>>();
  let pairing: BuddyPairing | null = null;
  let invitation: {
    source: Instance;
    token: string;
    target: string;
    quota: number;
    expires: number;
    used: boolean;
  } | null = null;
  const confirmations = new Set<string>();
  const key = generateKeyPairSync('ed25519');
  const jwks = { keys: [{ ...publicKey.parse(key.publicKey.export({ format: 'jwk' })), kid: 'fl310-fixture' }] };
  const grants = new Set<string>();

  // FakeCloud validates DPoP signature/URL/nonce/replay first. This adds registered instance ownership.
  const actor = (request: FakeCloudRequest): Instance | undefined => {
    const token = request.headers.authorization?.match(/^DPoP (\S+)$/)?.[1];
    const instance = token ? tokens.get(token) : undefined;
    return instance && request.dpop?.jkt === instance.jkt ? instance : undefined;
  };
  const on = (route: string, handler: (request: FakeCloudRequest) => FakeCloudAnswer) => {
    cloud.on(route, (request) => {
      try {
        if (Buffer.byteLength(request.body) > 64 * 1024) {
          throw new Error('Oversized coordinator body');
        }
        if (request.method === 'GET' && request.body !== '') {
          throw new Error('Unexpected coordinator GET body');
        }
        return handler(request);
      } catch {
        // Never include bodies, keys, tokens or parser input in test output/artifacts.
        errors.push(route);
        return {
          status: 400,
          body: { code: 'fixture-contract-error', message: 'Fixture contract failure', retryable: false },
        };
      }
    });
  };
  const protectedRoute = (route: string, handler: (request: FakeCloudRequest, instance: Instance) => FakeCloudAnswer) =>
    on(route, (request) => {
      const instance = actor(request);
      return instance ? handler(request, instance) : refused();
    });

  on('POST /id/device/auth', (request) => {
    const form = strictForm(
      request,
      z.strictObject({
        client_id: z.literal('frameleaf-link'),
        instance_name: z.string().max(256),
        version: z.string().max(128),
        jkt: z.string().length(43),
        platform: z.string().max(128),
      }),
    );
    const side = BUDDY_SIDES[devices.size];
    if (!side) {
      throw new Error('Only the two owned accounts may link');
    }
    const code = randomBytes(32).toString('base64url');
    devices.set(code, { side, jkt: form.jkt, expires: Date.now() + 600_000, used: false });
    return answer({
      device_code: code,
      user_code: side === 'a' ? 'BCDF-GHJK' : 'MNPQ-RSTV',
      verification_uri: `${cloud.url}/link`,
      verification_uri_complete: `${cloud.url}/link?code=${side}`,
      expires_in: 600,
      interval: 1,
    });
  });
  on('POST /id/token', (request) => {
    if (request.form().get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      const form = strictForm(
        request,
        z.strictObject({
          grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
          device_code: z.string().length(43),
          client_id: z.literal('frameleaf-link'),
        }),
      );
      const device = devices.get(form.device_code);
      if (!device || device.used || device.expires <= Date.now()) {
        return refused();
      }
      device.used = true;
      const token = randomBytes(32).toString('base64url');
      links.set(token, { side: device.side, jkt: device.jkt, expires: device.expires });
      return answer({ access_token: token, expires_in: 600 });
    }
    const form = strictForm(
      request,
      z.strictObject({
        grant_type: z.literal('client_credentials'),
        client_id: z.uuid(),
        client_assertion_type: z.literal('urn:ietf:params:oauth:client-assertion-type:jwt-bearer'),
        client_assertion: z.string().max(8192),
        resource: z.literal(`${cloud.url}/api`),
        scope: z.literal('instance'),
      }),
    );
    const instance = instances.values().find((entry) => entry.id === form.client_id);
    if (!instance || request.dpop?.jkt !== instance.jkt) {
      return refused();
    }
    const [header, payload, signature] = form.client_assertion.split('.', 3);
    const claims = z
      .strictObject({
        iss: z.literal(instance.id),
        sub: z.literal(instance.id),
        aud: z.literal(`${cloud.url}/id/token`),
        jti: z.string().min(1),
        iat: z.number().int(),
        exp: z.number().int(),
      })
      .parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300 ||
      Math.abs(claims.iat - now) > 60 ||
      assertions.has(claims.jti) ||
      !verify(
        null,
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: instance.key, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      )
    ) {
      return refused();
    }
    assertions.add(claims.jti);
    const token = mintToken(request, `buddy-${instance.side}`, { sub: instance.id, iat: now, exp: now + 600 });
    tokens.set(token, instance);
    return answer({ access_token: token, token_type: 'DPoP', expires_in: 600 });
  });
  on('POST /api/v1/instances', (request) => {
    const link = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const pending = link ? links.get(link) : undefined;
    if (!pending || pending.expires <= Date.now() || instances.has(pending.side)) {
      return refused();
    }
    const { side } = pending;
    const registered = z
      .strictObject({
        instanceId: z.uuid(),
        name: z.string().max(256),
        version: z.string().max(128),
        platform: z.string().max(128),
        jwk: publicKey.extend({ kid: z.string().length(43) }),
        bootId: z.uuid(),
        capabilities: z.array(z.string().min(1).max(32)).max(16),
        permissions,
        dataRegion: z.enum(['eu', 'us', 'ca']).optional(),
      })
      .parse(request.json());
    const pub = publicKey.parse({ kty: registered.jwk.kty, crv: registered.jwk.crv, x: registered.jwk.x });
    const jkt = ed25519Thumbprint(pub);
    if (
      registered.jwk.kid !== jkt ||
      pending.jkt !== jkt ||
      request.dpop?.jkt !== jkt ||
      instances.values().some((entry) => entry.id === registered.instanceId || entry.jkt === jkt)
    ) {
      return refused();
    }
    links.delete(link!);
    instances.set(side, { side, id: registered.instanceId, key: pub, jkt });
    const template = cloudContractFixture('instance/register-response.json');
    return answer({
      ...template,
      instanceId: registered.instanceId,
      oidc: { ...template.oidc, issuer: `${cloud.url}/id`, clientId: registered.instanceId },
      owner: {
        accountId: accounts[side],
        label: `Buddy fixture ${side}`,
        email: `fl310-${side}@example.test`,
        dataRegion: 'eu',
      },
    });
  });
  protectedRoute('POST /api/v1/instance/heartbeat', (request) => {
    heartbeat.parse(request.json());
    return answer({
      commands: [],
      entitlementsChanged: false,
      servicesChanged: false,
      cloneSuspected: false,
      nextHeartbeatSec: 900,
    });
  });
  // The unrelated hourly license task may run. This fixture grants Buddy access only; ordinary plan
  // issuance is explicitly unavailable. Do not invent a plan certificate or weaken its app verifier.
  protectedRoute('POST /api/v1/licenses/refresh', (request, instance) => {
    z.strictObject({ instanceId: z.literal(instance.id), certificates: z.array(z.string().nullable()).max(0) }).parse(
      request.json(),
    );
    return refused();
  });
  protectedRoute('GET /api/v1/discovery', () => answer({ services: {}, cloneSuspected: false }));
  protectedRoute('GET /v1/buddy/pairing', () => answer(pairing));
  protectedRoute('GET /v1/buddy/jwks', () => answer(jwks));
  protectedRoute('POST /v1/buddy/invitations', (request, instance) => {
    const input = BuddyInviteRequest.parse(request.json());
    const other = instance.side === 'a' ? 'b' : 'a';
    if (invitation || pairing || input.instanceId !== instance.id || input.targetAccountId !== accounts[other]) {
      return refused();
    }
    const token = randomBytes(32).toString('base64url');
    invitation = {
      source: instance,
      token,
      target: input.targetAccountId,
      quota: input.quotaBytes,
      expires: Date.now() + 600_000,
      used: false,
    };
    return answer({
      version: 1,
      invitationId: randomUUID(),
      token,
      expiresAt: new Date(invitation.expires).toISOString(),
    });
  });
  protectedRoute('POST /v1/buddy/invitations/accept', (request, instance) => {
    const input = BuddyAcceptRequest.parse(request.json());
    if (
      !invitation ||
      invitation.used ||
      invitation.expires <= Date.now() ||
      input.token !== invitation.token ||
      input.instanceId !== instance.id ||
      accounts[instance.side] !== invitation.target ||
      instance.id === invitation.source.id
    ) {
      return refused();
    }
    invitation.used = true;
    const source = invitation.source;
    const retention = { days: 30, monthly: 12 };
    pairing = BuddyPairing.parse({
      version: 1,
      pairId: randomUUID(),
      state: 'pending',
      readUntil: null,
      vaults: [
        {
          vaultId: randomUUID(),
          sourceInstanceId: source.id,
          destinationInstanceId: instance.id,
          sourceKey: source.key,
          destinationKey: instance.key,
          quotaBytes: input.quotaBytes,
          retention,
        },
        {
          vaultId: randomUUID(),
          sourceInstanceId: instance.id,
          destinationInstanceId: source.id,
          sourceKey: instance.key,
          destinationKey: source.key,
          quotaBytes: invitation.quota,
          retention,
        },
      ],
    });
    protectedRoute(`POST /v1/buddy/pairings/${pairing.pairId}/confirm`, (confirm, confirmer) => {
      BuddyAction.parse(confirm.json());
      if (!pairing?.vaults.some((vault) => vault.sourceInstanceId === confirmer.id)) {
        return refused();
      }
      confirmations.add(confirmer.id);
      if (confirmations.size === 2) {
        pairing = BuddyPairing.parse({ ...pairing, state: 'active' });
      }
      return answer(pairing);
    });
    return answer(pairing);
  });
  protectedRoute('POST /v1/buddy/grants', (request, instance) => {
    const input = BuddyGrantRequest.parse(request.json());
    const vault = pairing?.vaults.find(
      (entry) => entry.vaultId === input.vaultId && entry.sourceInstanceId === instance.id,
    );
    if (!pairing || pairing.state !== 'active' || input.pairId !== pairing.pairId || !vault) {
      return refused();
    }
    const destination = instances.values().find((entry) => entry.id === vault.destinationInstanceId)!;
    const iat = Math.floor(Date.now() / 1000);
    const claims = BuddyGrantClaims.parse({
      version: 1,
      iss: cloud.discovery().api,
      aud: 'frameleaf-buddy',
      sub: instance.id,
      jti: randomUUID(),
      iat,
      exp: iat + 300,
      pairId: pairing.pairId,
      sourceInstanceId: instance.id,
      destinationInstanceId: destination.id,
      vaultId: vault.vaultId,
      scope: input.scope,
      cnf: { jkt: instance.jkt, jwk: instance.key },
      destinationKey: destination.key,
    });
    const data = `${encode({ typ: 'buddy-grant+jwt', alg: 'EdDSA', kid: 'fl310-fixture' })}.${encode(claims)}`;
    const token = `${data}.${sign(null, Buffer.from(data), key.privateKey).toString('base64url')}`;
    grants.add(token);
    return answer(
      BuddyGrantResponse.parse({
        version: 1,
        token,
        claims,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        connections: [
          {
            kind: 'wan',
            protocol: 'https',
            uri: `https://${buddyHost(destination.side)}:${buddyPort(destination.side)}`,
            address: buddyHost(destination.side),
            port: buddyPort(destination.side),
            local: false,
            relay: false,
            ipv6: false,
            custom: false,
            dnsRebindingProtection: true,
            httpsRequired: true,
            verified: true,
          },
        ],
      }),
    );
  });
  protectedRoute('POST /v1/buddy/grants/verify', (request, instance) => {
    const { token } = BuddyVerifyRequest.parse(request.json());
    if (!grants.has(token)) {
      return refused();
    }
    const claims = verifyBuddyGrant(token, jwks, String(cloud.discovery().api));
    if (
      pairing?.state !== 'active' ||
      claims.pairId !== pairing.pairId ||
      claims.destinationInstanceId !== instance.id
    ) {
      return refused();
    }
    return answer({ version: 1, claims });
  });
  protectedRoute('POST /v1/buddy/status', (request, instance) => {
    const report = BuddyStatusReport.parse(request.json());
    const vault = pairing?.vaults.find((entry) => entry.vaultId === report.vaultId);
    if (!pairing || report.pairId !== pairing.pairId || !vault) {
      return refused();
    }
    const previous = reports.get(vault.vaultId) ?? {
      ...report,
      committedBytes: 0,
      reservedBytes: 0,
      lastCompleteAt: null,
      lastVerifiedAt: null,
    };
    reports.set(
      vault.vaultId,
      instance.id === vault.destinationInstanceId
        ? { ...previous, committedBytes: report.committedBytes, reservedBytes: report.reservedBytes }
        : {
            ...previous,
            lastCompleteAt: report.lastCompleteAt,
            lastVerifiedAt: report.lastVerifiedAt,
            state: report.state,
          },
    );
    return answer({ version: 1 });
  });
  protectedRoute('GET /v1/buddy/status', () =>
    answer({ version: 1, pairId: pairing?.pairId, reports: reports.values().toArray() }),
  );

  return { cloud, accounts, instances, errors, pairing: () => pairing };
};
