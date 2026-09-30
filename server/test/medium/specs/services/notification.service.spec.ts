import { Kysely } from 'kysely';
import {
  AlbumUserRole,
  AssetFileType,
  AssetLockReason,
  AssetMetadataKey,
  JobName,
  JobStatus,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EmailRepository } from 'src/repositories/email.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { NotificationService } from 'src/services/notification.service.js';
import { IEmailJob } from 'src/types.js';
import { clearConfigCache } from 'src/utils/config.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(NotificationService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AssetJobRepository,
      AssetRepository,
      ConfigRepository,
      NotificationRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [EmailRepository, EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });

  ctx.getMock(EmailRepository).renderEmail.mockResolvedValue({ html: '<html></html>', text: 'text' });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();

  return { sut, ctx };
};

const nsfwMetadata = (isNsfw: boolean) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
  },
});

const enableNsfwHiding = async (ctx: MediumTestContext) => {
  const config = await ctx.getConfig();
  await ctx.updateConfig({
    ...config,
    machineLearning: {
      ...config.machineLearning,
      nsfwDetection: { ...config.machineLearning.nsfwDetection, hideFromLibrary: true },
    },
  });
  clearConfigCache();
};

const newAlbumWithThumbnail = async (ctx: MediumTestContext, { isNsfw }: { isNsfw: boolean }) => {
  const { user: owner } = await ctx.newUser();
  const { user: recipient } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: '/path/to/thumbnail.webp' });
  if (isNsfw) {
    await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });
  }
  const { album } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: asset.id }, [asset.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: recipient.id });
  return { owner, recipient, asset, album };
};

const getQueuedSendMail = (ctx: MediumTestContext) => {
  const calls = ctx.getMock(JobRepository).queue.mock.calls.filter(([job]) => job.name === JobName.SendMail);
  expect(calls).toHaveLength(1);
  return calls[0][0].data as IEmailJob;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(() => {
  clearConfigCache();
});

describe(NotificationService.name, () => {
  describe('handleAlbumInvite', () => {
    it('should blank the album thumbnail when it is NSFW', async () => {
      const { sut, ctx } = setup();
      await enableNsfwHiding(ctx);
      const { recipient, album, owner } = await newAlbumWithThumbnail(ctx, { isNsfw: true });

      await sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: owner.name });

      expect(getQueuedSendMail(ctx).imageAttachments).toBeUndefined();
    });

    it('should keep the album thumbnail when it is safe', async () => {
      const { sut, ctx } = setup();
      await enableNsfwHiding(ctx);
      const { recipient, album, owner } = await newAlbumWithThumbnail(ctx, { isNsfw: false });

      await sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: owner.name });

      expect(getQueuedSendMail(ctx).imageAttachments).toEqual([
        expect.objectContaining({ path: '/path/to/thumbnail.webp', cid: 'album-thumbnail' }),
      ]);
    });
  });

  describe('handleAlbumUpdate', () => {
    it('should blank the album thumbnail when it is NSFW', async () => {
      const { sut, ctx } = setup();
      await enableNsfwHiding(ctx);
      const { recipient, album } = await newAlbumWithThumbnail(ctx, { isNsfw: true });

      await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });

      expect(getQueuedSendMail(ctx).imageAttachments).toBeUndefined();
    });

    it('should keep the album thumbnail when it is safe', async () => {
      const { sut, ctx } = setup();
      await enableNsfwHiding(ctx);
      const { recipient, album } = await newAlbumWithThumbnail(ctx, { isNsfw: false });

      await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });

      expect(getQueuedSendMail(ctx).imageAttachments).toEqual([
        expect.objectContaining({ path: '/path/to/thumbnail.webp', cid: 'album-thumbnail' }),
      ]);
    });
  });
});

/** Actual access/asset_lock/album_user state; only mail transport is a no-send fixture. */
describe('queued album delivery current authority (FL-137)', () => {
  const enableAlbumMailFixture = async (ctx: MediumTestContext) => {
    const config = await ctx.getConfig();
    await ctx.updateConfig({
      ...config,
      notifications: { ...config.notifications, smtp: { ...config.notifications.smtp, enabled: true } },
    });
    clearConfigCache();
    ctx.getMock(EmailRepository).sendEmail.mockResolvedValue({ messageId: 'fixture', response: 'fixture' });
  };

  it.each(['invite', 'update'] as const)(
    'refuses a queued %s after its member is removed, before local notification or mail',
    async (kind) => {
      const { sut, ctx } = setup();
      const { album, recipient, owner } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
      await defaultDatabase
        .deleteFrom('album_user')
        .where('albumId', '=', album.id)
        .where('userId', '=', recipient.id)
        .execute();
      const result =
        kind === 'invite'
          ? await sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: owner.name })
          : await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
      expect(result).toBe(JobStatus.Skipped);
      expect(await ctx.get(NotificationRepository).search(recipient.id, {})).toEqual([]);
      expect(ctx.getMock(EmailRepository).renderEmail).not.toHaveBeenCalled();
      expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    },
  );

  it.each(['invite', 'update'] as const)(
    'blanks an actual Marked Lock before queued %s attachment selection, with no classifier preferences',
    async (kind) => {
      const { sut, ctx } = setup();
      const { album, recipient, owner, asset } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
      await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.id);
      const result =
        kind === 'invite'
          ? await sut.handleAlbumInvite({ id: album.id, recipientId: recipient.id, senderName: owner.name })
          : await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
      expect(result).toBe(JobStatus.Success);
      expect(getQueuedSendMail(ctx).imageAttachments).toBeUndefined();
      expect(ctx.getMock(EmailRepository).renderEmail).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cid: undefined }) }),
      );
    },
  );

  it.each([AlbumUserRole.Owner, AlbumUserRole.Editor, AlbumUserRole.Viewer])(
    'delivers current safe album mail to %s',
    async (role) => {
      const { sut, ctx } = setup();
      await enableAlbumMailFixture(ctx);
      const { album, recipient, owner } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
      const userId = role === AlbumUserRole.Owner ? owner.id : recipient.id;
      if (role !== AlbumUserRole.Owner)
        await defaultDatabase
          .updateTable('album_user')
          .set({ role })
          .where('albumId', '=', album.id)
          .where('userId', '=', userId)
          .execute();
      await expect(sut.handleAlbumUpdate({ id: album.id, recipientId: userId })).resolves.toBe(JobStatus.Success);
      const mail = getQueuedSendMail(ctx);
      expect(mail.albumMailContext).toEqual({ albumId: album.id, recipientId: userId, kind: 'update' });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Success);
      expect(ctx.getMock(EmailRepository).sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ imageAttachments: [expect.objectContaining({ path: '/path/to/thumbnail.webp' })] }),
      );
    },
  );

  it('refuses prepared SendMail after current membership revocation', async () => {
    const { sut, ctx } = setup();
    await enableAlbumMailFixture(ctx);
    const { album, recipient } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
    await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
    const mail = getQueuedSendMail(ctx);
    await defaultDatabase
      .deleteFrom('album_user')
      .where('albumId', '=', album.id)
      .where('userId', '=', recipient.id)
      .execute();
    await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
    expect(ctx.getMock(EmailRepository).sendEmail).not.toHaveBeenCalled();
  });

  it('rebuilds prepared SendMail after an actual Lock, never forwarding its captured path', async () => {
    const { sut, ctx } = setup();
    await enableAlbumMailFixture(ctx);
    const { album, recipient, owner, asset } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
    await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
    const mail = getQueuedSendMail(ctx);
    expect(mail.imageAttachments).toHaveLength(1);
    await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.id);
    await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Success);
    expect(ctx.getMock(EmailRepository).sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ imageAttachments: undefined }),
    );
  });

  it.each(['revoke', 'Lock'] as const)(
    'refuses prepared mail if %s commits during final template rendering',
    async (mutation) => {
      const { sut, ctx } = setup();
      await enableAlbumMailFixture(ctx);
      const { album, recipient, owner, asset } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
      await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
      const mail = getQueuedSendMail(ctx);
      ctx.getMock(EmailRepository).renderEmail.mockImplementationOnce(async () => {
        if (mutation === 'revoke')
          await defaultDatabase
            .deleteFrom('album_user')
            .where('albumId', '=', album.id)
            .where('userId', '=', recipient.id)
            .execute();
        else await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.id);
        return { html: 'fixture', text: 'fixture' };
      });
      await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
      expect(ctx.getMock(EmailRepository).sendEmail).not.toHaveBeenCalled();
    },
  );

  it('refuses a Lock committed during the final actual thumbnail lookup', async () => {
    const { sut, ctx } = setup();
    await enableAlbumMailFixture(ctx);
    const { album, recipient, owner, asset } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
    await sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id });
    const mail = getQueuedSendMail(ctx);
    const files = ctx.get(AssetJobRepository);
    const original = files.getAlbumThumbnailFiles.bind(files);
    let reads = 0;
    vi.spyOn(files, 'getAlbumThumbnailFiles').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++reads === 2) await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.id);
      return result;
    });
    await expect(sut.handleSendEmail(mail)).resolves.toBe(JobStatus.Skipped);
    expect(reads).toBe(2);
    expect(ctx.getMock(EmailRepository).sendEmail).not.toHaveBeenCalled();
  });

  it('keeps the owner rule-only explicit album share eligible for delivery', async () => {
    const { sut, ctx } = setup();
    await enableAlbumMailFixture(ctx);
    const { album, recipient, owner, asset } = await newAlbumWithThumbnail(ctx, { isNsfw: false });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Owner private rule' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    await defaultDatabase
      .insertInto('user_metadata')
      .values({
        userId: owner.id,
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
      } as never)
      .execute();
    await expect(sut.handleAlbumUpdate({ id: album.id, recipientId: recipient.id })).resolves.toBe(JobStatus.Success);
    await expect(sut.handleSendEmail(getQueuedSendMail(ctx))).resolves.toBe(JobStatus.Success);
    expect(ctx.getMock(EmailRepository).sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ imageAttachments: [expect.objectContaining({ cid: 'album-thumbnail' })] }),
    );
  });

  it.each(['Welcome to Frameleaf', 'Someone shared an item with you'])(
    'preserves unbound generic mail %s',
    async (subject) => {
      const { sut, ctx } = setup();
      await enableAlbumMailFixture(ctx);
      await expect(
        sut.handleSendEmail({ to: 'fixture@example.test', subject, html: 'generic', text: 'generic' }),
      ).resolves.toBe(JobStatus.Success);
      expect(ctx.getMock(EmailRepository).sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ subject, html: 'generic', imageAttachments: undefined }),
      );
    },
  );
});
