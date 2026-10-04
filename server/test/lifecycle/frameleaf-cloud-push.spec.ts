import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigRepository, clearEnvCache } from 'src/repositories/config.repository.js';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FrameleafCloudError,
  FrameleafDiscoveryDocument,
  discoveryProblem,
  discoverySchema,
  errorEnvelopeSchema,
} from 'src/utils/frameleaf-cloud.js';
import { PushSendRequest, pushGatewayUrl } from 'src/utils/frameleaf-push.js';
import { FakeCloud, dpopTokenOf, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import { loadLifecycleTestingApi } from 'test/fixtures/frameleaf-cloud-lifecycle-adapter.js';

type PublishedPush = {
  request: { method: string; url: string; body: PushSendRequest };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};
type PublishedDiscovery = FrameleafDiscoveryDocument & { jwks: Record<string, string> };

const discoveryFixtures = ['instance/discovery.json', 'instance/discovery-instance.json'] as const;

describe('FC98 immutable package push/discovery consumer qualification', () => {
  let api: Awaited<ReturnType<typeof loadLifecycleTestingApi>>;
  let cloud: FakeCloud;
  let gateway: FakeCloud;
  let directory: string;
  let identity: InstanceIdentityRepository;
  let repository: FrameleafCloudRepository;
  let sut: FrameleafCloudPushRepository;

  beforeAll(async () => {
    api = await loadLifecycleTestingApi();
  });

  const publishedPush = (name: string) => api.fixture(`push/${name}.json`) as PublishedPush;

  beforeEach(async () => {
    vi.stubEnv('FRAMELEAF_PUSH_URL', undefined);
    clearEnvCache();
    directory = await mkdtemp(join(tmpdir(), 'fc98-push-'));
    identity = new InstanceIdentityRepository();
    await identity.loadOrCreate(directory, null);
    cloud = await startFakeCloud();
    gateway = await startFakeCloud({ tokens: cloud.tokens });
    cloud.on('POST /id/token', (request) => tokenAnswer(request, 'fc98-push-token'));
    repository = new FrameleafCloudRepository(LoggingRepository.create());
    sut = new FrameleafCloudPushRepository(repository);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearEnvCache();
    await gateway?.close();
    await cloud?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  // Only fixture addresses are relocated; all other published fields are retained.
  const serveDiscovery = (name: string, push = true) => {
    const document = api.fixture(name) as PublishedDiscovery;
    const relocate = (address: string) => {
      const url = new URL(address);
      const origins: Record<string, string> = {
        'https://id.frameleaf.cloud': `${cloud.url}/id`,
        'https://api.frameleaf.cloud': `${cloud.url}/api`,
        'https://push.frameleaf.cloud': `${cloud.url}/push`,
        'https://ml.eu.frameleaf.cloud': `${cloud.url}/ml-eu`,
        'https://ml.na.frameleaf.cloud': `${cloud.url}/ml-na`,
      };
      const origin = origins[url.origin];
      return origin ? `${origin}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}` : address;
    };
    const endpoints = Object.fromEntries(
      Object.entries(document.endpoints ?? {}).map(([key, address]) => [key, relocate(address)]),
    );
    if (!push) delete endpoints.push;
    const relocated = {
      ...document,
      issuer: relocate(document.issuer),
      api: relocate(document.api),
      ml: Object.fromEntries(Object.entries(document.ml).map(([region, address]) => [region, relocate(address)])),
      jwks: Object.fromEntries(Object.entries(document.jwks).map(([key, address]) => [key, relocate(address)])),
      endpoints,
    };
    cloud.discovery = () => relocated;
  };

  const target = async () => {
    const document = await repository.discovery(cloud.url);
    return sut.target(
      document,
      'instance-fc98',
      identity.currentSigner(),
      new ConfigRepository().getEnv().frameleafCloud.pushUrl,
    );
  };

  it.each(discoveryFixtures)('parses the unmodified published %s push address', (name) => {
    const document = discoverySchema.parse(api.fixture(name));
    expect(discoveryProblem('https://api.frameleaf.cloud', document)).toBeNull();
    expect(document.endpoints?.push).toBe('https://push.frameleaf.cloud');
    expect(pushGatewayUrl(document, null)).toBe('https://push.frameleaf.cloud/v1/push/send');
  });

  it.each(discoveryFixtures)('uses %s discovery fallback over real HTTP on the named push path', async (name) => {
    serveDiscovery(name);
    const exchange = publishedPush('send-alert');
    cloud.on('POST /push/v1/push/send', () => exchange);
    const resolved = (await target())!;
    expect(resolved.url).toBe(`${cloud.url}/push/v1/push/send`);
    await expect(sut.send(resolved, exchange.request.body)).resolves.toEqual(exchange.body);
    expect(cloud.requests.map(({ path }) => path)).toEqual([
      '/.well-known/frameleaf-services',
      '/id/token',
      '/push/v1/push/send',
    ]);
    expect(cloud.requests[2].dpop?.claims.htu).toBe(resolved.url);
    expect(gateway.requests).toHaveLength(0);
  });

  it('FRAMELEAF_PUSH_URL overrides the discovered address and strips trailing slashes', async () => {
    serveDiscovery(discoveryFixtures[0]);
    vi.stubEnv('FRAMELEAF_PUSH_URL', `${gateway.url}/override///`);
    clearEnvCache();
    const exchange = publishedPush('send-background');
    gateway.on('POST /override/v1/push/send', () => exchange);
    const resolved = (await target())!;
    expect(resolved.url).toBe(`${gateway.url}/override/v1/push/send`);
    await expect(sut.send(resolved, exchange.request.body)).resolves.toEqual(exchange.body);
    expect(gateway.requests.map(({ path }) => path)).toEqual(['/override/v1/push/send']);
    expect(gateway.requests[0].dpop?.claims.htu).toBe(resolved.url);
  });

  it('uses FRAMELEAF_PUSH_URL even when discovery has no push address', async () => {
    serveDiscovery(discoveryFixtures[0], false);
    vi.stubEnv('FRAMELEAF_PUSH_URL', `${gateway.url}/`);
    clearEnvCache();
    expect((await target())?.url).toBe(`${gateway.url}/v1/push/send`);
  });

  it('disables push without either address and makes no token or API-host push request', async () => {
    serveDiscovery(discoveryFixtures[0], false);
    await expect(target()).resolves.toBeNull();
    expect(cloud.requests.map(({ path }) => path)).toEqual(['/.well-known/frameleaf-services']);
    expect(gateway.requests).toHaveLength(0);
  });

  it.each([
    'send-alert',
    'send-background',
    'send-invalid-token',
    'send-live-activity-start',
    'send-live-activity-update',
    'send-live-activity-end',
    'send-retry',
    'send-throttled',
    'error-push-unavailable',
    'error-rate-limited',
  ])('handles immutable published %s through the actual signed request', async (name) => {
    serveDiscovery(discoveryFixtures[0]);
    vi.stubEnv('FRAMELEAF_PUSH_URL', gateway.url);
    const exchange = publishedPush(name);
    gateway.on('POST /v1/push/send', () => exchange);
    const resolved = (await target())!;
    const sending = sut.send(resolved, exchange.request.body);
    if (exchange.status === 200) {
      await expect(sending).resolves.toEqual(exchange.body);
    } else {
      await expect(sending).rejects.toBeInstanceOf(FrameleafCloudError);
      await expect(sending).rejects.toMatchObject({
        status: exchange.status,
        envelope: errorEnvelopeSchema.parse(exchange.body),
        retryAfterSeconds: Number(exchange.headers['Retry-After']),
      });
    }
    expect(exchange.request.method).toBe('POST');
    expect(new URL(exchange.request.url).pathname).toBe('/v1/push/send');
    expect(gateway.requests).toHaveLength(1);
    const sent = gateway.requests[0];
    expect(sent.json()).toEqual(exchange.request.body);
    expect(sent.headers['content-type']).toMatch(/^application\/json/);
    expect(sent.headers.authorization).toMatch(/^DPoP /);
    expect(dpopTokenOf(sent)).toBeTruthy();
    expect(sent.dpop?.claims.htm).toBe(exchange.request.method);
    expect(sent.dpop?.claims.htu).toBe(resolved.url);
    expect(sent.dpop?.claims.ath).toBeTruthy();
    expect(
      cloud.requests
        .find(({ path }) => path === '/id/token')!
        .form()
        .get('resource'),
    ).toBe(`${cloud.url}/api`);
    expect(gateway.refusals).toHaveLength(0);
  });

  it('rejects the published invalid request before any push HTTP exchange', async () => {
    serveDiscovery(discoveryFixtures[0]);
    const resolved = (await target())!;
    const before = cloud.requests.length;
    await expect(sut.send(resolved, publishedPush('error-request-invalid').request.body)).rejects.toThrow();
    expect(cloud.requests).toHaveLength(before);
    expect(gateway.requests).toHaveLength(0);
  });

  it.each([
    ['unknown-result', 200, { status: 'computed-success' }],
    ['invalid-retry-delay', 200, { status: 'throttled', retryAfterSec: -1 }],
    ['invalid-error-envelope', 503, { status: 'sent' }],
  ] as const)('refuses malformed wire control %s', async (_name, status, body) => {
    serveDiscovery(discoveryFixtures[0]);
    vi.stubEnv('FRAMELEAF_PUSH_URL', gateway.url);
    gateway.on('POST /v1/push/send', () => ({ status, body }));
    await expect(sut.send((await target())!, publishedPush('send-alert').request.body)).rejects.toBeInstanceOf(
      FrameleafCloudError,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].dpop).not.toBeNull();
  });

  it('re-signs a nonce-challenged push with a fresh proof before accepting the published sent answer', async () => {
    serveDiscovery(discoveryFixtures[0]);
    vi.stubEnv('FRAMELEAF_PUSH_URL', gateway.url);
    const exchange = publishedPush('send-alert');
    gateway.nonce = 'fc98-fixture-nonce';
    gateway.on('POST /v1/push/send', () => exchange);
    const resolved = (await target())!;
    await expect(sut.send(resolved, exchange.request.body)).resolves.toEqual(exchange.body);
    expect(gateway.refusals).toEqual([{ path: '/v1/push/send', status: 401, code: 'use_dpop_nonce' }]);
    expect(gateway.requests).toHaveLength(2);
    const [challenged, retried] = gateway.requests;
    expect(retried.json()).toEqual(exchange.request.body);
    expect(retried.dpop?.claims.nonce).toBe(gateway.nonce);
    expect(retried.dpop?.claims.htu).toBe(resolved.url);
    expect(retried.headers.dpop).not.toBe(challenged.headers.dpop);
  });
});
