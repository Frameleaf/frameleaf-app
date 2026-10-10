import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { PushSendRequest } from 'src/utils/frameleaf-push.js';
import { FakeCloud, dpopTokenOf, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

type PublishedPush = {
  request: { method: string; url: string; body: PushSendRequest };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

describe(FrameleafCloudPushRepository.name, () => {
  let cloud: FakeCloud;
  let dir: string;
  let cloudRepository: FrameleafCloudRepository;
  let sut: FrameleafCloudPushRepository;

  const TOKEN = 'a'.repeat(64);
  const request = (overrides: Partial<PushSendRequest> = {}): PushSendRequest => ({
    platform: 'apns',
    token: TOKEN,
    type: 'alert',
    priority: 'high',
    ttlSec: 86_400,
    payload: 'AQIDBA',
    ...overrides,
  });

  const resolve = async (configured: string | null) => {
    const identity = new InstanceIdentityRepository();
    await identity.loadOrCreate(dir, null);
    const document = await cloudRepository.discovery(cloud.url);
    return sut.target(document, 'instance-1', identity.currentSigner(), configured);
  };
  const target = async () => (await resolve(`${cloud.url}/push`))!;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-push-'));
    cloud = await startFakeCloud();
    cloud.on('POST /id/token', (answer) => tokenAnswer(answer, 'push-token'));
    cloudRepository = new FrameleafCloudRepository(LoggingRepository.create());
    sut = new FrameleafCloudPushRepository(cloudRepository);
  });

  afterEach(async () => {
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('routes one push to POST /v1/push/send on the push origin, with a DPoP-bound instance token (FC-92)', async () => {
    cloud.on('POST /push/v1/push/send', () => ({ status: 200, body: { status: 'sent' } }));

    await expect(sut.send(await target(), request())).resolves.toEqual({ status: 'sent' });

    const sent = cloud.requests.find(({ path }) => path === '/push/v1/push/send')!;
    expect(sent.json()).toEqual(request());
    expect(sent.headers.authorization).toMatch(/^DPoP /);
    expect(dpopTokenOf(sent)).toBeTruthy();
    expect(sent.dpop?.claims.htu).toBe(`${cloud.url}/push/v1/push/send`);
    const token = cloud.requests.find(({ path }) => path === '/id/token')!;
    // the ordinary instance token: its audience is the API, only the proof names the push address
    expect(token.form().get('resource')).toBe(`${cloud.url}/api`);
  });

  it('uses the address discovery names when none is configured, and is off without either (FL-293)', async () => {
    await expect(resolve(null)).resolves.toBeNull();
    const discovery = cloud.discovery;
    cloud.discovery = () => ({ ...discovery(), endpoints: { push: `${cloud.url}/push` } });
    cloudRepository = new FrameleafCloudRepository(LoggingRepository.create());
    sut = new FrameleafCloudPushRepository(cloudRepository);
    await expect(resolve(null)).resolves.toMatchObject({ url: `${cloud.url}/push/v1/push/send` });
  });

  it('reads every result the gateway gives', async () => {
    for (const body of [{ status: 'invalid-token' }, { status: 'throttled', retryAfterSec: 60 }, { status: 'retry' }]) {
      cloud.on('POST /push/v1/push/send', () => ({ status: 200, body }));
      await expect(sut.send(await target(), request())).resolves.toEqual(body);
    }
  });

  it('never sends anything the contract does not allow', async () => {
    const refused = [
      { ...request(), title: 'Holiday photos' } as unknown as PushSendRequest,
      // a Live Activity carries a fixed state, never the encrypted payload or text
      request({ type: 'live-activity-update', liveActivity: { state: { step: 'plan-active' } } }),
      request({ type: 'live-activity-update', payload: undefined }),
      request({
        type: 'live-activity-start',
        payload: undefined,
        liveActivity: { state: { step: 'plan-active' } },
      }),
      request({
        platform: 'fcm',
        type: 'live-activity-update',
        payload: undefined,
        liveActivity: { state: { step: 'plan-active' } },
      }),
      request({ payload: undefined }),
      request({ token: 'short' }),
      request({ collapseId: 'has spaces' }),
      request({ payload: 'A'.repeat(3073) }),
    ];
    for (const value of refused) {
      await expect(sut.send(await target(), value)).rejects.toThrow();
    }
    expect(cloud.requests.filter(({ path }) => path.startsWith('/push'))).toEqual([]);
  });

  it('reports a gateway refusal as a Frameleaf Cloud error', async () => {
    cloud.on('POST /push/v1/push/send', () => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: { code: 'rate_limited', message: 'slow down', retryable: true },
    }));

    await expect(sut.send(await target(), request())).rejects.toBeInstanceOf(FrameleafCloudError);
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
  ])('conforms to published Cloud 0.0.3 %s bytes through the actual DPoP client', async (name) => {
    const fixture = cloudContractFixture<PublishedPush>(`push/${name}.json`);
    cloud.on('POST /push/v1/push/send', () => ({
      status: fixture.status,
      headers: fixture.headers,
      body: fixture.body,
    }));
    const sending = sut.send(await target(), fixture.request.body);
    if (fixture.status === 200) {
      await expect(sending).resolves.toEqual(fixture.body);
    } else {
      await expect(sending).rejects.toMatchObject({
        status: fixture.status,
        envelope: errorEnvelopeSchema.parse(fixture.body),
        retryAfterSeconds: Number(fixture.headers['Retry-After']),
      });
    }
    const sent = cloud.requests.find(({ path }) => path === '/push/v1/push/send')!;
    expect(sent.json()).toEqual(fixture.request.body);
    expect(fixture.request.method).toBe('POST');
    expect(new URL(fixture.request.url).pathname).toBe('/v1/push/send');
    expect(sent.headers.authorization).toMatch(/^DPoP /);
    expect(dpopTokenOf(sent)).toBeTruthy();
    expect(sent.dpop?.claims.htm).toBe(fixture.request.method);
    expect(sent.dpop?.claims.htu).toBe(`${cloud.url}/push${new URL(fixture.request.url).pathname}`);
    const token = cloud.requests.find(({ path }) => path === '/id/token')!;
    expect(token.form().get('resource')).toBe(`${cloud.url}/api`);
  });

  it('rejects the published invalid push before admitting an HTTP send', async () => {
    const fixture = cloudContractFixture<PublishedPush>('push/error-request-invalid.json');
    const resolved = await target();
    const before = cloud.requests.length;
    await expect(sut.send(resolved, fixture.request.body)).rejects.toThrow();
    expect(cloud.requests).toHaveLength(before);
    expect(cloud.requests.filter(({ path }) => path.startsWith('/push'))).toEqual([]);
  });
});
