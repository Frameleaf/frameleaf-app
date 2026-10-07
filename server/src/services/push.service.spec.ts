import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { KeyObject, generateKeyPairSync, randomUUID } from 'node:crypto';
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
import { PushService } from 'src/services/push.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { PushNotice, PushSendRequest, PushSendResult, collapseIdOf } from 'src/utils/frameleaf-push.js';
import { NOTIFICATION_CATALOGS, type NotificationCatalogs } from 'src/utils/notification-locale.js';
import { openPushEnvelope } from 'src/utils/push-crypto.js';
import { FakeCloud, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import localeFixtures from 'test/fixtures/system-notification-locale.json' with { type: 'json' };
import { factory } from 'test/small.factory.js';

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
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  lastDeliveredAt: null,
  lastStaleWakeAt: null,
  activities: [],
  ...overrides,
});

const CLOUD_URL = 'https://cloud.frameleaf.test';
const APNS_TOKEN = 'f'.repeat(64);

const newHarness = (options: { linked?: boolean; cloudUrl?: string | null; cloneSuspected?: boolean } = {}) => {
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
  };
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
    { getEnv: () => ({ frameleafCloud: { url: cloudUrl, identityDir: '/tmp/identity' } }) } as never,
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
  );
  return { sut, devices, gateway, sent, jobs, users, albums };
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
      token: 'update-1-0123456789abcdef0123456789abcdef',
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
      expect(devices.deleteActivitiesByIds).toHaveBeenCalledWith([gone.activities[0].id]);
      expect(devices.clearPushToStartTokens).toHaveBeenCalledWith([startOnly.id]);
      expect(devices.deleteByIds).toHaveBeenCalledWith([]);

      gateway.send.mockClear();
      await sut.handleDeliver({ notice: notice({ admins: true }) });
      expect(devices.deleteByIds).toHaveBeenLastCalledWith([gone.id, startOnly.id]);
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
      expect(devices.deleteByIds).toHaveBeenCalledWith([bad.id]);

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
          token: 'update-1-0123456789abcdef0123456789abcdef',
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
});
