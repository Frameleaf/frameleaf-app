import { createHash, createPublicKey, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { INSTANCE_KEY_FILE, InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CLONE_SUSPECTED_NOTICE,
  CloudConnectionState,
  CloudMlGatewayDeps,
  ML_CLONE_SUSPENDED_DETAIL,
  resolveCloudGateway,
} from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CloudEstimateRequest,
  CloudJobCreateRequest,
  FrameleafCloudError,
  ed25519Thumbprint,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/**
 * A fake Frameleaf Cloud (FL-159): discovery, the token endpoint (which verifies the EdDSA client
 * assertion against the instance's public key, and since FL-178 the DPoP proof by the same key) and
 * the regional processing gateway (which takes only the DPoP-bound token with a proof carrying its
 * `ath`). Fork tests never need the real hosted service.
 */
type FakeCloud = {
  url: string;
  requests: Array<{
    method: string;
    path: string;
    auth: string | null;
    dpop: string | null;
    idempotencyKey: string | null;
    body: string;
  }>;
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
      idempotencyKey: (request.headers['idempotency-key'] as string | undefined) ?? null,
      body,
    });
    const send = (status: number, payload: unknown) => {
      if (status === 204) {
        response.writeHead(204);
        return response.end();
      }
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
      // FL-183: the gateway answers with the cloud's own FC-34 golden fixtures
      const admitted = cloudContractFixture<{ jobId: string }>('ml/job-admitted.json');
      const route = `${request.method} ${path.split('?', 1)[0]}`;
      switch (route) {
        case 'GET /ml-eu/ping': {
          return send(200, { ok: true });
        }
        case 'GET /ml-eu/capabilities': {
          return send(200, cloudContractFixture('ml/capabilities.json'));
        }
        case 'GET /ml-eu/hardware': {
          return send(200, cloudContractFixture('ml/hardware.json'));
        }
        case 'GET /ml-eu/v2/catalog': {
          return send(200, cloudContractFixture('ml/catalog.json'));
        }
        case 'GET /ml-eu/v2/wallet': {
          return send(200, cloudContractFixture('ml/wallet.json'));
        }
        case 'GET /ml-eu/v2/usage': {
          return send(200, cloudContractFixture('ml/usage.json'));
        }
        case 'GET /ml-eu/v2/consent/current': {
          return send(200, cloudContractFixture('ml/consent-current.json'));
        }
        case 'POST /ml-eu/v2/consent': {
          const posted = JSON.parse(body);
          return send(200, {
            ...cloudContractFixture('ml/consent-recorded.json'),
            recordedVersion: posted.version,
            features: posted.features,
          });
        }
        case 'POST /ml-eu/v2/estimates': {
          return send(200, cloudContractFixture('ml/estimate-response.json'));
        }
        case 'POST /ml-eu/v2/jobs': {
          return send(201, admitted);
        }
        case `GET /ml-eu/v2/jobs/${admitted.jobId}`: {
          return send(200, { ...admitted, run: null });
        }
        case `POST /ml-eu/v2/jobs/${admitted.jobId}/cancel`: {
          return send(200, {});
        }
        case `DELETE /ml-eu/v2/jobs/${admitted.jobId}`: {
          return send(204, null);
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
  let deps: CloudMlGatewayDeps;
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
        delete: (key: string) => {
          metadata.delete(key);
          return Promise.resolve();
        },
      } as never,
      instanceIdentityRepository: identity,
      frameleafCloudRepository: cloudRepository,
      eventRepository: { emit: () => Promise.resolve() },
      logger: LoggingRepository.create(),
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
      entitlement: { active: true, state: 'active', graceUntil: null },
      consent: { requiredVersion: '2026-09-26.1', features: { identityNames: false } },
      wallet: { balanceUsd: 10 },
    });
    await expect(ml.getHardware(resolution.gateway)).resolves.toMatchObject({ cudaDeviceCount: 1 });
    await expect(ml.getCatalog(resolution.gateway)).resolves.toMatchObject({
      refused: 0,
      models: [{ sku: 'ms_K6WT70CS' }, { sku: 'ms_M7QG26PT' }, { sku: 'ms_54S55W7C' }],
    });
    await expect(ml.getWallet(resolution.gateway)).resolves.toMatchObject({
      settingsUrl: 'https://account.frameleaf.cloud/wallet',
    });
    await expect(ml.getUsage(resolution.gateway, new Date('2026-09-01T00:00:00.000Z'))).resolves.toMatchObject({
      items: [{ jobId: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f', modelSku: 'ms_K6WT70CS' }],
    });
    await expect(ml.getConsent(resolution.gateway)).resolves.toMatchObject({
      requiredVersion: '2026-09-26.1',
      recordedVersion: null,
    });
    const consent = cloudContractFixture<{
      version: string;
      features: { identityNames: boolean; medicalSignals: boolean; ocrAddon: boolean };
    }>('ml/consent-record-request.json');
    await expect(ml.recordConsent(resolution.gateway, consent)).resolves.toEqual({
      recordedVersion: '2026-09-26.1',
      recordedAt: '2026-09-26T04:00:00.000Z',
      features: { identityNames: false, medicalSignals: false, ocrAddon: false },
    });
    expect(JSON.parse(cloud.requests.find((request) => request.path === '/ml-eu/v2/consent')!.body)).toEqual(consent);

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
    // FL-183 (FC-34): capacity refuses this destination, never moving the job to another one
    [503, { code: 'capacity', message: 'busy' }, MlAdmissionRefusal.DestinationUnhealthy],
    [503, { code: 'maintenance', message: 'down' }, MlAdmissionRefusal.CloudUnavailable],
    [503, cloudContractFixture('errors/capacity.json'), MlAdmissionRefusal.DestinationUnhealthy],
    [403, cloudContractFixture('errors/region-mismatch.json'), MlAdmissionRefusal.DestinationUnhealthy],
    [403, cloudContractFixture('errors/consent-version-outdated.json'), MlAdmissionRefusal.ConsentVersionOutdated],
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

  describe('estimates and jobs (FL-183, FC-34)', () => {
    const ready = async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link());
      const resolution = await resolveCloudGateway(deps);
      if (resolution.state !== CloudConnectionState.Ready) {
        throw new Error('not ready');
      }
      return { gateway: resolution.gateway, ml: new FrameleafCloudMlRepository(cloudRepository) };
    };
    const gatewayRequests = (method: string, path: string) =>
      cloud.requests.filter((request) => request.method === method && request.path === `/ml-eu${path}`);
    const estimateRequest = () => cloudContractFixture<CloudEstimateRequest>('ml/estimate-request.json');
    const jobRequest = () => cloudContractFixture<CloudJobCreateRequest>('ml/job-request.json');
    const jobId = '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f';

    it('estimates, admits with the sealed estimate and an idempotency key, then reads, cancels and acknowledges the job', async () => {
      const { gateway, ml } = await ready();

      const estimate = await ml.createEstimate(gateway, estimateRequest());
      expect(estimate).toMatchObject({ modelSku: 'ms_K6WT70CS', modelRev: 'mr_B2H147RBJBQ0', basis: 'measured' });
      expect(JSON.parse(gatewayRequests('POST', '/v2/estimates')[0].body)).toEqual(estimateRequest());

      const admitted = await ml.createJob(gateway, jobRequest(), 'batch-0192f1b0-1');
      expect(admitted).toMatchObject({ jobId, status: 'admitted', hold: { amountUsd: 0.203_251 } });
      const [posted] = gatewayRequests('POST', '/v2/jobs');
      expect(posted.idempotencyKey).toBe('batch-0192f1b0-1');
      expect(JSON.parse(posted.body)).toEqual(jobRequest());
      expect(JSON.parse(posted.body).estimate).toBe(estimate.estimate);

      await expect(ml.getJob(gateway, jobId)).resolves.toMatchObject({ jobId, status: 'admitted', run: null });
      await ml.cancelJob(gateway, jobId);
      await ml.deleteJob(gateway, jobId);
      expect(gatewayRequests('POST', `/v2/jobs/${jobId}/cancel`)).toHaveLength(1);
      expect(gatewayRequests('DELETE', `/v2/jobs/${jobId}`)).toHaveLength(1);
      const calls = cloud.requests.filter((request) => request.path.startsWith('/ml-eu/v2/'));
      expect(calls.every((request) => request.auth === `DPoP ${cloud.token}` && !!request.dpop)).toBe(true);
    });

    it.each([
      'estimate-display-as-input.json',
      'estimate-gpu-class.json',
      'estimate-model-id.json',
      'estimate-name-as-sku.json',
      'estimate-unknown-request-key.json',
    ])('never sends the rejected %s estimate request', async (name) => {
      const { gateway, ml } = await ready();
      await expect(
        ml.createEstimate(gateway, cloudContractFixture<CloudEstimateRequest>(`ml/rejected/${name}`)),
      ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.RequestInvalid, status: null });
      expect(gatewayRequests('POST', '/v2/estimates')).toEqual([]);
    });

    it.each(['job-model-fingerprint.json', 'job-model-id.json'])('never sends the rejected %s job', async (name) => {
      const { gateway, ml } = await ready();
      await expect(
        ml.createJob(gateway, cloudContractFixture<CloudJobCreateRequest>(`ml/rejected/${name}`), 'batch-key-0001'),
      ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.RequestInvalid });
      expect(gatewayRequests('POST', '/v2/jobs')).toEqual([]);
    });

    it('never sends a job without a usable idempotency key, or calls a job path with anything but a job id', async () => {
      const { gateway, ml } = await ready();
      await expect(ml.createJob(gateway, jobRequest(), 'short')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.RequestInvalid,
      });
      await expect(ml.getJob(gateway, '../wallet')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.RequestInvalid,
      });
      await expect(ml.cancelJob(gateway, 'job-1')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.RequestInvalid,
      });
      expect(cloud.requests.filter((request) => request.path.startsWith('/ml-eu/v2/jobs'))).toEqual([]);
    });

    it('refuses the job on 503 capacity as this destination being unhealthy, and on a spent estimate as a model mismatch', async () => {
      const { gateway, ml } = await ready();
      cloud.respond = ({ path }) =>
        path === '/ml-eu/v2/jobs' ? { status: 503, body: cloudContractFixture('errors/capacity.json') } : undefined;
      await expect(ml.createJob(gateway, jobRequest(), 'batch-key-0002')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.DestinationUnhealthy,
        status: 503,
      });

      cloud.respond = ({ path }) =>
        path === '/ml-eu/v2/jobs'
          ? { status: 409, body: cloudContractFixture('errors/estimate-used.json') }
          : undefined;
      await expect(ml.createJob(gateway, jobRequest(), 'batch-key-0003')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.ModelMismatch,
        envelope: { code: 'estimate-mismatch', detail: 'used' },
      });
    });

    it('refuses an admission for another model revision than the one sent', async () => {
      const { gateway, ml } = await ready();
      cloud.respond = ({ path }) =>
        path === '/ml-eu/v2/jobs'
          ? { status: 201, body: { ...cloudContractFixture('ml/job-admitted.json'), modelRev: 'mr_0WNPDD697MT0' } }
          : undefined;
      await expect(ml.createJob(gateway, jobRequest(), 'batch-key-0004')).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.ModelMismatch,
      });
    });

    it('treats a leaking answer as not understood: a catalogue entry or usage item is left out, a job run refused', async () => {
      const { gateway, ml } = await ready();
      const catalog = cloudContractFixture<{ etag: string; models: unknown[] }>('ml/catalog.json');
      cloud.respond = ({ path }) => {
        switch (path.split('?', 1)[0]) {
          case '/ml-eu/v2/catalog': {
            const leak = cloudContractFixture('ml/rejected/catalog-entry-model-id.json');
            return { status: 200, body: { ...catalog, models: [...catalog.models, leak] } };
          }
          case '/ml-eu/v2/usage': {
            return { status: 200, body: cloudContractFixture('ml/rejected/usage-model-id.json') };
          }
          case `/ml-eu/v2/jobs/${jobId}`: {
            const run = cloudContractFixture('ml/rejected/job-run-worker-details.json');
            return { status: 200, body: { ...cloudContractFixture('ml/job-admitted.json'), status: 'running', run } };
          }
          default: {
            return undefined;
          }
        }
      };
      const parsed = await ml.getCatalog(gateway);
      expect(parsed.refused).toBe(1);
      expect(parsed.models.map((model) => model.sku)).toEqual(['ms_K6WT70CS', 'ms_M7QG26PT', 'ms_54S55W7C']);
      // FL-183 (P2-1): the refused item is left out and counted; the rest of the report still counts
      await expect(ml.getUsage(gateway, new Date())).resolves.toEqual({ items: [], refused: 1 });
      await expect(ml.getJob(gateway, jobId)).rejects.toMatchObject({ refusal: MlAdmissionRefusal.CloudUnavailable });
    });

    it('suspends cloud processing when the gateway itself answers 403 clone_suspected, as the token path does (FL-185)', async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      deps.eventRepository = { emit };
      const { gateway, ml } = await ready();
      cloud.respond = ({ path }) =>
        path === '/ml-eu/capabilities' || path === '/ml-eu/v2/wallet'
          ? {
              status: 403,
              body: {
                code: 'clone_suspected',
                message: 'This server may be a copy.',
                retryable: false,
                refusal: 'destination-unhealthy',
                requestId: 'req_01J8ZK3M4N5P6Q7Z',
              },
            }
          : undefined;

      await expect(ml.getCapabilities(gateway)).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.CloudUnavailable,
        status: 403,
        message: ML_CLONE_SUSPENDED_DETAIL,
      });
      expect(metadata.get(SystemMetadataKey.FrameleafMlSuspension)).toMatchObject({
        reason: 'clone-suspected',
        cloudUrl: cloud.url,
        instanceId: 'instance-1',
      });
      expect(emit).toHaveBeenCalledWith('AdminNotify', expect.objectContaining({ ...CLONE_SUSPECTED_NOTICE }));
      await expect(ml.getWallet(gateway)).rejects.toMatchObject({ message: ML_CLONE_SUSPENDED_DETAIL });
      // one dedupe key: a repeat is the same notice, which the notification path keeps from repeating
      expect(emit.mock.calls.every(([, notice]) => notice.dedupeKey === CLONE_SUSPECTED_NOTICE.dedupeKey)).toBe(true);

      // and the next resolution asks for no ML token at all while the suspension stands
      const tokenRequests = cloud.requests.filter((request) => request.path === '/id/token').length;
      await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
        state: CloudConnectionState.Unavailable,
        refusal: MlAdmissionRefusal.CloudUnavailable,
        detail: ML_CLONE_SUSPENDED_DETAIL,
      });
      expect(cloud.requests.filter((request) => request.path === '/id/token')).toHaveLength(tokenRequests);
    });

    it('keeps the region-mismatch and capacity refusals as they are, recording no suspension', async () => {
      const { gateway, ml } = await ready();
      cloud.respond = ({ path }) =>
        path === '/ml-eu/capabilities'
          ? { status: 403, body: cloudContractFixture('errors/region-mismatch.json') }
          : undefined;
      await expect(ml.getCapabilities(gateway)).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.DestinationUnhealthy,
      });
      expect(metadata.has(SystemMetadataKey.FrameleafMlSuspension)).toBe(false);
    });

    it('never sends consent with the reserved text-recognition add-on on, and maps an outdated version', async () => {
      const { gateway, ml } = await ready();
      await expect(
        ml.recordConsent(gateway, {
          version: '2026-09-26.1',
          features: { identityNames: false, medicalSignals: false, ocrAddon: true },
        }),
      ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.RequestInvalid });
      expect(gatewayRequests('POST', '/v2/consent')).toEqual([]);

      cloud.respond = ({ path }) =>
        path === '/ml-eu/v2/consent'
          ? { status: 403, body: cloudContractFixture('errors/consent-version-outdated.json') }
          : undefined;
      await expect(
        ml.recordConsent(gateway, {
          version: '2026-01-15.1',
          features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        }),
      ).rejects.toMatchObject({
        refusal: MlAdmissionRefusal.ConsentVersionOutdated,
        envelope: { data: { requiredVersion: '2026-09-26.1' } },
      });
    });
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
