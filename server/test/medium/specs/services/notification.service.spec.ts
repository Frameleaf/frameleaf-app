import { Kysely } from 'kysely';
import { AssetFileType, AssetMetadataKey, JobName } from 'src/enum.js';
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
import { clearConfigCache } from 'src/utils/config.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(NotificationService, {
    database: db || defaultDatabase,
    real: [
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
  const { album } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: asset.id });
  await ctx.newAlbumUser({ albumId: album.id, userId: recipient.id });
  return { owner, recipient, asset, album };
};

const getQueuedSendMail = (ctx: MediumTestContext) => {
  const calls = ctx.getMock(JobRepository).queue.mock.calls.filter(([job]) => job.name === JobName.SendMail);
  expect(calls).toHaveLength(1);
  return calls[0][0].data as { imageAttachments?: unknown[] };
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
