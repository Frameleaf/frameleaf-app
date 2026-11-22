import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { KeyObject, createECDH, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { PushDeviceWithActivities } from 'src/repositories/push-device.repository.js';
import {
  JobName,
  JobStatus,
  MlAdmissionRefusal,
  PushEventType,
  PushPlatform,
  PushUnavailableReason,
  SystemMetadataKey,
  UserMetadataKey,
} from 'src/enum.js';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UnifiedPushRepository } from 'src/repositories/unified-push.repository.js';
import { PushService } from 'src/services/push.service.js';
import { getConfig } from 'src/utils/config.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { PushNotice, PushSendRequest, PushSendResult, PushTargetKind, collapseIdOf } from 'src/utils/frameleaf-push.js';
import { NOTIFICATION_CATALOGS, type NotificationCatalogs } from 'src/utils/notification-locale.js';
import { tryPromise } from 'src/utils/promise.js';
import { openPushEnvelope } from 'src/utils/push-crypto.js';
import { FakeCloud, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import localeFixtures from 'test/fixtures/system-notification-locale.json' with { type: 'json' };
import { factory } from 'test/small.factory.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn(),
}));

type DeviceKey = { publicKey: string; privateKey: KeyObject };

const newDeviceKey = (): DeviceKey => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey };
};

const device = (key: DeviceKey, overrides: Partial<PushDeviceWithActivities> = {}): PushDeviceWithActivities => ({
  id: randomUUID(),
  userId: randomUUID(),
  sessionId: randomUUID(),
  platform: PushPlatform.Ios,
  pushToken: `apns-${randomUUID()}`,
  pushToStartToken: null,
  apnsEnvironment: null,
  publicKey: key.publicKey,
  backupDeviceKey: null,
  disabledEvents: [],
  unifiedPushEndpoint: null,
  unifiedPushPublicKey: null,
  unifiedPushAuth: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  lastDeliveredAt: null,
  lastStaleWakeAt: null,
  activities: [],
  ...overrides,
});

const CLOUD_URL = 'https://cloud.frameleaf.test';
const APNS_TOKEN = 'f'.repeat(64);

const newHarness = (
  options: {
    linked?: boolean;
    cloudUrl?: string | null;
    cloneSuspected?: boolean;
    unifiedPush?: { allowLocalTargets?: boolean; availability?: string };
    cloudPushRequiresPlan?: boolean;
    /** FL-926: the real UnifiedPush client (its address checks), instead of a mock. */
    realUnifiedPush?: boolean;
  } = {},
) => {
  const cloudUrl = options.cloudUrl === undefined ? CLOUD_URL : options.cloudUrl;
  const metadata = new Map<string, unknown>();
  if (options.linked ?? true) {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      instanceId: 'instance-1',
      cloudUrl,
      ...(options.cloneSuspected && { heartbeat: { cloneSuspected: true } }),
    });
  }
  const devices = {
    upsert: vi.fn(),
    update: vi.fn(),
    getBySession: vi.fn(),
    getByUser: vi.fn().mockResolvedValue([]),
    getDeliveryTargets: vi.fn().mockResolvedValue([]),
    deleteBySession: vi.fn().mockResolvedValue(true),
    deleteForUser: vi.fn().mockResolvedValue(true),
    deleteAllForUser: vi.fn().mockResolvedValue(0),
    deleteByIds: vi.fn(),
    clearPushToStartTokens: vi.fn(),
    setActivity: vi.fn(),
    deleteActivity: vi.fn().mockResolvedValue(true),
    deleteActivitiesByIds: vi.fn(),
    markDelivered: vi.fn(),
    getPreviewSafeAssetIds: vi.fn().mockResolvedValue(new Set()),
    getStaleBackupWakeTargets: vi.fn().mockResolvedValue([]),
    markStaleWake: vi.fn(),
    getById: vi.fn(),
    hasUnifiedPushDevices: vi.fn().mockResolvedValue(false),
    deleteGoneUnifiedPush: vi.fn(),
  };
  const unifiedPush = {
    checkEndpoint: vi.fn(),
    send: vi.fn().mockResolvedValue({ status: 'sent' }),
  };
  vi.mocked(getConfig).mockResolvedValue({
    notifications: {
      unifiedPush: { allowLocalTargets: false, availability: 'all', ...options.unifiedPush },
    },
  } as never);
  const sent: PushSendRequest[] = [];
  const gateway = {
    target: vi.fn().mockResolvedValue({ url: `${CLOUD_URL}/v1/push/send`, token: { accessToken: 't' } }),
    send: vi.fn((_target: unknown, request: PushSendRequest): Promise<PushSendResult> => {
      sent.push(request);
      return Promise.resolve({ status: 'sent' });
    }),
  };
  const jobs = { queue: vi.fn() };
  const users = { getAdmins: vi.fn().mockResolvedValue([]), getMetadata: vi.fn().mockResolvedValue([]) };
  const albums = { getById: vi.fn() };
  const cloud = { discovery: vi.fn().mockResolvedValue({ api: `${CLOUD_URL}/api` }) };
  const identity = {
    loadOrCreate: vi.fn().mockResolvedValue({ kid: 'kid', instanceId: 'instance-1' }),
    currentSigner: vi.fn().mockReturnValue({ kid: 'kid' }),
  };
  const sut = new PushService(
    LoggingRepository.create(),
    {
      getEnv: () => ({
        frameleafCloud: {
          url: cloudUrl,
          identityDir: '/tmp/identity',
          pushRequiresPlan: options.cloudPushRequiresPlan,
        },
      }),
    } as never,
    {
      get: vi.fn((key: string) => Promise.resolve(metadata.get(key) ?? null)),
      set: vi.fn((key: string, value: unknown) => {
        metadata.set(key, value);
        return Promise.resolve();
      }),
    } as never,
    { withLock: (_lock: unknown, fn: () => unknown) => fn() } as never,
    identity as never,
    cloud as never,
    devices as never,
    gateway as never,
    jobs as never,
    users as never,
    albums as never,
    options.realUnifiedPush ? new UnifiedPushRepository() : (unifiedPush as never),
  );
  return { sut, devices, gateway, sent, jobs, users, albums, unifiedPush, metadata };
};

const decrypt = (request: PushSendRequest, key: DeviceKey) =>
  JSON.parse(openPushEnvelope(key.privateKey, key.publicKey, request.payload!).toString('utf8'));

const notice = (overrides: Partial<PushNotice> = {}): PushNotice => ({
  type: PushEventType.SharedActivity,
  userIds: ['user-1'],
  title: 'Trip',
  body: 'New items in Trip',
  ...overrides,
});

describe(PushService.name, () => {
  it('renders per device before encryption and re-reads a changed preference for gateway retries (FL-329)', async () => {
    const { sut, devices, users, gateway, jobs, sent } = newHarness();
    const [firstKey, secondKey] = [newDeviceKey(), newDeviceKey()];
    const first = device(firstKey, { userId: 'user-1' });
    const second = device(secondKey, { userId: 'user-1' });
    devices.getDeliveryTargets.mockResolvedValue([first, second]);
    users.getMetadata.mockResolvedValue([
      {
        key: UserMetadataKey.Preferences,
        value: {
          notifications: {
            locale: 'en-XA',
            devices: [{ sessionId: second.sessionId, locale: 'en' }],
          },
        },
      },
    ]);
    let attempts = 0;
    gateway.send.mockImplementation((_target, request) => {
      sent.push(request);
      return Promise.resolve(++attempts === 2 ? { status: 'retry', retryAfterSec: 30 } : { status: 'sent' });
    });
    NOTIFICATION_CATALOGS['en-XA'] = (localeFixtures.catalogs as NotificationCatalogs)['en-XA'];
    try {
      const data = {
        notice: notice({
          title: 'Shared with you',
          body: 'Zoë shared an item with you',
          systemTemplate: { version: 1, key: 'item-share-one', args: { senderName: 'Zoë' } },
          dedupeKey: 'same-notice',
        }),
      };
      await sut.handleDeliver(data);
      expect(decrypt(sent[0], firstKey)).toMatchObject({
        title: '[Fixture shared]',
        body: '[Fixture Zoë shared one item]',
      });
      expect(decrypt(sent[1], secondKey)).toMatchObject({
        title: 'Shared with you',
        body: 'Zoë shared an item with you',
      });
      users.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { notifications: { locale: 'en-XA', devices: [] } } },
      ]);
      const retry = jobs.queue.mock.calls[0][0];
      await sut.handleDeliver(retry.data);
      expect(sent).toHaveLength(3);
      expect(decrypt(sent[2], secondKey)).toMatchObject({
        title: '[Fixture shared]',
        body: '[Fixture Zoë shared one item]',
      });
      expect(sent[2].collapseId).toBe(sent[1].collapseId);
      expect(sent.every((request) => !JSON.stringify(request).includes('Zoë'))).toBe(true);
      users.getMetadata.mockRejectedValue(new Error('locale lookup unavailable'));
      await sut.handleDeliver(data);
      expect(decrypt(sent[3], firstKey)).toMatchObject({
        title: 'Shared with you',
        body: 'Zoë shared an item with you',
      });
    } finally {
      delete NOTIFICATION_CATALOGS['en-XA'];
    }
  });
  describe('status', () => {
    it('reports push as unavailable on a server that is not linked', async () => {
      const { sut } = newHarness({ linked: false });
      const auth = factory.auth({ session: {} });

      await expect(sut.getStatus(auth)).resolves.toMatchObject({
        available: false,
        reason: PushUnavailableReason.NotLinked,
        registered: false,
      });
    });

    it('reports push as unavailable without a configured cloud, and while a copy is suspected', async () => {
      await expect(newHarness({ cloudUrl: null }).sut.getStatus(factory.auth())).resolves.toMatchObject({
        available: false,
        reason: PushUnavailableReason.NotConfigured,
      });
      await expect(newHarness({ cloneSuspected: true }).sut.getStatus(factory.auth())).resolves.toMatchObject({
        available: false,
        reason: PushUnavailableReason.CloneSuspected,
      });
    });

    it('reports push as available on a linked server, with the encryption scheme and events', async () => {
      const { sut, devices } = newHarness();
      devices.getBySession.mockResolvedValue(device(newDeviceKey()));

      const status = await sut.getStatus(factory.auth({ session: {} }));

      expect(status).toMatchObject({
        available: true,
        reason: null,
        registered: true,
        encryption: { scheme: 'frameleaf-push-v1', keyAgreement: 'X25519', kdf: 'HKDF-SHA256', cipher: 'AES-256-GCM' },
      });
      expect(status.events).toEqual(Object.values(PushEventType));
    });
  });

  describe('registration', () => {
    it('registers the device of the current session with its key, tokens and preferences', async () => {
      const { sut, devices } = newHarness();
      const key = newDeviceKey();
      const auth = factory.auth({ session: {} });
      devices.getBySession.mockResolvedValue(undefined);
      devices.upsert.mockImplementation((registration) => Promise.resolve(device(key, registration)));

      const result = await sut.register(auth, {
        platform: PushPlatform.Ios,
        pushToken: 'apns-1-0123456789abcdef0123456789abcdef',
        pushToStartToken: 'start-1-0123456789abcdef0123456789abcdef',
        publicKey: key.publicKey,
        preferences: { memories: false },
      });

      expect(devices.upsert).toHaveBeenCalledWith({
        userId: auth.user.id,
        sessionId: auth.session!.id,
        platform: PushPlatform.Ios,
        pushToken: 'apns-1-0123456789abcdef0123456789abcdef',
        pushToStartToken: 'start-1-0123456789abcdef0123456789abcdef',
        apnsEnvironment: null,
        publicKey: key.publicKey,
        backupDeviceKey: null,
        disabledEvents: [PushEventType.Memories],
        unifiedPushEndpoint: null,
        unifiedPushPublicKey: null,
        unifiedPushAuth: null,
      });
      expect(result).toMatchObject({ current: true, hasPushToStartToken: true, preferences: { memories: false } });
      expect(JSON.stringify(result)).not.toContain('apns-1-0123456789abcdef0123456789abcdef');
      expect(JSON.stringify(result)).not.toContain('start-1-0123456789abcdef0123456789abcdef');
    });

    it('records the APNs environment of a development build, for iOS only (FL-302)', async () => {
      const { sut, devices } = newHarness();
      const key = newDeviceKey();
      const auth = factory.auth({ session: {} });
      devices.getBySession.mockResolvedValue(undefined);
      devices.upsert.mockImplementation((registration) => Promise.resolve(device(key, registration)));

      const result = await sut.register(auth, {
        platform: PushPlatform.Ios,
        pushToken: 'apns-1-0123456789abcdef0123456789abcdef',
        apnsEnvironment: 'sandbox',
        publicKey: key.publicKey,
      });
      expect(devices.upsert).toHaveBeenCalledWith(expect.objectContaining({ apnsEnvironment: 'sandbox' }));
      expect(result.apnsEnvironment).toBe('sandbox');

      await expect(
        sut.register(auth, {
          platform: PushPlatform.Android,
          pushToken: 'fcm-1-0123456789abcdef0123456789abcdef',
          apnsEnvironment: 'sandbox',
          publicKey: key.publicKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rotates a token by registering again, keeping preferences the update does not name', async () => {
      const { sut, devices } = newHarness();
      const key = newDeviceKey();
      const auth = factory.auth({ session: {} });
      devices.getBySession.mockResolvedValue(device(key, { disabledEvents: [PushEventType.Memories] }));
      devices.upsert.mockImplementation((registration) => Promise.resolve(device(key, registration)));

      await sut.register(auth, {
        platform: PushPlatform.Ios,
        pushToken: 'apns-2-0123456789abcdef0123456789abcdef',
        publicKey: key.publicKey,
      });

      expect(devices.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          pushToken: 'apns-2-0123456789abcdef0123456789abcdef',
          disabledEvents: [PushEventType.Memories],
        }),
      );
    });

    it('updates a rotated token in place', async () => {
      const { sut, devices } = newHarness();
      const key = newDeviceKey();
      const auth = factory.auth({ session: {} });
      devices.getBySession.mockResolvedValue(device(key));
      devices.update.mockImplementation((_sessionId, changes) => Promise.resolve(device(key, changes)));

      await sut.update(auth, {
        pushToken: 'fcm-rotated-0123456789abcdef0123456789abcdef',
        preferences: { sharedActivity: false },
      });

      expect(devices.update).toHaveBeenCalledWith(auth.session!.id, {
        pushToken: 'fcm-rotated-0123456789abcdef0123456789abcdef',
        disabledEvents: [PushEventType.SharedActivity],
      });
    });

    it('refuses a registration without a device session, from a shared link, or with a bad key', async () => {
      const { sut } = newHarness();
      const dto = { platform: PushPlatform.Android, pushToken: 'fcm', publicKey: newDeviceKey().publicKey };

      await expect(sut.register(factory.auth(), dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.register(factory.auth({ session: {}, sharedLink: {} }), dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(sut.register(factory.auth({ session: {} }), { ...dto, publicKey: 'short' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        sut.register(factory.auth({ session: {} }), { ...dto, pushToStartToken: 'start' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps Live Activity tokens for iOS devices only', async () => {
      const { sut, devices } = newHarness();
      const auth = factory.auth({ session: {} });
      const ios = device(newDeviceKey());
      devices.getBySession.mockResolvedValue(ios);
      devices.getByUser.mockResolvedValue([ios]);

      await sut.setActivityToken(auth, 'activity-1', {
        kind: 'cloud-backup-activation',
        token: 'update-1-0123456789abcdef0123456789abcdef',
      });
      expect(devices.setActivity).toHaveBeenCalledWith(ios.id, {
        activityId: 'activity-1',
        kind: 'cloud-backup-activation',
        token: 'update-1-0123456789abcdef0123456789abcdef',
      });

      devices.getBySession.mockResolvedValue(device(newDeviceKey(), { platform: PushPlatform.Android }));
      await expect(
        sut.setActivityToken(auth, 'activity-1', {
          kind: 'cloud-backup-activation',
          token: 'update-1-0123456789abcdef0123456789abcdef',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('removes only own devices', async () => {
      const { sut, devices } = newHarness();
      devices.deleteForUser.mockResolvedValue(false);

      await expect(sut.remove(factory.auth({ session: {} }), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('token lifecycle', () => {
    it('forgets the tokens of a session that logged out or was revoked', async () => {
      const { sut, devices } = newHarness();
      await sut.onSessionDelete({ sessionId: 'session-1' });
      expect(devices.deleteBySession).toHaveBeenCalledWith('session-1');
    });

    it('forgets every token of an account that is removed', async () => {
      const { sut, devices } = newHarness();
      await sut.onUserTrash({ id: 'user-1' } as never);
      expect(devices.deleteAllForUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('event selection', () => {
    it('queues nothing on a server that is not linked', async () => {
      const { sut, jobs } = newHarness({ linked: false });
      await sut.onPushNotify(notice());
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('queues a notice on a linked server', async () => {
      const { sut, jobs } = newHarness();
      await sut.onPushNotify(notice());
      expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.PushDeliver, data: { notice: notice() } });
    });

    it('turns album additions into one coalesced shared-activity notice per member', async () => {
      const { sut, jobs, albums } = newHarness();
      albums.getById.mockResolvedValue({ albumName: 'Trip', albumThumbnailAssetId: 'asset-1' });

      await sut.onAlbumUpdate({ id: 'album-1', userIds: ['a', 'b', 'c'], recipientIds: ['b', 'c'] });

      expect(jobs.queue).toHaveBeenCalledTimes(2);
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.PushDeliver,
        data: {
          notice: expect.objectContaining({
            type: PushEventType.SharedActivity,
            userIds: ['b'],
            assetIds: ['asset-1'],
            dedupeKey: 'album-update/album-1/b',
            data: { albumId: 'album-1', action: 'items-added' },
          }),
        },
      });
    });

    it('tells a member whose access ended', async () => {
      const { sut, jobs, albums } = newHarness();
      albums.getById.mockResolvedValue({ albumName: 'Trip', albumThumbnailAssetId: null });

      await sut.onAlbumUserRemove({ albumId: 'album-1', userId: 'b', removedById: 'a' });

      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.PushDeliver,
        data: {
          notice: expect.objectContaining({
            type: PushEventType.AccessChanged,
            userIds: ['b'],
            data: { albumId: 'album-1', change: 'removed' },
          }),
        },
      });
    });

    it('tells a member who left by themselves nothing (FL-293)', async () => {
      const { sut, jobs, albums } = newHarness();
      albums.getById.mockResolvedValue({ albumName: 'Trip', albumThumbnailAssetId: null });

      await sut.onAlbumUserRemove({ albumId: 'album-1', userId: 'b', removedById: 'b' });

      expect(jobs.queue).not.toHaveBeenCalled();
    });
  });

  describe('delivery', () => {
    it.each([
      [PushTargetKind.Device, 'deleteByIds'],
      [PushTargetKind.ActivityStart, 'clearPushToStartTokens'],
      [PushTargetKind.ActivityUpdate, 'deleteActivitiesByIds'],
    ] as const)('pins invalid %s cleanup to the attempted token and platform', async (kind, cleanup) => {
      const { sut, devices, gateway } = newHarness();
      const token = 'old-token-0123456789abcdef0123456789abcdef';
      const replacement = 'new-token-0123456789abcdef0123456789abcdef';
      const target = device(newDeviceKey(), {
        pushToken: token,
        pushToStartToken: kind === PushTargetKind.ActivityStart ? token : null,
        activities: kind === PushTargetKind.ActivityUpdate ? [{ ...activity(), token }] : [],
        apnsEnvironment: 'sandbox',
      });
      devices.getDeliveryTargets.mockResolvedValue([target]);
      gateway.send.mockImplementationOnce((_target, request) =>
        tryPromise(() => {
          expect(request.token).toBe(token);
          target.pushToken = replacement;
          target.pushToStartToken = replacement;
          for (const activity of target.activities) activity.token = replacement;
          return { status: 'invalid-token' };
        }),
      );

      await sut.handleDeliver({
        notice: notice(kind === PushTargetKind.Device ? {} : { activation: activation('active') }),
      });

      const id = kind === PushTargetKind.ActivityUpdate ? target.activities[0].id : target.id;
      expect(devices[cleanup]).toHaveBeenCalledWith([{ id, token, platform: 'apns-sandbox' }]);
    });

    it('skips an oversized payload and delivers the following notice', async () => {
      const { sut, devices, gateway, sent } = newHarness();
      const key = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([device(key, { userId: 'user-1' })]);

      await expect(
        sut.handleDeliver({ notice: notice({ title: '', body: '', data: { detail: 'd'.repeat(3000) } }) }),
      ).resolves.toBe(JobStatus.Skipped);
      expect(gateway.send).not.toHaveBeenCalled();

      await expect(sut.handleDeliver({ notice: notice() })).resolves.toBe(JobStatus.Success);
      expect(sent).toHaveLength(1);
      expect(decrypt(sent[0], key)).toMatchObject({ title: 'Trip', body: 'New items in Trip' });
    });

    const activation = (state: 'active' | 'complete' | 'failed', step = 3) => ({
      step,
      total: 4,
      stage: step === 4 ? ('first-backup' as const) : ('preparing-storage' as const),
      state,
      firstRun: 'not-started' as const,
      nextRunAt: null,
    });
    const activity = () => ({
      id: randomUUID(),
      deviceId: 'd',
      activityId: 'activity-1',
      kind: 'cloud-backup-activation',
      operationId: null,
      token: `update-${randomUUID()}`,
      updatedAt: new Date(),
    });

    it('sends one push per device, with only the target, the push type and the payload encrypted to its key (FL-302)', async () => {
      const { sut, devices, gateway, sent } = newHarness();
      const ios = newDeviceKey();
      const android = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([
        device(ios, { userId: 'user-1', pushToken: 'apns-1-0123456789abcdef0123456789abcdef' }),
        device(android, {
          userId: 'user-1',
          platform: PushPlatform.Android,
          pushToken: 'fcm-1-0123456789abcdef0123456789abcdef',
        }),
      ]);
      devices.getPreviewSafeAssetIds.mockResolvedValue(new Set(['asset-1']));

      await expect(
        sut.handleDeliver({ notice: notice({ assetIds: ['asset-1'], dedupeKey: 'memories.2026-10-01' }) }),
      ).resolves.toBe(JobStatus.Success);

      expect(gateway.send).toHaveBeenCalledTimes(2);
      expect(sent.map(({ payload: _, ...rest }) => rest)).toEqual([
        {
          platform: 'apns',
          token: 'apns-1-0123456789abcdef0123456789abcdef',
          type: 'alert',
          priority: 'high',
          ttlSec: 86_400,
          collapseId: 'memories.2026-10-01',
        },
        {
          platform: 'fcm',
          token: 'fcm-1-0123456789abcdef0123456789abcdef',
          type: 'alert',
          priority: 'high',
          ttlSec: 86_400,
          collapseId: 'memories.2026-10-01',
        },
      ]);
      for (const request of sent) {
        expect(Buffer.from(request.payload!, 'base64url').toString('latin1')).not.toContain('Trip');
      }
      expect(decrypt(sent[0], ios)).toMatchObject({ title: 'Trip', preview: { assetId: 'asset-1' } });
      expect(decrypt(sent[1], android)).toMatchObject({ title: 'Trip' });
      expect(() => decrypt(sent[0], android)).toThrow();
      expect(devices.markDelivered).toHaveBeenCalledWith(expect.arrayContaining(sent.map(() => expect.any(String))));
    });

    it('sends a development build through APNs sandbox', async () => {
      const { sut, devices, sent } = newHarness();
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey(), { apnsEnvironment: 'sandbox' })]);

      await sut.handleDeliver({ notice: notice() });

      expect(sent[0].platform).toBe('apns-sandbox');
    });

    it('gives a Locked item event no preview and never names the item', async () => {
      const { sut, devices, sent } = newHarness();
      const key = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([device(key, { userId: 'user-1' })]);
      devices.getPreviewSafeAssetIds.mockResolvedValue(new Set());

      await sut.handleDeliver({
        notice: notice({ assetIds: ['locked-asset'], data: { assetId: 'locked-asset', albumId: 'album-1' } }),
      });

      expect(devices.getPreviewSafeAssetIds).toHaveBeenCalledWith(['locked-asset']);
      const payload = decrypt(sent[0], key);
      expect(payload.preview).toBeNull();
      expect(payload.assetIds).toEqual([]);
      expect(JSON.stringify(payload)).not.toContain('locked-asset');
    });

    it("keeps an item hidden by a recipient's hidden people or tags out of that recipient's push only (FL-293)", async () => {
      const { sut, devices, users, sent } = newHarness();
      const plain = newDeviceKey();
      const hiding = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([
        device(plain, { userId: 'user-1' }),
        device(hiding, { userId: 'user-2' }),
      ]);
      const suppression = { tagIds: ['tag-1'], personIds: ['person-1'], petIds: [], scope: 'visible' };
      users.getMetadata.mockImplementation((userId: string) =>
        Promise.resolve(
          userId === 'user-2' ? [{ key: UserMetadataKey.Preferences, value: { privacy: { suppression } } }] : [],
        ),
      );
      devices.getPreviewSafeAssetIds.mockImplementation((_ids: string[], hiddenContent?: unknown) =>
        Promise.resolve(new Set(hiddenContent ? [] : ['asset-1'])),
      );

      await sut.handleDeliver({
        notice: notice({ userIds: ['user-1', 'user-2'], assetIds: ['asset-1'], data: { assetId: 'asset-1' } }),
      });

      expect(sent).toHaveLength(2);
      expect(devices.getPreviewSafeAssetIds).toHaveBeenCalledTimes(2);
      expect(devices.getPreviewSafeAssetIds).toHaveBeenCalledWith(['asset-1'], {
        userId: 'user-2',
        includeNsfw: false,
        ...suppression,
      });
      expect(decrypt(sent[0], plain)).toMatchObject({ assetIds: ['asset-1'], preview: { assetId: 'asset-1' } });
      const hidden = decrypt(sent[1], hiding);
      expect(hidden).toMatchObject({ title: 'Trip', assetIds: [], preview: null });
      expect(JSON.stringify(hidden)).not.toContain('asset-1');
    });

    it('honours per-device preferences', async () => {
      const { sut, devices, gateway } = newHarness();
      devices.getDeliveryTargets.mockResolvedValue([
        device(newDeviceKey(), { disabledEvents: [PushEventType.SharedActivity] }),
      ]);

      await expect(sut.handleDeliver({ notice: notice() })).resolves.toBe(JobStatus.Skipped);
      expect(gateway.send).not.toHaveBeenCalled();
    });

    it('delivers nothing on an unlinked server and says so', async () => {
      const { sut, devices, gateway } = newHarness({ linked: false });
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey())]);

      await expect(sut.handleDeliver({ notice: notice() })).resolves.toBe(JobStatus.Skipped);
      expect(gateway.send).not.toHaveBeenCalled();
    });

    it('forgets exactly the token the gateway calls invalid', async () => {
      const { sut, devices, gateway, users } = newHarness();
      users.getAdmins.mockResolvedValue([{ id: 'admin-1' }]);
      const gone = device(newDeviceKey(), { userId: 'admin-1', activities: [activity()] });
      const startOnly = device(newDeviceKey(), {
        userId: 'admin-1',
        pushToStartToken: 'start-1-0123456789abcdef0123456789abcdef',
      });
      devices.getDeliveryTargets.mockResolvedValue([gone, startOnly]);
      gateway.send.mockResolvedValue({ status: 'invalid-token' });

      await sut.handleDeliver({ notice: notice({ admins: true, activation: activation('active') }) });
      expect(devices.deleteActivitiesByIds).toHaveBeenCalledWith([
        { id: gone.activities[0].id, token: gone.activities[0].token, platform: 'apns' },
      ]);
      expect(devices.clearPushToStartTokens).toHaveBeenCalledWith([
        { id: startOnly.id, token: startOnly.pushToStartToken, platform: 'apns' },
      ]);
      expect(devices.deleteByIds).toHaveBeenCalledWith([]);

      gateway.send.mockClear();
      await sut.handleDeliver({ notice: notice({ admins: true }) });
      expect(devices.deleteByIds).toHaveBeenLastCalledWith([
        { id: gone.id, token: gone.pushToken, platform: 'apns' },
        { id: startOnly.id, token: startOnly.pushToken, platform: 'apns' },
      ]);
      expect(devices.markDelivered).toHaveBeenLastCalledWith([]);
    });

    it('retries only what the gateway asked to, later, and gives up after five attempts', async () => {
      const { sut, devices, gateway, jobs } = newHarness();
      const reached = device(newDeviceKey(), { pushToken: 'apns-reached-0123456789abcdef0123456789abcdef' });
      const busy = device(newDeviceKey(), { pushToken: 'apns-busy-0123456789abcdef0123456789abcdef' });
      devices.getDeliveryTargets.mockResolvedValue([reached, busy]);
      gateway.send.mockImplementation((_target, request: PushSendRequest) =>
        Promise.resolve(
          request.token === 'apns-busy-0123456789abcdef0123456789abcdef'
            ? { status: 'throttled' as const, retryAfterSec: 600 }
            : { status: 'sent' as const },
        ),
      );

      await sut.handleDeliver({ notice: notice({ dedupeKey: 'album-update/1' }) });
      expect(devices.markDelivered).toHaveBeenCalledWith([reached.id]);
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.PushDeliver,
        data: {
          notice: expect.objectContaining({
            dedupeKey: undefined,
            delayMs: 600_000,
            retry: { targets: [`${busy.id}:device:`], attempt: 2, collapseId: collapseIdOf('album-update/1') },
          }),
        },
      });

      // the retry goes to that target alone, with the first attempt's collapse id
      const retry = jobs.queue.mock.calls[0][0].data.notice;
      gateway.send.mockClear();
      gateway.send.mockResolvedValue({ status: 'retry' });
      await sut.handleDeliver({ notice: retry });
      expect(gateway.send).toHaveBeenCalledTimes(1);
      expect(gateway.send.mock.calls[0][1].token).toBe('apns-busy-0123456789abcdef0123456789abcdef');
      expect(gateway.send.mock.calls[0][1].collapseId).toBe(collapseIdOf('album-update/1'));
      expect(jobs.queue).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { notice: expect.objectContaining({ delayMs: 120_000 }) } }),
      );

      jobs.queue.mockClear();
      await sut.handleDeliver({ notice: { ...retry, retry: { ...retry.retry, attempt: 5 } } });
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('retries a send the gateway could not take, and drops one it refused', async () => {
      const { sut, devices, gateway, jobs } = newHarness();
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey()), device(newDeviceKey())]);
      gateway.send
        .mockRejectedValueOnce(new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'down'))
        .mockRejectedValueOnce(new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 400, 'bad request'));

      await expect(sut.handleDeliver({ notice: notice() })).resolves.toBe(JobStatus.Success);
      expect(jobs.queue).toHaveBeenCalledTimes(1);
      expect(jobs.queue.mock.calls[0][0].data.notice.retry.targets).toHaveLength(1);
    });

    it('waits as long as an unavailable gateway asks before retrying', async () => {
      const { sut, devices, gateway, jobs } = newHarness();
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey())]);
      gateway.send.mockRejectedValueOnce(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'push unavailable', null, null, 3600),
      );

      await sut.handleDeliver({ notice: notice() });
      expect(jobs.queue.mock.calls[0][0].data.notice.delayMs).toBe(3_600_000);
    });

    it('forgets a registered token the gateway could never take, without sending, and refuses one at registration', async () => {
      const { sut, devices, gateway } = newHarness();
      const bad = device(newDeviceKey(), { pushToken: 'too short' });
      devices.getDeliveryTargets.mockResolvedValue([bad]);

      await sut.handleDeliver({ notice: notice() });
      expect(gateway.send).not.toHaveBeenCalled();
      expect(devices.deleteByIds).toHaveBeenCalledWith([{ id: bad.id, token: bad.pushToken, platform: 'apns' }]);

      const auth = factory.auth({ session: {} });
      await expect(
        sut.register(auth, { platform: PushPlatform.Ios, pushToken: 'short', publicKey: newDeviceKey().publicKey }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never retries a Live Activity update, which the next one replaces, nor a request the contract refuses', async () => {
      const { sut, devices, gateway, jobs, users } = newHarness();
      users.getAdmins.mockResolvedValue([{ id: 'admin-1' }]);
      devices.getDeliveryTargets.mockResolvedValue([
        device(newDeviceKey(), { userId: 'admin-1', activities: [activity()] }),
      ]);
      gateway.send.mockResolvedValue({ status: 'retry' });
      await sut.handleDeliver({ notice: notice({ admins: true, activation: activation('active') }) });
      expect(jobs.queue).not.toHaveBeenCalled();

      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey())]);
      gateway.send.mockRejectedValue(new ZodError([]));
      await sut.handleDeliver({ notice: notice() });
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('sends the activation chain as a Live Activity with a fixed state, never the payload or items', async () => {
      const { sut, devices, users, sent } = newHarness();
      users.getAdmins.mockResolvedValue([{ id: 'admin-1' }]);
      devices.getDeliveryTargets.mockResolvedValue([
        device(newDeviceKey(), { userId: 'admin-1', activities: [activity()] }),
      ]);
      devices.getPreviewSafeAssetIds.mockResolvedValue(new Set(['asset-1']));

      await sut.handleDeliver({
        notice: notice({
          type: PushEventType.CloudBackupActivation,
          admins: true,
          title: 'Cloud Backup setup',
          body: '3 of 4 · Preparing storage',
          assetIds: ['asset-1'],
          activation: activation('active'),
        }),
      });

      expect(devices.getDeliveryTargets).toHaveBeenCalledWith(['user-1', 'admin-1']);
      expect(sent).toEqual([
        {
          platform: 'apns',
          token: expect.any(String),
          type: 'live-activity-update',
          priority: 'high',
          ttlSec: 3600,
          liveActivity: { state: { step: 'storage-ready', progress: 0.75 }, staleAfterSec: 3600 },
        },
      ]);
    });

    it('starts the Live Activity with the push-to-start token, and ends it with an alert when the chain ends', async () => {
      const { sut, devices, sent } = newHarness();
      devices.getDeliveryTargets.mockResolvedValue([
        device(newDeviceKey(), { pushToStartToken: 'start-1-0123456789abcdef0123456789abcdef' }),
      ]);

      await sut.handleDeliver({ notice: notice({ activation: activation('active', 1) }) });
      expect(sent[0]).toMatchObject({
        token: 'start-1-0123456789abcdef0123456789abcdef',
        type: 'live-activity-start',
        liveActivity: { state: { step: 'storage-ready' }, attributesType: 'ActivationAttributes' },
      });

      sent.length = 0;
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey(), { activities: [activity()] })]);
      await sut.handleDeliver({ notice: notice({ activation: activation('complete', 4) }) });
      expect(sent.map(({ type, liveActivity }) => [type, liveActivity?.state.step])).toEqual([
        ['live-activity-end', 'backup-done'],
        ['alert', undefined],
      ]);
    });

    it('drives a Studio render Live Activity on iOS and a background progress push on Android', async () => {
      const { sut, devices, sent } = newHarness();
      const render = (state: 'started' | 'running' | 'done' | 'failed', progress: number) => ({
        type: state === 'done' || state === 'failed' ? PushEventType.RenderFinished : PushEventType.RenderProgress,
        background: state === 'started' || state === 'running',
        data: { kind: 'render', job: 'job-1', progress },
        render: { job: 'job-1', state, progress },
      });
      const ios = () => device(newDeviceKey(), { pushToStartToken: 'start-1-0123456789abcdef0123456789abcdef' });
      const android = () =>
        device(newDeviceKey(), { platform: PushPlatform.Android, pushToken: 'fcm-1-0123456789abcdef0123456789abcdef' });
      const renderActivity = () => ({ ...activity(), kind: 'studio-render', operationId: 'job-1' });
      const summary = () =>
        sent.map(({ platform, type, liveActivity }) => [
          platform,
          type,
          liveActivity?.state.step,
          liveActivity?.state.progress,
          liveActivity?.attributesType,
        ]);

      // started: push-to-start the activity on iOS, and tell both platforms the job in a background push
      devices.getDeliveryTargets.mockResolvedValue([ios(), android()]);
      await sut.handleDeliver({ notice: notice(render('started', 0)) });
      expect(summary()).toEqual([
        ['apns', 'live-activity-start', 'render-running', 0, 'RenderAttributes'],
        ['apns', 'background', undefined, undefined, undefined],
        ['fcm', 'background', undefined, undefined, undefined],
      ]);

      // running: iOS gets the activity update alone (never a second start), Android the progress push
      sent.length = 0;
      devices.getDeliveryTargets.mockResolvedValue([
        ios(),
        device(newDeviceKey(), { activities: [renderActivity()] }),
        android(),
      ]);
      await sut.handleDeliver({ notice: notice(render('running', 0.4)) });
      expect(summary()).toEqual([
        ['apns', 'live-activity-update', 'render-running', 0.4, undefined],
        ['fcm', 'background', undefined, undefined, undefined],
      ]);

      // a Cloud Backup activation activity is not a render activity
      sent.length = 0;
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey(), { activities: [activity()] })]);
      await sut.handleDeliver({ notice: notice(render('running', 0.5)) });
      expect(sent).toEqual([]);

      // done / failed: the activity ends and the render-finished alert goes everywhere
      sent.length = 0;
      devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey(), { activities: [renderActivity()] })]);
      await sut.handleDeliver({ notice: notice(render('done', 1)) });
      expect(summary()).toEqual([
        ['apns', 'live-activity-end', 'render-done', 1, undefined],
        ['apns', 'alert', undefined, undefined, undefined],
      ]);
      sent.length = 0;
      await sut.handleDeliver({ notice: notice(render('failed', 0)) });
      expect(summary()[0]).toEqual(['apns', 'live-activity-end', 'needs-attention', undefined, undefined]);
    });

    it('ends only the bound render with progress enabled and finish alerts disabled', async () => {
      const { sut, devices, sent } = newHarness();
      const key = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([
        device(key, {
          disabledEvents: [PushEventType.RenderFinished],
          activities: [
            { ...activity(), kind: 'studio-render', operationId: 'render-a' },
            { ...activity(), kind: 'studio-render', operationId: 'render-b' },
            { ...activity(), kind: 'studio-render', operationId: null },
          ],
        }),
      ]);
      await sut.handleDeliver({
        notice: notice({
          type: PushEventType.RenderFinished,
          render: { job: 'render-a', state: 'done', progress: 1 },
        }),
      });
      expect(sent.map(({ type }) => type)).toEqual(['live-activity-end']);
      expect(sent[0].token).toBe((await devices.getDeliveryTargets())[0].activities[0].token);
      sent.length = 0;
      await sut.handleDeliver({
        notice: notice({
          type: PushEventType.RenderProgress,
          background: true,
          render: { job: 'render-b', state: 'running', progress: 0.6 },
        }),
      });
      expect(sent.map(({ type }) => type)).toEqual(['live-activity-update']);
      expect(sent[0].token).toBe((await devices.getDeliveryTargets())[0].activities[1].token);
    });

    it('silently clears Android render progress when finish alerts are disabled', async () => {
      const { sut, devices, sent } = newHarness();
      const key = newDeviceKey();
      devices.getDeliveryTargets.mockResolvedValue([
        device(key, {
          platform: PushPlatform.Android,
          disabledEvents: [PushEventType.RenderFinished],
        }),
      ]);
      await sut.handleDeliver({
        notice: notice({
          type: PushEventType.RenderFinished,
          render: { job: 'render-a', state: 'done', progress: 1 },
          data: { job: 'render-a', status: 'published' },
        }),
      });
      expect(sent.map(({ type }) => type)).toEqual(['background']);
      expect(decrypt(sent[0], key).data).toMatchObject({ job: 'render-a', status: 'published' });
    });

    it('wakes only the device whose phone backup went stale, silently', async () => {
      const { sut, devices, jobs } = newHarness();
      devices.getStaleBackupWakeTargets.mockResolvedValue([
        {
          deviceId: 'push-1',
          userId: 'user-1',
          backupDeviceKey: 'backup-1',
          displayName: 'Phone',
          pendingCount: 4,
          lastSuccessfulBackupAt: new Date(Date.now() - 4 * 86_400_000),
        },
      ]);

      await expect(sut.handleBackupStaleCheck()).resolves.toBe(JobStatus.Success);

      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.PushDeliver,
        data: {
          notice: expect.objectContaining({
            type: PushEventType.BackupStale,
            userIds: ['user-1'],
            backupDeviceKey: 'backup-1',
            background: true,
            systemTemplate: { version: 1, key: 'backup-stale-many', args: { deviceName: 'Phone', count: 4 } },
          }),
        },
      });
      expect(devices.markStaleWake).toHaveBeenCalledWith(['push-1']);
    });

    it('sends a stale-backup wake-up as a background push to the linked device only', async () => {
      const { sut, devices, sent } = newHarness();
      const linked = device(newDeviceKey(), {
        userId: 'user-1',
        backupDeviceKey: 'backup-1',
        pushToken: 'apns-a-0123456789abcdef0123456789abcdef',
      });
      devices.getDeliveryTargets.mockResolvedValue([linked, device(newDeviceKey(), { userId: 'user-1' })]);

      await sut.handleDeliver({
        notice: notice({ type: PushEventType.BackupStale, backupDeviceKey: 'backup-1', background: true }),
      });

      expect(sent.map(({ payload: _, ...rest }) => rest)).toEqual([
        {
          platform: 'apns',
          token: 'apns-a-0123456789abcdef0123456789abcdef',
          type: 'background',
          priority: 'normal',
          ttlSec: 4 * 3600,
        },
      ]);
    });
  });

  describe('with a fake Frameleaf push gateway', () => {
    let cloud: FakeCloud;
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'frameleaf-push-service-'));
      cloud = await startFakeCloud();
      cloud.on('POST /id/token', (request) => tokenAnswer(request, 'push-token'));
    });

    afterEach(async () => {
      await cloud.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('delivers opaque payloads through the gateway, signed with the instance key', async () => {
      const received: PushSendRequest[] = [];
      cloud.on('POST /push/v1/push/send', (request) => {
        received.push(request.json());
        return { status: 200, body: { status: 'sent' } };
      });
      const metadata = new Map<string, unknown>([
        [SystemMetadataKey.FrameleafCloudLink, { status: 'linked', instanceId: 'instance-1', cloudUrl: cloud.url }],
      ]);
      const key = newDeviceKey();
      const devices = {
        getDeliveryTargets: vi.fn().mockResolvedValue([device(key, { userId: 'user-1', pushToken: APNS_TOKEN })]),
        getPreviewSafeAssetIds: vi.fn().mockResolvedValue(new Set()),
        deleteByIds: vi.fn(),
        clearPushToStartTokens: vi.fn(),
        deleteActivitiesByIds: vi.fn(),
        deleteGoneUnifiedPush: vi.fn(),
        markDelivered: vi.fn(),
      };
      const cloudRepository = new FrameleafCloudRepository(LoggingRepository.create());
      const sut = new PushService(
        LoggingRepository.create(),
        {
          getEnv: () => ({ frameleafCloud: { url: cloud.url, pushUrl: `${cloud.url}/push`, identityDir: dir } }),
        } as never,
        {
          get: (k: string) => Promise.resolve(metadata.get(k) ?? null),
          set: (k: string, v: unknown) => Promise.resolve(void metadata.set(k, v)),
        } as never,
        { withLock: (_lock: unknown, fn: () => unknown) => fn() } as never,
        new InstanceIdentityRepository(),
        cloudRepository,
        devices as never,
        new FrameleafCloudPushRepository(cloudRepository),
        { queue: vi.fn() } as never,
        { getAdmins: vi.fn().mockResolvedValue([]), getMetadata: vi.fn().mockResolvedValue([]) } as never,
        { getById: vi.fn() } as never,
        new UnifiedPushRepository(),
      );

      await expect(
        sut.handleDeliver({ notice: notice({ assetIds: ['locked'], data: { assetId: 'locked' } }) }),
      ).resolves.toBe(JobStatus.Success);

      expect(received).toHaveLength(1);
      const request = cloud.requests.find(({ path }) => path === '/push/v1/push/send')!;
      expect(request.dpop).not.toBeNull();
      expect(request.body).not.toContain('Trip');
      expect(request.body).not.toContain('locked');
      expect(received[0]).toMatchObject({ platform: 'apns', token: APNS_TOKEN, type: 'alert', priority: 'high' });
      const payload = decrypt(received[0], key);
      expect(payload).toMatchObject({ title: 'Trip', preview: null, assetIds: [] });
      expect(JSON.stringify(payload)).not.toContain('locked');
      expect(devices.markDelivered).toHaveBeenCalled();
    });
  });

  describe('UnifiedPush (FL-926)', () => {
    const ENDPOINT = 'https://ntfy.example.net/upAbCdEfGhIjKl?up=1';

    const newWebPushKeys = () => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return {
        privateKey: ecdh.getPrivateKey(),
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      };
    };

    const unifiedPushDevice = (key: DeviceKey, overrides: Partial<PushDeviceWithActivities> = {}) => {
      const webPush = newWebPushKeys();
      return device(key, {
        platform: PushPlatform.Android,
        pushToken: null,
        unifiedPushEndpoint: ENDPOINT,
        unifiedPushPublicKey: webPush.p256dh,
        unifiedPushAuth: webPush.auth,
        ...overrides,
      });
    };

    const activeLicence = () => ({
      key: { kind: 'server', claims: { exp: Math.floor(Date.now() / 1000) + 86_400, lic_exp: null, ent: ['SERVER'] } },
      plan: null,
    });

    describe('registration', () => {
      it('registers an Android device by its UnifiedPush endpoint and keys alone, without an FCM token', async () => {
        const { sut, devices, unifiedPush } = newHarness({ linked: false });
        const key = newDeviceKey();
        const webPush = newWebPushKeys();
        devices.getBySession.mockResolvedValue(undefined);
        devices.upsert.mockImplementation((registration) => Promise.resolve(device(key, registration)));

        const result = await sut.register(factory.auth({ session: {} }), {
          platform: PushPlatform.Android,
          publicKey: key.publicKey,
          unifiedPushEndpoint: ENDPOINT,
          // standard base64 with padding is accepted and stored as unpadded base64url
          unifiedPushPublicKey: Buffer.from(webPush.p256dh, 'base64url').toString('base64'),
          unifiedPushAuth: webPush.auth,
        });

        expect(unifiedPush.checkEndpoint).toHaveBeenCalledWith(ENDPOINT, { allowLocalTargets: false });
        expect(devices.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            platform: PushPlatform.Android,
            pushToken: null,
            unifiedPushEndpoint: ENDPOINT,
            unifiedPushPublicKey: webPush.p256dh,
            unifiedPushAuth: webPush.auth,
          }),
        );
        expect(result).toMatchObject({
          transport: 'unifiedpush',
          unifiedPush: { endpointHost: 'ntfy.example.net', available: true, reason: null },
        });
        // the endpoint is a capability: only its host is ever returned
        expect(JSON.stringify(result)).not.toContain('upAbCdEfGhIjKl');
        expect(JSON.stringify(result)).not.toContain(webPush.auth);
      });

      it('refuses UnifiedPush from iOS, without its keys, with bad keys, and a device with no way to reach it', async () => {
        const { sut } = newHarness();
        const key = newDeviceKey();
        const webPush = newWebPushKeys();
        const auth = factory.auth({ session: {} });
        const base = { platform: PushPlatform.Android, publicKey: key.publicKey };
        const up = {
          unifiedPushEndpoint: ENDPOINT,
          unifiedPushPublicKey: webPush.p256dh,
          unifiedPushAuth: webPush.auth,
        };

        await expect(
          sut.register(auth, { ...base, ...up, platform: PushPlatform.Ios, pushToken: APNS_TOKEN }),
        ).rejects.toThrow('Only Android devices use UnifiedPush');
        await expect(sut.register(auth, { ...base, unifiedPushEndpoint: ENDPOINT })).rejects.toThrow(
          'needs its unifiedPushPublicKey and unifiedPushAuth',
        );
        await expect(sut.register(auth, { ...base, ...up, unifiedPushPublicKey: key.publicKey })).rejects.toThrow(
          BadRequestException,
        );
        await expect(sut.register(auth, { ...base, ...up, unifiedPushAuth: 'AAAA' })).rejects.toThrow('16 bytes');
        await expect(sut.register(auth, base)).rejects.toThrow('A push token is needed');
      });

      it('refuses an endpoint on this network, or this server itself, unless allowed (SSRF guard)', async () => {
        const key = newDeviceKey();
        const webPush = newWebPushKeys();
        const auth = factory.auth({ session: {} });
        const registration = (endpoint: string) => ({
          platform: PushPlatform.Android,
          publicKey: key.publicKey,
          unifiedPushEndpoint: endpoint,
          unifiedPushPublicKey: webPush.p256dh,
          unifiedPushAuth: webPush.auth,
        });

        const strict = newHarness({ realUnifiedPush: true });
        for (const endpoint of [
          'https://192.168.1.20/upAbCdEfGhIjKl',
          'https://127.0.0.1/upAbCdEfGhIjKl',
          'https://localhost/upAbCdEfGhIjKl',
          'https://169.254.169.254/latest',
          // eslint-disable-next-line unicorn/prefer-https -- plain http to a public host is refused
          'http://ntfy.example.net/upAbCdEfGhIjKl',
          'https://user:pass@ntfy.example.net/up',
        ]) {
          await expect(strict.sut.register(auth, registration(endpoint))).rejects.toThrow(
            'not at a public https address',
          );
        }

        const local = newHarness({ realUnifiedPush: true, unifiedPush: { allowLocalTargets: true } });
        local.devices.upsert.mockImplementation((value) => Promise.resolve(device(key, value)));
        await expect(
          local.sut.register(auth, registration('http://192.168.1.20:8080/upAbCdEfGhIjKl?up=1')),
        ).resolves.toMatchObject({ transport: 'unifiedpush' });
        // loopback and link-local stay out of reach even then
        await expect(local.sut.register(auth, registration('https://127.0.0.1/up'))).rejects.toThrow(
          BadRequestException,
        );
        await expect(local.sut.register(auth, registration('https://[fe80::1]/up'))).rejects.toThrow(
          BadRequestException,
        );
      });

      it('switches back to the Cloud gateway when the device clears its endpoint, but never to nothing', async () => {
        const { sut, devices } = newHarness();
        const key = newDeviceKey();
        const auth = factory.auth({ session: {} });
        const current = unifiedPushDevice(key);
        devices.getBySession.mockResolvedValue(current);
        devices.update.mockImplementation((_session, changes) => Promise.resolve({ ...current, ...changes }));

        await expect(sut.update(auth, { unifiedPushEndpoint: null })).rejects.toThrow('needs a push token');

        const result = await sut.update(auth, {
          unifiedPushEndpoint: null,
          pushToken: 'fcm-0123456789abcdef0123456789abcdef',
        });
        expect(devices.update).toHaveBeenCalledWith(auth.session!.id, {
          pushToken: 'fcm-0123456789abcdef0123456789abcdef',
          unifiedPushEndpoint: null,
          unifiedPushPublicKey: null,
          unifiedPushAuth: null,
        });
        expect(result).toMatchObject({ transport: 'cloud', unifiedPush: null });
      });
    });

    describe('delivery', () => {
      it('delivers to a UnifiedPush device on a server with no Cloud link, with the payload the gateway would get', async () => {
        const { sut, devices, gateway, unifiedPush } = newHarness({ linked: false });
        const key = newDeviceKey();
        const target = unifiedPushDevice(key, { userId: 'user-1' });
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        devices.getDeliveryTargets.mockResolvedValue([target]);

        await expect(sut.handleDeliver({ notice: notice({ dedupeKey: 'album-update/1' }) })).resolves.toBe(
          JobStatus.Success,
        );

        expect(gateway.send).not.toHaveBeenCalled();
        expect(unifiedPush.send).toHaveBeenCalledTimes(1);
        const [subscription, message, options] = unifiedPush.send.mock.calls[0];
        expect(subscription).toEqual({
          endpoint: ENDPOINT,
          p256dh: target.unifiedPushPublicKey,
          auth: target.unifiedPushAuth,
        });
        expect(options).toEqual({ allowLocalTargets: false });
        expect(message).toMatchObject({ ttlSec: 86_400, urgency: 'high', topic: collapseIdOf('album-update/1') });
        const plaintext = JSON.parse(message.plaintext.toString('utf8'));
        // exactly the data an FCM push from the gateway carries: the envelope and the push type
        expect(plaintext).toEqual({ e: expect.any(String), t: 'alert' });
        expect(decrypt({ payload: plaintext.e } as PushSendRequest, key)).toMatchObject({
          title: 'Trip',
          body: 'New items in Trip',
        });
        expect(message.plaintext.toString('utf8')).not.toContain('Trip');
        expect(devices.markDelivered).toHaveBeenCalledWith([target.id]);
      });

      it('routes each device by its own way: UnifiedPush when it has an endpoint, else the gateway', async () => {
        const { sut, devices, sent, unifiedPush } = newHarness();
        const upDevice = unifiedPushDevice(newDeviceKey(), { pushToken: 'fcm-0123456789abcdef0123456789abcdef' });
        const cloudDevice = device(newDeviceKey(), { pushToken: APNS_TOKEN });
        devices.getDeliveryTargets.mockResolvedValue([upDevice, cloudDevice]);

        await sut.handleDeliver({ notice: notice() });

        expect(unifiedPush.send).toHaveBeenCalledTimes(1);
        expect(unifiedPush.send.mock.calls[0][0].endpoint).toBe(ENDPOINT);
        expect(sent).toHaveLength(1);
        expect(sent[0].token).toBe(APNS_TOKEN);
        expect(devices.markDelivered.mock.calls[0][0].toSorted()).toEqual([upDevice.id, cloudDevice.id].toSorted());
      });

      it('unregisters a device whose endpoint is gone (404/410)', async () => {
        const { sut, devices, unifiedPush, jobs } = newHarness({ linked: false });
        const target = unifiedPushDevice(newDeviceKey());
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        devices.getDeliveryTargets.mockResolvedValue([target]);
        unifiedPush.send.mockResolvedValue({ status: 'gone' });

        await sut.handleDeliver({ notice: notice() });

        expect(devices.deleteGoneUnifiedPush).toHaveBeenCalledWith([{ id: target.id, endpoint: ENDPOINT }]);
        expect(devices.markDelivered).toHaveBeenCalledWith([]);
        expect(jobs.queue).not.toHaveBeenCalled();
      });

      it('backs off after a 429 by its Retry-After, for a bounded number of attempts', async () => {
        const { sut, devices, unifiedPush, jobs } = newHarness({ linked: false });
        const target = unifiedPushDevice(newDeviceKey());
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        devices.getDeliveryTargets.mockResolvedValue([target]);
        unifiedPush.send.mockResolvedValue({ status: 'retry', retryAfterSec: 120 });

        let data: { notice: PushNotice } = { notice: notice() };
        const attempts: number[] = [];
        for (let run = 0; run < 10; run++) {
          jobs.queue.mockClear();
          await sut.handleDeliver(data);
          if (jobs.queue.mock.calls.length === 0) {
            break;
          }
          expect(jobs.queue).toHaveBeenCalledTimes(1);
          const next = jobs.queue.mock.calls[0][0].data as { notice: PushNotice };
          attempts.push(next.notice.retry!.attempt);
          // the first retry waits for Retry-After (2 min) rather than the 30 s backoff
          if (next.notice.retry!.attempt === 2) {
            expect(next.notice.delayMs).toBe(120_000);
          }
          expect(next.notice.retry!.targets).toEqual([`${target.id}:${PushTargetKind.Device}:`]);
          data = next;
        }

        expect(attempts).toEqual([2, 3, 4, 5]);
        expect(unifiedPush.send).toHaveBeenCalledTimes(5);
        expect(devices.deleteGoneUnifiedPush).toHaveBeenCalledWith([]);
      });

      it('refuses, without retrying, an endpoint that points at this network or this server (SSRF guard)', async () => {
        const { sut, devices, jobs } = newHarness({ linked: false, realUnifiedPush: true });
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        devices.getDeliveryTargets.mockResolvedValue([
          unifiedPushDevice(newDeviceKey(), { unifiedPushEndpoint: 'https://127.0.0.1:8080/upAbCdEfGhIjKl' }),
          unifiedPushDevice(newDeviceKey(), { unifiedPushEndpoint: 'https://10.0.0.7/upAbCdEfGhIjKl' }),
          unifiedPushDevice(newDeviceKey(), { unifiedPushEndpoint: 'https://metadata.google.internal/up' }),
        ]);

        await expect(sut.handleDeliver({ notice: notice() })).resolves.toBe(JobStatus.Success);

        expect(devices.markDelivered).toHaveBeenCalledWith([]);
        expect(devices.deleteGoneUnifiedPush).toHaveBeenCalledWith([]);
        expect(jobs.queue).not.toHaveBeenCalled();
      });

      it('queues events for UnifiedPush devices on a server with no Cloud link', async () => {
        const { sut, devices, jobs } = newHarness({ linked: false });
        await sut.onPushNotify(notice());
        expect(jobs.queue).not.toHaveBeenCalled();

        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        await sut.onPushNotify(notice());
        expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.PushDeliver, data: { notice: notice() } });
      });
    });

    describe('licensed switch (FL-908 pending)', () => {
      it('limits UnifiedPush to a licensed server when the administrator says so', async () => {
        const { sut, devices, gateway, unifiedPush, metadata, jobs } = newHarness({
          unifiedPush: { availability: 'licensed' },
        });
        const key = newDeviceKey();
        const webPush = newWebPushKeys();
        const auth = factory.auth({ session: {} });
        const registration = {
          platform: PushPlatform.Android,
          publicKey: key.publicKey,
          unifiedPushEndpoint: ENDPOINT,
          unifiedPushPublicKey: webPush.p256dh,
          unifiedPushAuth: webPush.auth,
        };

        // registration
        await expect(sut.register(auth, registration)).rejects.toThrow(ForbiddenException);
        await expect(sut.getStatus(auth)).resolves.toMatchObject({
          unifiedPush: { available: false, reason: 'licence-required', encoding: 'aes128gcm' },
        });

        // send: a device with an FCM token falls back to the gateway; one without is not reached
        const withToken = unifiedPushDevice(key, { pushToken: 'fcm-0123456789abcdef0123456789abcdef' });
        const withoutToken = unifiedPushDevice(newDeviceKey());
        devices.getDeliveryTargets.mockResolvedValue([withToken, withoutToken]);
        await sut.handleDeliver({ notice: notice() });
        expect(unifiedPush.send).not.toHaveBeenCalled();
        expect(gateway.send).toHaveBeenCalledTimes(1);
        expect(gateway.send.mock.calls[0][1]).toMatchObject({ platform: 'fcm', token: withToken.pushToken });
        devices.getByUser.mockResolvedValue([withoutToken]);
        await expect(sut.listDevices(auth)).resolves.toMatchObject({
          devices: [{ transport: 'unifiedpush', unifiedPush: { available: false, reason: 'licence-required' } }],
        });

        // an unlinked, unlicensed server queues nothing for UnifiedPush devices
        metadata.delete(SystemMetadataKey.FrameleafCloudLink);
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        await sut.onPushNotify(notice());
        expect(jobs.queue).not.toHaveBeenCalled();

        // with an active licence it is available again
        metadata.set(SystemMetadataKey.FrameleafLicense, activeLicence());
        devices.upsert.mockImplementation((value) => Promise.resolve(device(key, value)));
        await expect(sut.register(auth, registration)).resolves.toMatchObject({ transport: 'unifiedpush' });
        await sut.handleDeliver({ notice: notice() });
        expect(unifiedPush.send).toHaveBeenCalledTimes(2);
      });
    });

    describe('Cloud push plan switch (FL-908 pending)', () => {
      const cloudPlan = () => ({
        key: null,
        plan: { kind: 'plan', claims: { exp: Math.floor(Date.now() / 1000) + 86_400, lic_exp: null, ent: ['CLOUD'] } },
      });

      it.each([false, true])('leaves Cloud push alone when off, never reading the licence (plan: %s)', async (plan) => {
        const { sut, devices, gateway, metadata } = newHarness();
        if (plan) {
          metadata.set(SystemMetadataKey.FrameleafLicense, cloudPlan());
        }
        const read = vi.spyOn(metadata, 'get');
        devices.getDeliveryTargets.mockResolvedValue([device(newDeviceKey())]);
        await expect(sut.getStatus(factory.auth({ session: {} }))).resolves.toMatchObject({ available: true });
        await sut.handleDeliver({ notice: notice() });
        expect(gateway.send).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalledWith(SystemMetadataKey.FrameleafLicense);
      });

      it('asks only for devices it can reach when waking stale backups', async () => {
        const { sut, devices } = newHarness({ linked: false });
        devices.hasUnifiedPushDevices.mockResolvedValue(true);
        await sut.handleBackupStaleCheck();
        expect(devices.getStaleBackupWakeTargets).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), {
          cloud: false,
          unifiedPush: true,
        });
      });

      it('refuses an endpoint clear when the conditional write finds no token left', async () => {
        const { sut, devices } = newHarness();
        const stored = device(newDeviceKey());
        devices.getBySession.mockResolvedValue(stored);
        devices.update.mockResolvedValue(undefined);
        await expect(
          sut.update(factory.auth({ session: { id: stored.sessionId } }), { unifiedPushEndpoint: null }),
        ).rejects.toThrow(BadRequestException);
      });

      it('holds Cloud push without a plan when on, and never UnifiedPush', async () => {
        const { sut, devices, gateway, unifiedPush, metadata } = newHarness({ cloudPushRequiresPlan: true });
        const cloudDevice = device(newDeviceKey());
        const ntfyDevice = unifiedPushDevice(newDeviceKey());
        devices.getDeliveryTargets.mockResolvedValue([cloudDevice, ntfyDevice]);
        devices.hasUnifiedPushDevices.mockResolvedValue(true);

        await expect(sut.getStatus(factory.auth({ session: {} }))).resolves.toMatchObject({
          available: false,
          reason: null,
          unifiedPush: { available: true },
        });
        await sut.handleDeliver({ notice: notice() });
        expect(gateway.send).not.toHaveBeenCalled();
        expect(unifiedPush.send).toHaveBeenCalledTimes(1);

        metadata.set(SystemMetadataKey.FrameleafLicense, cloudPlan());
        await expect(sut.getStatus(factory.auth({ session: {} }))).resolves.toMatchObject({ available: true });
        await sut.handleDeliver({ notice: notice() });
        expect(gateway.send).toHaveBeenCalledTimes(1);
      });
    });

    describe('test notification', () => {
      it('sends a test to an own device by its way and says it was sent', async () => {
        const { sut, devices, unifiedPush } = newHarness({ linked: false });
        const auth = factory.auth({ session: {} });
        const key = newDeviceKey();
        // the test ignores the device's preferences
        const target = unifiedPushDevice(key, { userId: auth.user.id, disabledEvents: [PushEventType.SharedActivity] });
        devices.getById.mockResolvedValue(target);

        await expect(sut.sendTest(auth, target.id)).resolves.toEqual({
          transport: 'unifiedpush',
          status: 'sent',
          message: null,
        });

        const plaintext = JSON.parse(unifiedPush.send.mock.calls[0][1].plaintext.toString('utf8'));
        expect(decrypt({ payload: plaintext.e } as PushSendRequest, key)).toMatchObject({
          title: 'Test notification',
          data: { action: 'test' },
        });
        expect(devices.markDelivered).toHaveBeenCalledWith([target.id]);
      });

      it("lets an administrator test anyone's device, and nobody else", async () => {
        const { sut, devices, sent } = newHarness();
        const target = device(newDeviceKey(), { userId: 'owner', pushToken: APNS_TOKEN });
        devices.getById.mockResolvedValue(target);

        await expect(sut.sendTest(factory.auth(), target.id)).rejects.toThrow(NotFoundException);
        await expect(sut.sendTest(factory.auth({ user: { isAdmin: true } }), target.id)).resolves.toMatchObject({
          transport: 'cloud',
          status: 'sent',
        });
        expect(sent).toHaveLength(1);
        devices.getById.mockResolvedValue(undefined);
        await expect(sut.sendTest(factory.auth({ user: { isAdmin: true } }), target.id)).rejects.toThrow(
          NotFoundException,
        );
      });

      it('unregisters a device the push server reports gone, and reports a Cloud device of an unlinked server', async () => {
        const { sut, devices, unifiedPush } = newHarness({ linked: false });
        const auth = factory.auth();
        const target = unifiedPushDevice(newDeviceKey(), { userId: auth.user.id });
        devices.getById.mockResolvedValue(target);
        unifiedPush.send.mockResolvedValue({ status: 'gone' });

        await expect(sut.sendTest(auth, target.id)).resolves.toMatchObject({
          transport: 'unifiedpush',
          status: 'gone',
        });
        expect(devices.deleteGoneUnifiedPush).toHaveBeenCalledWith([{ id: target.id, endpoint: ENDPOINT }]);

        devices.getById.mockResolvedValue(device(newDeviceKey(), { userId: auth.user.id, pushToken: APNS_TOKEN }));
        await expect(sut.sendTest(auth, target.id)).resolves.toMatchObject({
          transport: 'cloud',
          status: 'unavailable',
          message: expect.stringContaining('not-linked'),
        });
      });
    });
  });
});
