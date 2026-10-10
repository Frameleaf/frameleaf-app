import type { AdminNotice } from 'src/repositories/event.repository.js';
import type { JobItem } from 'src/types.js';
import { AdminConfigDto, SystemConfig, defaults } from 'src/dtos/config.dto.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetFileType,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  PushEventType,
  UserMetadataKey,
} from 'src/enum.js';
import { NotificationService } from 'src/services/notification.service.js';
import { NOTIFICATION_CATALOGS, type NotificationCatalogs } from 'src/utils/notification-locale.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { notificationStub } from 'test/fixtures/notification.stub.js';
import localeFixtures from 'test/fixtures/system-notification-locale.json' with { type: 'json' };
import { userStub } from 'test/fixtures/user.stub.js';
import { getForAlbum } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const configs = {
  smtpDisabled: Object.freeze<SystemConfig>({
    ...defaults,
    notifications: {
      smtp: {
        ...defaults.notifications.smtp,
        enabled: false,
      },
    },
  }),
  smtpEnabled: Object.freeze<SystemConfig>({
    ...defaults,
    notifications: {
      smtp: {
        ...defaults.notifications.smtp,
        enabled: true,
      },
    },
  }),
  smtpTransport: Object.freeze<SystemConfig>({
    ...defaults,
    notifications: {
      smtp: {
        ...defaults.notifications.smtp,
        enabled: true,
        transport: {
          ignoreCert: false,
          host: 'localhost',
          port: 587,
          secure: false,
          username: 'test',
          password: 'test',
        },
      },
    },
  }),
};

describe(NotificationService.name, () => {
  let sut: NotificationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(NotificationService));
    mocks.user.getMetadata.mockResolvedValue([]);
    // Existing positive fixtures represent a current authorized owner; individual refusals override it.
    mocks.access.album.checkOwnerAccess.mockImplementation((_user, ids) => Promise.resolve(new Set(ids)));
    mocks.access.asset.checkOwnerAccess.mockImplementation((_user, ids) => Promise.resolve(new Set(ids)));
  });

  it('awaits client restart publication before sending and awaiting the worker restart', async () => {
    let delivered!: () => void;
    let committed!: () => void;
    mocks.websocket.clientBroadcastAndFlush.mockImplementation(
      () => new Promise<void>((resolve) => (delivered = resolve)),
    );
    mocks.websocket.serverSendAndFlush.mockImplementation(() => new Promise<void>((resolve) => (committed = resolve)));
    let settled = false;
    const restart = sut.onAppRestart({ isMaintenanceMode: true }).then(() => (settled = true));
    expect(mocks.websocket.serverSendAndFlush).not.toHaveBeenCalled();
    delivered();
    await Promise.resolve();
    expect(mocks.websocket.serverSendAndFlush).toHaveBeenCalledWith('AppRestart', { isMaintenanceMode: true });
    expect(settled).toBe(false);
    committed();
    await restart;
    expect(settled).toBe(true);
  });

  it('does not send the worker restart after client publication fails', async () => {
    const error = new Error('publication unavailable');
    mocks.websocket.clientBroadcastAndFlush.mockRejectedValueOnce(error);
    await expect(sut.onAppRestart({ isMaintenanceMode: true })).rejects.toBe(error);
    expect(mocks.websocket.serverSendAndFlush).not.toHaveBeenCalled();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  it('persists origin-rendered text without template metadata and falls back when locale lookup fails (FL-329)', async () => {
    mocks.user.get.mockResolvedValue({
      ...userStub.user1,
      metadata: [
        {
          key: UserMetadataKey.Preferences,
          value: {
            emailNotifications: { enabled: false },
          },
        },
      ],
    } as never);
    mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);
    mocks.user.getMetadata.mockResolvedValue([
      {
        key: UserMetadataKey.Preferences,
        value: {
          notifications: { locale: 'en-XA' },
        },
      },
    ]);
    const event = { ownerId: 'owner', userId: userStub.user1.id, senderName: 'Zoë', count: 1, link: null };
    NOTIFICATION_CATALOGS['en-XA'] = (localeFixtures.catalogs as NotificationCatalogs)['en-XA'];
    try {
      await sut.onItemShare(event);
      const first = mocks.notification.create.mock.calls[0][0];
      expect(first).toMatchObject({ title: '[Fixture shared]', description: '[Fixture Zoë shared one item]' });
      expect(first).not.toHaveProperty('systemTemplate');
      mocks.user.getMetadata.mockRejectedValue(new Error('locale lookup unavailable'));
      await sut.onItemShare(event);
      expect(mocks.notification.create.mock.calls[1][0]).toMatchObject({
        title: 'Shared with you',
        description: 'Zoë shared an item with you',
      });
    } finally {
      delete NOTIFICATION_CATALOGS['en-XA'];
    }
  });

  describe('notifyAdmins (FL-155)', () => {
    const notice = {
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Warning,
      title: 'This server cannot reach Frameleaf Cloud',
      description: 'The last 3 check-ins failed.',
      dedupeKey: 'frameleaf-cloud:heartbeat-failing',
      dedupeDays: 1,
    };

    it('notifies every administrator and tags the notice with its dedupe key', async () => {
      const [first, second] = [UserFactory.create({ isAdmin: true }), UserFactory.create({ isAdmin: true })];
      mocks.user.getAdmins.mockResolvedValue([first, second] as never);
      mocks.notification.findRecentByDedupeKey.mockResolvedValue(null);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);

      await expect(sut.notifyAdmins(notice)).resolves.toBe(2);
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: first.id, data: { dedupeKey: notice.dedupeKey } }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_notification', second.id, expect.anything());
      expect(mocks.user.getMetadata).not.toHaveBeenCalled();
    });

    it('skips an administrator who already got the same notice within the window', async () => {
      const [first, second] = [UserFactory.create({ isAdmin: true }), UserFactory.create({ isAdmin: true })];
      mocks.user.getAdmins.mockResolvedValue([first, second] as never);
      mocks.notification.findRecentByDedupeKey.mockImplementation((userId) =>
        Promise.resolve(userId === first.id ? { id: 'n1' } : null),
      );
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);

      await expect(sut.notifyAdmins(notice)).resolves.toBe(1);
      expect(mocks.notification.create).toHaveBeenCalledTimes(1);
      const since = mocks.notification.findRecentByDedupeKey.mock.calls[0][2];
      expect(Date.now() - since.getTime()).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(Date.now() - since.getTime()).toBeLessThan(25 * 60 * 60 * 1000);
    });

    it('renders current account locales per administrator after dedupe without persisting descriptors (FL-329)', async () => {
      const [first, second, skipped] = Array.from({ length: 3 }, () => UserFactory.create({ isAdmin: true }));
      const error = 'unavailable <b>now</b> $& {count}';
      const registered: AdminNotice = {
        ...notice,
        description: `The last 3 check-ins failed (${error}). Cloud features may pause; local features keep working.`,
        systemTemplate: { version: 1, key: 'cloud-heartbeat-failed', args: { count: 3, error } },
      };
      mocks.user.getAdmins.mockResolvedValue([first, second, skipped] as never);
      mocks.notification.findRecentByDedupeKey.mockImplementation((userId) =>
        Promise.resolve(userId === skipped.id ? { id: 'n1' } : null),
      );
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);
      mocks.user.getMetadata.mockImplementation((userId) =>
        Promise.resolve([
          {
            key: UserMetadataKey.Preferences,
            value: {
              notifications: {
                locale: userId === first.id ? 'en-XA' : 'fr-CA',
                devices: [{ sessionId: newUuid(), locale: 'fr-CA' }],
              },
            },
          },
        ]),
      );
      NOTIFICATION_CATALOGS['en-XA'] = (localeFixtures.catalogs as NotificationCatalogs)['en-XA'];
      try {
        await expect(sut.notifyAdmins(registered)).resolves.toBe(2);
        expect(mocks.notification.create.mock.calls.map(([item]) => item)).toEqual([
          {
            userId: first.id,
            type: registered.type,
            level: registered.level,
            title: `[Fixture ${registered.title}]`,
            description: `[Fixture ${registered.description}]`,
            data: { dedupeKey: registered.dedupeKey },
          },
          {
            userId: second.id,
            type: registered.type,
            level: registered.level,
            title: registered.title,
            description: registered.description,
            data: { dedupeKey: registered.dedupeKey },
          },
        ]);
        expect(mocks.user.getMetadata.mock.calls).toEqual([[first.id], [second.id]]);
        expect(mocks.websocket.clientSend).toHaveBeenCalledTimes(2);

        mocks.user.getAdmins.mockResolvedValue([first] as never);
        mocks.user.getMetadata.mockRejectedValue(new Error('locale lookup unavailable'));
        await sut.notifyAdmins(registered);
        expect(mocks.notification.create).toHaveBeenLastCalledWith(
          expect.objectContaining({ title: registered.title, description: registered.description }),
        );
        mocks.notification.create.mockRejectedValue(new Error('storage unavailable'));
        await expect(sut.onAdminNotify(registered)).resolves.toBeUndefined();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          `Unable to notify administrators (${registered.title}): Error: storage unavailable`,
        );
        expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(error);
      } finally {
        delete NOTIFICATION_CATALOGS['en-XA'];
      }
    });

    it('caps the window at 30 days and always sends a notice without a key', async () => {
      mocks.user.getAdmins.mockResolvedValue([UserFactory.create({ isAdmin: true })] as never);
      mocks.notification.findRecentByDedupeKey.mockResolvedValue(null);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);

      await sut.notifyAdmins({ ...notice, dedupeDays: 365 });
      const since = mocks.notification.findRecentByDedupeKey.mock.calls[0][2];
      expect(Date.now() - since.getTime()).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 1000);

      mocks.notification.findRecentByDedupeKey.mockClear();
      await sut.notifyAdmins({ ...notice, dedupeKey: undefined });
      expect(mocks.notification.findRecentByDedupeKey).not.toHaveBeenCalled();
      expect(mocks.notification.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: null }));
    });
  });

  describe('onConfigUpdate', () => {
    it('waits for configuration reconciliation before completing the update', async () => {
      let finish!: () => void;
      const reconcile = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      Reflect.set(mocks.websocket, 'awaitConfigUpdate', reconcile);
      const update = { oldConfig: defaults, newConfig: defaults };
      let completed = false;
      const pending = Promise.resolve(sut.onConfigUpdate(update)).then(() => (completed = true));
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(mocks.websocket.clientBroadcast).toHaveBeenCalledWith('on_config_update');
      expect(reconcile).toHaveBeenCalledWith(update);
      finish();
      await pending;
      expect(completed).toBe(true);
    });

    it('propagates failed remote reconciliation to the configuration caller', async () => {
      const failure = new Error('Remote configuration reconciliation failed');
      const reconcile = vi.fn().mockRejectedValue(failure);
      Reflect.set(mocks.websocket, 'awaitConfigUpdate', reconcile);
      await expect(Promise.try(() => sut.onConfigUpdate({ oldConfig: defaults, newConfig: defaults }))).rejects.toBe(
        failure,
      );
    });
  });

  describe('onConfigValidateEvent', () => {
    it('validates smtp config when enabling smtp', async () => {
      const oldConfig = configs.smtpDisabled;
      const newConfig = configs.smtpEnabled;

      mocks.email.verifySmtp.mockResolvedValue(true);
      await expect(sut.onConfigValidate({ oldConfig, newConfig })).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).toHaveBeenCalledWith(newConfig.notifications.smtp.transport);
    });

    it('validates smtp config when transport changes', async () => {
      const oldConfig = configs.smtpEnabled;
      const newConfig = configs.smtpTransport;

      mocks.email.verifySmtp.mockResolvedValue(true);
      await expect(sut.onConfigValidate({ oldConfig, newConfig })).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).toHaveBeenCalledWith(newConfig.notifications.smtp.transport);
    });

    it('skips smtp validation when there are no changes', async () => {
      const oldConfig = { ...configs.smtpEnabled };
      const newConfig = { ...configs.smtpEnabled };

      await expect(sut.onConfigValidate({ oldConfig, newConfig })).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).not.toHaveBeenCalled();
    });

    it('skips smtp validation with DTO when there are no changes', async () => {
      const oldConfig = { ...configs.smtpEnabled };
      const newConfig = configs.smtpEnabled as AdminConfigDto;

      await expect(sut.onConfigValidate({ oldConfig, newConfig })).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).not.toHaveBeenCalled();
    });

    it('skips smtp validation when smtp is disabled', async () => {
      const oldConfig = { ...configs.smtpEnabled };
      const newConfig = { ...configs.smtpDisabled };

      await expect(sut.onConfigValidate({ oldConfig, newConfig })).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).not.toHaveBeenCalled();
    });

    it('should fail if smtp configuration is invalid', async () => {
      const oldConfig = configs.smtpDisabled;
      const newConfig = configs.smtpEnabled;

      mocks.email.verifySmtp.mockRejectedValue(new Error('Failed validating smtp'));
      await expect(sut.onConfigValidate({ oldConfig, newConfig })).rejects.toBeInstanceOf(Error);
    });
  });

  describe('onJobError (FL-71)', () => {
    beforeEach(() => {
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    });

    it.each([
      { name: JobName.NotifyUserSignup, data: { id: 'user-1', password: 'hunter2-secret' } },
      { name: JobName.SendMail, data: { to: 'a@b.c', subject: 's', html: 'hunter2-secret', text: 'hunter2-secret' } },
      {
        name: JobName.PushDeliver,
        data: {
          notice: {
            type: PushEventType.SharedActivity,
            title: 'private title',
            body: 'hunter2-secret',
            systemTemplate: { version: 1, key: 'item-share-one', args: { senderName: 'hunter2-secret' } },
          },
        },
      },
    ] satisfies JobItem[])('never logs the data of a $name job, which carries a password', async (job) => {
      await sut.onJobError({ job, error: new Error('smtp down') });

      expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(String), '[redacted]');
      expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain('hunter2-secret');
    });

    it('still logs the data of other jobs', async () => {
      const job = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } } as const;
      await sut.onJobError({ job, error: new Error('Input file is missing') });

      expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(String), JSON.stringify(job.data));
    });
  });

  it.each([undefined, 'Zoë'])('renders an album invitation with sender %s (FL-329)', async (senderName) => {
    const album = AlbumFactory.create({ albumName: 'Lake <b>trip</b> $& {senderName}' });
    mocks.notification.create.mockResolvedValue(notificationStub.albumEvent as never);

    await sut['sendAlbumLocalNotification'](
      { ...album, assets: [], albumUsers: [], sharedLinks: [] },
      userStub.user1.id,
      NotificationType.AlbumInvite,
      senderName,
    );

    expect(mocks.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Shared Album Invitation',
        description:
          senderName === undefined
            ? `An album (${album.albumName}) was shared with you`
            : `${senderName} shared an album (${album.albumName}) with you`,
      }),
    );
  });

  describe('onAssetHide', () => {
    it('should send connected clients an event', () => {
      sut.onAssetHide({ assetId: 'asset-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_hidden', 'user-id', 'asset-id');
    });
  });

  describe('onAssetShow', () => {
    it('should queue the generate thumbnail job', async () => {
      await sut.onAssetShow({ assetId: 'asset-id', userId: 'user-id' });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetGenerateThumbnails,
        data: { id: 'asset-id', notify: true },
      });
    });
  });

  describe('onUserSignupEvent', () => {
    it('skips when notify is false', async () => {
      await sut.onUserSignup({ id: '', notify: false });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should queue notify signup event if notify is true', async () => {
      await sut.onUserSignup({ id: '', notify: true });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.NotifyUserSignup,
        data: { id: '', password: undefined },
      });
    });
  });

  describe('onAlbumUpdateEvent', () => {
    it('should send a websocket event to every user and queue notify jobs for recipients', async () => {
      await sut.onAlbumUpdate({ id: 'album', userIds: ['1', '42'], recipientIds: ['42'] });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_album_update', '1', 'album');
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_album_update', '42', 'album');
      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.NotifyAlbumUpdate,
        data: { id: 'album', recipientId: '42', delay: 300_000 },
      });
    });

    it('should not queue email jobs when there are no recipients', async () => {
      await sut.onAlbumUpdate({ id: 'album', userIds: ['1'], recipientIds: [] });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_album_update', '1', 'album');
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('onAlbumInviteEvent', () => {
    it('should queue notify album invite event', async () => {
      await sut.onAlbumInvite({ id: '', userId: '42', senderName: 'foo' });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.NotifyAlbumInvite,
        data: { id: '', recipientId: '42', senderName: 'foo' },
      });
    });
  });

  describe('onSharedSpaceReply', () => {
    it('tells the author of the answered comment in the app only, never by email', async () => {
      const album = AlbumFactory.create({ albumName: 'Family' });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);

      await sut.onSharedSpaceReply({
        id: album.id,
        assetId: null,
        activityId: 'reply-1',
        parentActivityId: 'comment-1',
        userId: '42',
        senderName: 'Bo',
      });

      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '42',
          type: 'SharedSpaceReply',
          description: 'Bo replied to your comment in Family',
          data: JSON.stringify({
            albumId: album.id,
            assetId: null,
            activityId: 'reply-1',
            parentActivityId: 'comment-1',
          }),
        }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_notification', '42', expect.anything());
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does nothing once the space is gone', async () => {
      mocks.album.getById.mockResolvedValue(void 0);

      await sut.onSharedSpaceReply({
        id: newUuid(),
        assetId: null,
        activityId: 'reply-1',
        parentActivityId: 'comment-1',
        userId: '42',
        senderName: 'Bo',
      });

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('onSessionDeleteEvent', () => {
    it('should send a on_session_delete client event', () => {
      vi.useFakeTimers();
      sut.onSessionDelete({ sessionId: 'id' });
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);

      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_delete', 'id', 'id');
    });
  });

  describe('onAssetTrash', () => {
    it('should send connected clients an websocket', () => {
      sut.onAssetTrash({ assetId: 'asset-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_trash', 'user-id', ['asset-id']);
    });
  });

  describe('onAssetDelete', () => {
    it('should send connected clients an event', () => {
      sut.onAssetDelete({ assetId: 'asset-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_delete', 'user-id', 'asset-id');
    });
  });

  describe('onAssetsTrash', () => {
    it('should send connected clients an event', () => {
      sut.onAssetsTrash({ assetIds: ['asset-id'], userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_trash', 'user-id', ['asset-id']);
    });
  });

  describe('onAssetsRestore', () => {
    it('should send connected clients an event', () => {
      sut.onAssetsRestore({ assetIds: ['asset-id'], userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_restore', 'user-id', ['asset-id']);
    });
  });

  describe('onStackCreate', () => {
    it('should send connected clients an event', () => {
      sut.onStackCreate({ stackId: 'stack-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', 'user-id');
    });
  });

  describe('onStackUpdate', () => {
    it('should send connected clients an event', () => {
      sut.onStackUpdate({ stackId: 'stack-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', 'user-id');
    });
  });

  describe('onStackDelete', () => {
    it('should send connected clients an event', () => {
      sut.onStackDelete({ stackId: 'stack-id', userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', 'user-id');
    });
  });

  describe('onStacksDelete', () => {
    it('should send connected clients an event', () => {
      sut.onStacksDelete({ stackIds: ['stack-id'], userId: 'user-id' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', 'user-id');
    });
  });

  describe('handleUserSignup', () => {
    it('should skip if user could not be found', async () => {
      await expect(sut.handleUserSignup({ id: '' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should be successful', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });

      await expect(sut.handleUserSignup({ id: '' })).resolves.toBe(JobStatus.Success);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({ subject: 'Welcome to Frameleaf' }),
      });
    });
  });

  describe('onItemShare (FL-83 AL-30b)', () => {
    const event = { ownerId: 'owner-1', userId: 'user-1', senderName: 'Taylor', count: 2, link: 'https://x/sharing' };
    const withPrefs = (albumInvite: boolean) =>
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [{ key: UserMetadataKey.Preferences, value: { emailNotifications: { enabled: true, albumInvite } } }],
      });

    it('notifies the recipient in the app, with the link and no item details', async () => {
      withPrefs(false);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);

      await sut.onItemShare(event);

      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: NotificationType.ItemShare,
          description: 'Taylor shared 2 items with you',
          data: JSON.stringify({ ownerId: 'owner-1', count: 2, link: 'https://x/sharing' }),
        }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_notification', 'user-1', expect.anything());
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('emails the recipient when they allow album invitation emails', async () => {
      withPrefs(true);
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });

      await sut.onItemShare({ ...event, count: 1 });

      expect(mocks.email.renderEmail).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ count: 1, link: 'https://x/sharing' }) }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({ subject: 'Taylor shared an item with you' }),
      });
    });

    it('does nothing for a recipient who is gone', async () => {
      mocks.user.get.mockResolvedValue(void 0);
      await sut.onItemShare(event);
      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });

  it('notifies a pending shared-space invitee without attaching private media and drops withdrawn invites', async () => {
    const album = AlbumFactory.create({ kind: AlbumKind.Space, albumThumbnailAssetId: newUuid() });
    const recipient = {
      ...userStub.user1,
      metadata: [
        { key: UserMetadataKey.Preferences, value: { emailNotifications: { enabled: true, albumInvite: true } } },
      ],
    };
    mocks.album.getById.mockResolvedValue(getForAlbum(album));
    mocks.user.get.mockResolvedValue(recipient as never);
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
    mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
    mocks.albumUser.getInvite.mockResolvedValue({
      albumId: album.id,
      userId: recipient.id,
      role: AlbumUserRole.Editor,
      invitedById: null,
      createdAt: new Date(),
    });
    mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
    mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
    mocks.systemMetadata.get.mockResolvedValue({ notifications: { smtp: { enabled: true } } });
    await expect(sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: 'Owner' })).resolves.toBe(
      JobStatus.Success,
    );
    expect(mocks.assetJob.getAlbumThumbnailFiles).not.toHaveBeenCalled();
    const queued = mocks.job.queue.mock.calls.find(([job]) => job.name === JobName.SendMail)![0];
    expect(queued.data).toMatchObject({ imageAttachments: undefined });
    mocks.albumUser.getInvite.mockResolvedValue(undefined);
    await expect(sut.handleSendEmail(queued.data as never)).resolves.toBe(JobStatus.Skipped);
    expect(mocks.email.sendEmail).not.toHaveBeenCalled();
  });

  describe('handleAlbumInvite', () => {
    it('should skip if album could not be found', async () => {
      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Skipped,
      );
      expect(mocks.user.get).not.toHaveBeenCalled();
    });

    it('should skip if recipient could not be found', async () => {
      mocks.album.getById.mockResolvedValue(getForAlbum(AlbumFactory.create()));

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Skipped,
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should skip if the recipient has email notifications disabled', async () => {
      mocks.album.getById.mockResolvedValue(getForAlbum(AlbumFactory.create()));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: false, albumInvite: true } },
          },
        ],
      });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Skipped,
      );
    });

    it('should skip if the recipient has email notifications for album invite disabled', async () => {
      mocks.album.getById.mockResolvedValue(getForAlbum(AlbumFactory.create()));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: false } },
          },
        ],
      });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Skipped,
      );
    });

    it('should send invite email', async () => {
      mocks.album.getById.mockResolvedValue(getForAlbum(AlbumFactory.create()));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: true } },
          },
        ],
      });
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Success,
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({ subject: expect.stringContaining('You have been added to a shared album') }),
      });
    });

    it('should send invite email without album thumbnail if thumbnail asset does not exist', async () => {
      const album = AlbumFactory.create({ albumThumbnailAssetId: newUuid() });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: true } },
          },
        ],
      });
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([]);

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Success,
      );
      expect(mocks.assetJob.getAlbumThumbnailFiles).toHaveBeenCalledWith(
        album.albumThumbnailAssetId,
        AssetFileType.Thumbnail,
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({
          subject: expect.stringContaining('You have been added to a shared album'),
          imageAttachments: undefined,
        }),
      });
    });

    it('should send invite email without album thumbnail when thumbnail asset is NSFW', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      const album = AlbumFactory.create({ albumThumbnailAssetId: assetFile.assetId });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: true } },
          },
        ],
      });
      mocks.systemMetadata.get.mockResolvedValue({
        server: {},
        machineLearning: { nsfwDetection: { hideFromLibrary: true } },
      });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([assetFile.assetId]));

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Success,
      );
      expect(mocks.asset.getHiddenContentAssetIds).toHaveBeenCalledWith([album.albumThumbnailAssetId], {
        hiddenContent: {
          userId: userStub.user1.id,
          includeNsfw: true,
          tagIds: [],
          personIds: [],
          petIds: [],
          scope: 'owned',
        },
      });
      expect(mocks.assetJob.getAlbumThumbnailFiles).not.toHaveBeenCalled();
      expect(mocks.email.renderEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cid: undefined }),
        }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({
          subject: expect.stringContaining('You have been added to a shared album'),
          imageAttachments: undefined,
        }),
      });
    });

    it('should send invite email with album thumbnail as jpeg', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      const album = AlbumFactory.create({ albumThumbnailAssetId: assetFile.assetId });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: true } },
          },
        ],
      });
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([assetFile]);

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Success,
      );
      expect(mocks.assetJob.getAlbumThumbnailFiles).toHaveBeenCalledWith(
        album.albumThumbnailAssetId,
        AssetFileType.Thumbnail,
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({
          subject: expect.stringContaining('You have been added to a shared album'),
          imageAttachments: [{ filename: 'album-thumbnail.jpg', path: expect.anything(), cid: expect.anything() }],
        }),
      });
    });

    it('should send invite email with album thumbnail and arbitrary extension', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      const album = AlbumFactory.from({ albumThumbnailAssetId: asset.id })
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        metadata: [
          {
            key: UserMetadataKey.Preferences,
            value: { emailNotifications: { enabled: true, albumInvite: true } },
          },
        ],
      });
      mocks.systemMetadata.get.mockResolvedValue({ server: {} });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([asset.files[0]]);

      await expect(sut.handleAlbumInvite({ id: '', recipientId: '', senderName: 'foo' })).resolves.toBe(
        JobStatus.Success,
      );
      expect(mocks.assetJob.getAlbumThumbnailFiles).toHaveBeenCalledWith(
        album.albumThumbnailAssetId,
        AssetFileType.Thumbnail,
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({
          subject: expect.stringContaining('You have been added to a shared album'),
          imageAttachments: [{ filename: 'album-thumbnail.jpg', path: expect.anything(), cid: expect.anything() }],
        }),
      });
    });
  });

  describe('handleAlbumUpdate', () => {
    it('should skip if album could not be found', async () => {
      await expect(sut.handleAlbumUpdate({ id: '', recipientId: '1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.user.get).not.toHaveBeenCalled();
    });

    it('should skip if owner could not be found', async () => {
      mocks.album.getById.mockResolvedValue(getForAlbum(AlbumFactory.from().owner({ id: 'non-existent' }).build()));

      await expect(sut.handleAlbumUpdate({ id: '', recipientId: '1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
    });

    it('should skip recipient that could not be looked up', async () => {
      const album = AlbumFactory.from().albumUser({ userId: 'non-existent' }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([]);

      await sut.handleAlbumUpdate({ id: '', recipientId: 'non-existent' });
      expect(mocks.user.get).toHaveBeenCalledWith('non-existent', { withDeleted: false });
      expect(mocks.email.renderEmail).not.toHaveBeenCalled();
    });

    it('should skip recipient with disabled email notifications', async () => {
      const user = UserFactory.from()
        .metadata({
          key: UserMetadataKey.Preferences,
          value: { emailNotifications: { enabled: false, albumUpdate: true } },
        })
        .build();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([]);

      await sut.handleAlbumUpdate({ id: '', recipientId: user.id });
      expect(mocks.user.get).toHaveBeenCalledWith(user.id, { withDeleted: false });
      expect(mocks.email.renderEmail).not.toHaveBeenCalled();
    });

    it('should skip recipient with disabled email notifications for the album update event', async () => {
      const user = UserFactory.from()
        .metadata({
          key: UserMetadataKey.Preferences,
          value: { emailNotifications: { enabled: true, albumUpdate: false } },
        })
        .build();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([]);

      await sut.handleAlbumUpdate({ id: '', recipientId: user.id });
      expect(mocks.user.get).toHaveBeenCalledWith(user.id, { withDeleted: false });
      expect(mocks.email.renderEmail).not.toHaveBeenCalled();
    });

    it('should send email', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([]);

      await sut.handleAlbumUpdate({ id: '', recipientId: user.id });
      expect(mocks.user.get).toHaveBeenCalledWith(user.id, { withDeleted: false });
      expect(mocks.email.renderEmail).toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalled();
    });

    it('should send update email without album thumbnail when thumbnail asset is NSFW', async () => {
      const user = UserFactory.create();
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      const album = AlbumFactory.from({ albumThumbnailAssetId: assetFile.assetId })
        .albumUser({ userId: user.id })
        .build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.systemMetadata.get.mockResolvedValue({
        server: {},
        machineLearning: { nsfwDetection: { hideFromLibrary: true } },
      });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([assetFile.assetId]));

      await expect(sut.handleAlbumUpdate({ id: '', recipientId: user.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.asset.getHiddenContentAssetIds).toHaveBeenCalledWith([album.albumThumbnailAssetId], {
        hiddenContent: {
          userId: user.id,
          includeNsfw: true,
          tagIds: [],
          personIds: [],
          petIds: [],
          scope: 'owned',
        },
      });
      expect(mocks.assetJob.getAlbumThumbnailFiles).not.toHaveBeenCalled();
      expect(mocks.email.renderEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cid: undefined }),
        }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SendMail,
        data: expect.objectContaining({
          subject: expect.stringContaining('New media has been added to an album'),
          imageAttachments: undefined,
        }),
      });
    });

    it('should add new recipients for new images if job is already queued', async () => {
      await sut.onAlbumUpdate({ id: '1', userIds: ['2'], recipientIds: ['2'] });
      expect(mocks.job.removeJob).toHaveBeenCalledWith(JobName.NotifyAlbumUpdate, '1/2');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.NotifyAlbumUpdate,
        data: {
          id: '1',
          delay: 300_000,
          recipientId: '2',
        },
      });
    });
  });

  describe('handleSendEmail', () => {
    it('should skip if smtp notifications are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ notifications: { smtp: { enabled: false } } });
      await expect(sut.handleSendEmail({ html: '', subject: '', text: '', to: '' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should send mail successfully', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        notifications: { smtp: { enabled: true, from: 'test@immich.app' } },
      });
      mocks.email.sendEmail.mockResolvedValue({ messageId: '', response: '' });

      await expect(sut.handleSendEmail({ html: '', subject: '', text: '', to: '' })).resolves.toBe(JobStatus.Success);
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'test@immich.app' }));
    });

    it('should send mail with replyTo successfully', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        notifications: { smtp: { enabled: true, from: 'test@immich.app', replyTo: 'demo@immich.app' } },
      });
      mocks.email.sendEmail.mockResolvedValue({ messageId: '', response: '' });

      await expect(sut.handleSendEmail({ html: '', subject: '', text: '', to: '' })).resolves.toBe(JobStatus.Success);
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'demo@immich.app' }));
    });
  });
  describe('queued album current authority (FL-137)', () => {
    const album = getForAlbum(AlbumFactory.create());
    const recipient = userStub.user1;
    const context = { albumId: album.id, recipientId: recipient.id, kind: 'update' as const };
    const mail = {
      to: recipient.email,
      subject: 'New media has been added to an album - private',
      html: 'old private body',
      text: 'old private text',
      albumMailContext: context,
      imageAttachments: [{ path: '/old/private.webp', filename: 'old.webp', cid: 'album-thumbnail' }],
    };
    beforeEach(() => {
      mocks.album.getById.mockResolvedValue(album);
      mocks.user.get.mockResolvedValue(recipient);
      mocks.systemMetadata.get.mockResolvedValue({ notifications: { smtp: { enabled: true } } });
      mocks.notification.create.mockResolvedValue(notificationStub.albumEvent);
      mocks.email.renderEmail.mockResolvedValue({ html: 'current body', text: 'current text' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: '', response: '' });
      mocks.access.album.checkOwnerAccess.mockImplementation((_user, ids) => Promise.resolve(new Set(ids)));
    });
    it.each(['invite', 'update'] as const)(
      'refuses a queued %s after membership revocation before notification/render',
      async (kind) => {
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
        const result =
          kind === 'invite'
            ? await sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: 'Owner' })
            : await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
        expect(result).toBe(JobStatus.Skipped);
        expect(mocks.notification.create).not.toHaveBeenCalled();
        expect(mocks.email.renderEmail).not.toHaveBeenCalled();
        expect(mocks.job.queue).not.toHaveBeenCalled();
      },
    );
    it('refuses already prepared album mail after membership revocation', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
    it('rebuilds prepared mail rather than sending the old body or attachment path', async () => {
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Success);
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ html: 'current body', text: 'current text', imageAttachments: undefined }),
      );
    });
    it('rechecks membership after asynchronous rendering before sending', async () => {
      mocks.email.renderEmail.mockImplementation(() => {
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
        return Promise.resolve({ html: 'current body', text: 'current text' });
      });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
    it('does not read a thumbnail file when actual current access is refused', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      mocks.album.getById.mockResolvedValue({ ...album, albumThumbnailAssetId: assetFile.assetId });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.assetJob.getAlbumThumbnailFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ imageAttachments: undefined }) }),
      );
    });
    it('refuses a selected thumbnail locked while its mail is rendering', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      mocks.album.getById.mockResolvedValue({ ...album, albumThumbnailAssetId: assetFile.assetId });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValue([assetFile]);
      mocks.email.renderEmail.mockImplementation(() => {
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
        return Promise.resolve({ html: 'current body', text: 'current text' });
      });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
    it('rechecks membership after the final attachment lookup', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      mocks.album.getById.mockResolvedValue({ ...album, albumThumbnailAssetId: assetFile.assetId });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValueOnce([assetFile]).mockImplementationOnce(() => {
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
        return Promise.resolve([assetFile]);
      });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
    it('rechecks actual access after the final attachment lookup', async () => {
      const assetFile = AssetFileFactory.create({ type: AssetFileType.Thumbnail });
      mocks.album.getById.mockResolvedValue({ ...album, albumThumbnailAssetId: assetFile.assetId });
      mocks.assetJob.getAlbumThumbnailFiles.mockResolvedValueOnce([assetFile]).mockImplementationOnce(() => {
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
        return Promise.resolve([assetFile]);
      });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
    it.each([
      { subject: 'You have been added to a shared album - secret' },
      { subject: 'New media has been added to an album - secret' },
      { subject: 'old custom album subject', imageAttachments: mail.imageAttachments },
    ])('fails closed on a known unbound legacy album payload %j', async (legacy) => {
      await expect(
        sut.handleSendEmail({ to: recipient.email, html: 'private', text: 'private', ...legacy }),
      ).resolves.toBe(JobStatus.Skipped);
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });
  });
});
