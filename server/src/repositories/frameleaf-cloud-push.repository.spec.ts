import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PushPlatform } from 'src/enum.js';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { PushDeliveryMode, PushGatewayMessage, PushTargetKind } from 'src/utils/frameleaf-push.js';
import { FakeCloud, dpopTokenOf, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';

describe(FrameleafCloudPushRepository.name, () => {
  let cloud: FakeCloud;
  let dir: string;
  let cloudRepository: FrameleafCloudRepository;
  let sut: FrameleafCloudPushRepository;

  const message = (overrides: Partial<PushGatewayMessage> = {}): PushGatewayMessage => ({
    id: randomUUID(),
    target: {
      platform: PushPlatform.Ios,
      token: 'apns-token',
      kind: PushTargetKind.Device,
      mode: PushDeliveryMode.Alert,
    },
    blob: 'AQIDBA',
    ...overrides,
  });

  const target = async () => {
    const identity = new InstanceIdentityRepository();
    await identity.loadOrCreate(dir, null);
    const document = await cloudRepository.discovery(cloud.url);
    return sut.target(document, 'instance-1', identity.currentSigner());
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-push-'));
    cloud = await startFakeCloud();
    const discovery = cloud.discovery;
    cloud.discovery = () => ({ ...discovery(), endpoints: { push: `${cloud.url}/push` } });
    cloud.on('POST /id/token', (request) => tokenAnswer(request, 'push-token'));
    cloudRepository = new FrameleafCloudRepository(LoggingRepository.create());
    sut = new FrameleafCloudPushRepository(cloudRepository);
  });

  afterEach(async () => {
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('sends only the targets and opaque blobs to the push gateway, with a DPoP-bound instance token', async () => {
    const messages = [message(), message({ target: { ...message().target, platform: PushPlatform.Android } })];
    cloud.on('POST /push/v1/push/messages', (request) => ({
      status: 202,
      body: { results: request.json().messages.map(({ id }: { id: string }) => ({ id, status: 'accepted' })) },
    }));

    const results = await sut.send(await target(), messages);

    expect(results).toEqual(messages.map(({ id }) => ({ id, status: 'accepted' })));
    const request = cloud.requests.find(({ path }) => path === '/push/v1/push/messages')!;
    expect(request.json()).toEqual({ messages });
    expect(request.headers.authorization).toMatch(/^DPoP /);
    expect(dpopTokenOf(request)).toBeTruthy();
    expect(request.dpop?.claims.htu).toBe(`${cloud.url}/push/v1/push/messages`);
    const token = cloud.requests.find(({ path }) => path === '/id/token')!;
    expect(token.form().get('resource')).toBe(`${cloud.url}/push`);
  });

  it('splits a large delivery into gateway-sized batches', async () => {
    const sizes: number[] = [];
    cloud.on('POST /push/v1/push/messages', (request) => {
      const { messages } = request.json();
      sizes.push(messages.length);
      return { status: 200, body: { results: messages.map(({ id }: { id: string }) => ({ id, status: 'accepted' })) } };
    });

    const results = await sut.send(
      await target(),
      Array.from({ length: 150 }, () => message()),
    );

    expect(sizes).toEqual([100, 50]);
    expect(results).toHaveLength(150);
  });

  it('never sends a message carrying anything but a target and a blob', async () => {
    await expect(
      sut.send(await target(), [{ ...message(), title: 'Holiday photos' } as unknown as PushGatewayMessage]),
    ).rejects.toThrow();
    expect(cloud.requests.filter(({ path }) => path.startsWith('/push'))).toEqual([]);
  });

  it('reports a gateway refusal as a Frameleaf Cloud error', async () => {
    cloud.on('POST /push/v1/push/messages', () => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: { code: 'rate_limited', message: 'slow down', retryable: true },
    }));

    await expect(sut.send(await target(), [message()])).rejects.toBeInstanceOf(FrameleafCloudError);
  });
});
