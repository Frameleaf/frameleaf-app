import { createHash, createPublicKey, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { INSTANCE_KEY_FILE, InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CloudConnectionState, CloudGatewayDeps, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/**
 * A fake Frameleaf Cloud (FL-159): discovery, the token endpoint (which verifies the EdDSA client
 * assertion against the instance's public key, and since FL-178 the DPoP proof by the same key) and
 * the regional processing gateway (which takes only the DPoP-bound token with a proof carrying its
 * `ath`). Fork tests never need the real hosted service.
 */
type FakeCloud = {
  url: string;
  requests: Array<{ method: string; path: string; auth: string | null; dpop: string | null; body: string }>;
  publicJwk?: FrameleafInstanceIdentity['publicJwk'];
  /** The DPoP-bound token the token endpoint minted last. */
  token?: string;
  respond: (request: { method: string; path: string; body: string }) => { status: number; body: unknown } | undefined;
  close: () => Promise<void>;
};

const part = (jws: string, index: number) =>
  JSON.parse(Buffer.from(jws.split('.', 3)[index] ?? '', 'base64url').toString('utf8'));

/** The RFC 7638 thumbprint of the key in a DPoP proof whose signature verifies, or null. */
const proofKey = (proof: string | undefined, htm: string, htu: string, ath?: string) => {
  if (!proof) {
    return null;
  }
  const [header, payload, signature] = proof.split('.', 3);
  const { typ, alg, jwk, kid } = part(proof, 0);
  const claims = part(proof, 1);
  const verified = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signature, 'base64url'),
  );
  if (!verified || typ !== 'dpop+jwt' || alg !== 'EdDSA' || kid !== undefined || jwk.d !== undefined) {
    return null;
  }
  if (claims.htm !== htm || claims.htu !== htu || claims.ath !== ath || typeof claims.jti !== 'string') {
    return null;
  }
  return ed25519Thumbprint(jwk);
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const startFakeCloud = async (): Promise<FakeCloud> => {
  const fake = { requests: [] } as unknown as FakeCloud;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const path = request.url ?? '/';
    fake.requests.push({
      method: request.method ?? 'GET',
      path,
      auth: request.headers.authorization ?? null,
      dpop: (request.headers.dpop as string | undefined) ?? null,
      body,
    });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    const custom = fake.respond?.({ method: request.method ?? 'GET', path, body });
    if (custom) {
      return send(custom.status, custom.body);
    }

    if (path === '/.well-known/frameleaf-services') {
      return send(200, {
        version: 1,
        validFor: 3600,
        issuer: `${fake.url}/id`,
        api: `${fake.url}/api`,
        ml: { eu: `${fake.url}/ml-eu`, na: `${fake.url}/ml-na` },
      });
    }
    if (path === '/id/token' && request.method === 'POST') {
      const form = new URLSearchParams(body);
      const assertion = form.get('client_assertion') ?? '';
      const [header, payload, signature] = assertion.split('.', 3);
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const valid =
        !!fake.publicJwk &&
        verify(
          null,
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: fake.publicJwk, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        );
      const jkt = proofKey(request.headers.dpop as string | undefined, 'POST', `${fake.url}/id/token`);
      if (
        !valid ||
        !jkt ||
        jkt !== part(assertion, 0).kid ||
        claims.iss !== 'instance-1' ||
        claims.sub !== 'instance-1' ||
        claims.aud !== `${fake.url}/id/token` ||
        claims.exp - claims.iat > 300 ||
        form.get('grant_type') !== 'client_credentials' ||
        form.get('resource') !== `${fake.url}/ml-eu`
      ) {
        return send(401, { code: 'invalid-client', message: 'assertion refused' });
      }
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      fake.token = `${encode({ alg: 'EdDSA' })}.${encode({ name: 'ml-token', cnf: { jkt }, frameleaf_kid: jkt })}.c2ln`;
      return send(200, { access_token: fake.token, token_type: 'DPoP', expires_in: 600 });
    }
    if (path.startsWith('/ml-eu/')) {
      const ath = fake.token ? createHash('sha256').update(fake.token).digest('base64url') : undefined;
      const htu = `${fake.url}${path.split('?', 1)[0]}`;
      if (
        path !== '/ml-eu/ping' &&
        (request.headers.authorization !== `DPoP ${fake.token}` ||
          proofKey(request.headers.dpop as string | undefined, request.method ?? 'GET', htu, ath) !==
            part(fake.token!, 1).cnf.jkt)
      ) {
        return send(401, { code: 'invalid-token', message: 'no token' });
      }
      switch (path.split('?', 1)[0]) {
        case '/ml-eu/ping': {
          return send(200, {});
        }
        case '/ml-eu/capabilities': {
          return send(200, {
            protocol: 'frameleaf-cloud-v2',
            region: 'eu',
            workloads: ['enrichment', 'restoration-faithful', 'teleportation'],
            consent: { requiredVersion: '2026-09-25', recordedVersion: '2026-09-25' },
            entitlement: { active: true },
            wallet: { balanceUsd: 12.5, heldUsd: 2.5, dailyCapUsd: 20, spentTodayUsd: 1 },
            limits: { concurrentJobs: 2 },
            catalogEtag: 'etag-1',
          });
        }
        case '/ml-eu/hardware': {
          return send(200, { providers: ['CUDAExecutionProvider'], cudaDeviceCount: 1, preferredAcceleration: 'cuda' });
        }
        case '/ml-eu/v2/catalog': {
          return send(200, {
            etag: 'etag-1',
            models: [
              {
                id: 'describe',
                workload: 'enrichment',
                name: 'Describe',
                fingerprint: 'f1',
                pricing: { unit: 'image', usd: 0.002 },
              },
            ],
          });
        }
        case '/ml-eu/v2/wallet': {
          return send(200, {
            balanceUsd: 12.5,
            heldUsd: 2.5,
            dailyCapUsd: 20,
            spentTodayUsd: 1,
            topUpUrl: 'https://account.cloud.test/wallet',
          });
        }
        case '/ml-eu/v2/consent': {
          const posted = JSON.parse(body);
          return send(200, { recordedVersion: posted.version, features: posted.features });
        }
      }
    }
    return send(404, { code: 'not-found', message: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
};

describe('Frameleaf Cloud client against a fake cloud (FL-159)', () => {
  let cloud: FakeCloud;
  let identityDir: string;
  let metadata: Map<string, unknown>;
  let deps: CloudGatewayDeps;
  let cloudRepository: FrameleafCloudRepository;
  let identity: InstanceIdentityRepository;

  const link = (overrides: Partial<FrameleafCloudLink> = {}): FrameleafCloudLink => ({
    status: 'linked',
    cloudUrl: cloud.url,
    instanceId: 'instance-1',
    dataRegion: 'eu',
    ...overrides,
  });

  beforeEach(async () => {
    cloud = await startFakeCloud();
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
    metadata = new Map();
    cloudRepository = new FrameleafCloudRepository(LoggingRepository.create());
    identity = new InstanceIdentityRepository();
    deps = {
      configRepository: { getEnv: () => ({ frameleafCloud: { url: cloud.url, identityDir } }) } as never,
      databaseRepository: { withLock: (_lock: unknown, callback: () => Promise<unknown>) => callback() } as never,
      systemMetadataRepository: {
        get: (key: string) => Promise.resolve(metadata.get(key) ?? null),
        set: (key: string, value: unknown) => {
          metadata.set(key, value);
          if (key === SystemMetadataKey.FrameleafInstance) {
            cloud.publicJwk = (value as FrameleafInstanceIdentity).publicJwk;
          }
          return Promise.resolve();
        },
      } as never,
      instanceIdentityRepository: identity,
      frameleafCloudRepository: cloudRepository,
    };
  });

  afterEach(async () => {
    await cloud.close();
    await rm(identityDir, { recursive: true, force: true });
  });

  it('contacts nothing while Frameleaf Cloud is not configured or the server is not linked', async () => {
    deps.configRepository = { getEnv: () => ({ frameleafCloud: { url: null, identityDir } }) } as never;
    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
      state: CloudConnectionState.NotConfigured,
      refusal: MlAdmissionRefusal.CloudUnavailable,
    });

    deps.configRepository = { getEnv: () => ({ frameleafCloud: { url: cloud.url, identityDir } }) } as never;
    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({ state: CloudConnectionState.NotLinked });
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link({ status: 'revoked' }));
    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
      state: CloudConnectionState.NotLinked,
      detail: 'The link to Frameleaf Cloud was revoked',
    });
    // A link made against another cloud address does not count.
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link({ cloudUrl: 'https://other.test' }));
    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({ state: CloudConnectionState.NotLinked });

    expect(cloud.requests).toEqual([]);
  });

  it('creates the identity key once (0600, RFC 7638 kid) and mints a token for the regional gateway', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());

    const resolution = await resolveCloudGateway(deps);

    expect(resolution).toMatchObject({
      state: CloudConnectionState.Ready,
      region: 'eu',
      gateway: { url: `${cloud.url}/ml-eu`, token: { accessToken: cloud.token } },
    });
    const stored = metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity;
    // FL-178: the token is bound to the identity key, which signs its calls' proofs
    expect(resolution.state === CloudConnectionState.Ready && resolution.gateway.token.signer.kid).toBe(stored.kid);
    expect(part(cloud.token!, 1).cnf.jkt).toBe(stored.kid);
    expect(stored.kid).toBe(ed25519Thumbprint(stored.publicJwk));
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
    const keyStat = await stat(join(identityDir, INSTANCE_KEY_FILE));
    expect(keyStat.mode & 0o777).toBe(0o600);

    // A second resolution reuses the key and the cached token and discovery.
    const again = await resolveCloudGateway(deps);
    expect(again).toMatchObject({ state: CloudConnectionState.Ready });
    expect((metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity).kid).toBe(stored.kid);
    expect(cloud.requests.filter((request) => request.path === '/id/token')).toHaveLength(1);
    expect(cloud.requests.filter((request) => request.path === '/.well-known/frameleaf-services')).toHaveLength(1);
  });

  it('refuses a discovery document whose token issuer is on another host, and asks it for nothing (FL-159)', async () => {
    cloud.respond = ({ path }) =>
      path === '/.well-known/frameleaf-services'
        ? {
            status: 200,
            body: {
              version: 1,
              validFor: 3600,
              // eslint-disable-next-line unicorn/prefer-https -- the refused address
              issuer: 'http://id.attacker.example/id',
              api: `${cloud.url}/api`,
              ml: { eu: `${cloud.url}/ml-eu` },
            },
          }
        : undefined;
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
    const resolution = await resolveCloudGateway(deps);
    expect(resolution.state).not.toBe(CloudConnectionState.Ready);
    expect('detail' in resolution ? resolution.detail : '').toMatch(
      /issuer http:\/\/id\.attacker\.example\/id is not on/,
    );
    // Nothing else was asked: no signed assertion and no token request left the server.
    expect(cloud.requests.map((request) => request.path)).toEqual(['/.well-known/frameleaf-services']);
  });

  it('refuses a region discovery does not offer, never choosing another one', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link({ dataRegion: 'ca' }));
    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
      state: CloudConnectionState.Unavailable,
      refusal: MlAdmissionRefusal.CloudUnavailable,
    });
    expect(cloud.requests.some((request) => request.path.startsWith('/ml-'))).toBe(false);
  });

  it('reads capabilities, hardware, catalogue, wallet and consent from the gateway', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
    const resolution = await resolveCloudGateway(deps);
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new Error('not ready');
    }
    const ml = new FrameleafCloudMlRepository(cloudRepository);

    await ml.ping(resolution.gateway);
    await expect(ml.getCapabilities(resolution.gateway)).resolves.toMatchObject({
      region: 'eu',
      entitlement: { active: true },
      consent: { requiredVersion: '2026-09-25', features: { identityNames: false } },
      wallet: { balanceUsd: 12.5 },
    });
    await expect(ml.getHardware(resolution.gateway)).resolves.toMatchObject({ cudaDeviceCount: 1 });
    await expect(ml.getCatalog(resolution.gateway)).resolves.toMatchObject({ models: [{ id: 'describe' }] });
    await expect(ml.getWallet(resolution.gateway)).resolves.toMatchObject({
      topUpUrl: 'https://account.cloud.test/wallet',
    });
    await expect(
      ml.recordConsent(resolution.gateway, {
        version: '2026-09-25',
        features: { identityNames: false, medicalSignals: false, ocrAddon: true },
      }),
    ).resolves.toEqual({
      recordedVersion: '2026-09-25',
      features: { identityNames: false, medicalSignals: false, ocrAddon: true },
    });

    const gatewayCalls = cloud.requests.filter(
      (request) => request.path.startsWith('/ml-eu/') && request.path !== '/ml-eu/ping',
    );
    expect(gatewayCalls.length).toBeGreaterThan(0);
    expect(gatewayCalls.every((request) => request.auth === `DPoP ${cloud.token}` && !!request.dpop)).toBe(true);
    // the public ping carries neither a token nor a proof
    const ping = cloud.requests.find((request) => request.path === '/ml-eu/ping')!;
    expect(ping.auth).toBeNull();
    expect(ping.dpop).toBeNull();
  });

  it.each([
    [402, { code: 'insufficient-credits', message: 'empty' }, MlAdmissionRefusal.WalletInsufficient],
    [402, { code: 'daily-cap', message: 'cap' }, MlAdmissionRefusal.BudgetExceeded],
    [403, { code: 'consent-missing', message: 'consent' }, MlAdmissionRefusal.ConsentMissing],
    [403, { code: 'consent-version-outdated', message: 'consent' }, MlAdmissionRefusal.ConsentVersionOutdated],
    [403, { code: 'entitlement-missing', message: 'no plan' }, MlAdmissionRefusal.EntitlementMissing],
    [409, { code: 'model-mismatch', message: 'model' }, MlAdmissionRefusal.ModelMismatch],
    [429, { code: 'rate-limited', message: 'slow down' }, MlAdmissionRefusal.QuotaExceeded],
    [503, { code: 'capacity', message: 'busy' }, MlAdmissionRefusal.CloudUnavailable],
    [401, { code: 'x', message: 'y', refusal: 'entitlement-missing' }, MlAdmissionRefusal.EntitlementMissing],
    // FL-177: the golden envelope (data object, null detail) and the request-invalid refusal
    [402, cloudContractFixture('errors/insufficient-credits.json'), MlAdmissionRefusal.WalletInsufficient],
    [422, { code: 'request-invalid', message: 'bad request' }, MlAdmissionRefusal.RequestInvalid],
    [
      503,
      { code: 'capacity', message: 'busy', refusal: 'destination-unhealthy' },
      MlAdmissionRefusal.DestinationUnhealthy,
    ],
  ])('maps a %s %j error envelope to a refusal', async (status, body, refusal) => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
    const resolution = await resolveCloudGateway(deps);
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new Error('not ready');
    }
    cloud.respond = ({ path }) => (path === '/ml-eu/capabilities' ? { status, body } : undefined);

    const error = await new FrameleafCloudMlRepository(cloudRepository)
      .getCapabilities(resolution.gateway)
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(FrameleafCloudError);
    expect((error as FrameleafCloudError).refusal).toBe(refusal);
    expect((error as FrameleafCloudError).status).toBe(status);
  });

  it('treats a response it does not understand as the cloud being unavailable, never as a grant', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
    const resolution = await resolveCloudGateway(deps);
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new Error('not ready');
    }
    cloud.respond = ({ path }) =>
      path === '/ml-eu/capabilities'
        ? { status: 200, body: { workloads: ['enrichment'], entitlement: true } }
        : undefined;

    await expect(
      new FrameleafCloudMlRepository(cloudRepository).getCapabilities(resolution.gateway),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.CloudUnavailable });
  });

  it('refuses when the cloud does not answer', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
    await cloud.close();

    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
      state: CloudConnectionState.Unavailable,
      refusal: MlAdmissionRefusal.CloudUnavailable,
    });
    cloud = await startFakeCloud();
  });

  it('refuses a token the cloud rejects', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, link({ instanceId: 'someone-else' }));

    await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
      state: CloudConnectionState.Unavailable,
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
    });
  });
});
