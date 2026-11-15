import { ForbiddenException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumActionsService } from 'src/services/album-actions.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumActionsService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      ClassificationRepository,
      PartnerOriginRepository,
      PartnerRepository,
      SmartAlbumRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return services;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumActionsService.name, () => {
  describe('moveAssets', () => {
    it('moves membership only: the photo leaves one album, joins the other and is never trashed', async () => {
      const { sut, ctx } = setup();
      const albums = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album: source } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: target } = await ctx.newAlbum({ ownerId: user.id });
      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.moveAssets(auth, source.id, { targetAlbumId: target.id, assetIds: [asset.id] }),
      ).resolves.toEqual([{ id: asset.id, success: true }]);

      await expect(albums.getAssetIds(source.id, [asset.id])).resolves.toEqual(new Set());
      await expect(albums.getAssetIds(target.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ deletedAt: null });
    });

    it('rolls back the addition when the removal fails', async () => {
      const { sut, ctx } = setup();
      const albums = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album: source } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: target } = await ctx.newAlbum({ ownerId: user.id });
      const auth = factory.auth({ user: { id: user.id } });
      const failing = vi.spyOn(AlbumRepository.prototype, 'removeAssetIds').mockRejectedValueOnce(new Error('boom'));

      try {
        await expect(
          sut.moveAssets(auth, source.id, { targetAlbumId: target.id, assetIds: [asset.id] }),
        ).rejects.toThrow('boom');
      } finally {
        failing.mockRestore();
      }

      await expect(albums.getAssetIds(source.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(albums.getAssetIds(target.id, [asset.id])).resolves.toEqual(new Set());
    });
  });

  describe('transfer', () => {
    it('makes a member the owner, so ownership checks follow them, and keeps the old owner as an editor', async () => {
      const { sut, ctx } = setup();
      const access = ctx.get(AccessRepository);
      const { album, owner, sharedWith } = await ctx.newSharedAlbum({ role: AlbumUserRole.Viewer });

      await sut.transfer(factory.auth({ user: { id: owner.id } }), album.id, { userId: sharedWith.id });

      await expect(access.album.checkOwnerAccess(sharedWith.id, new Set([album.id]))).resolves.toEqual(
        new Set([album.id]),
      );
      await expect(access.album.checkOwnerAccess(owner.id, new Set([album.id]))).resolves.toEqual(new Set());
      await expect(
        access.album.checkSharedAlbumAccess(owner.id, new Set([album.id]), AlbumUserRole.Editor),
      ).resolves.toEqual(new Set([album.id]));

      // The new owner can now hand it back; the old owner can no longer hand it on.
      await expect(
        sut.transfer(factory.auth({ user: { id: owner.id } }), album.id, { userId: owner.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hands the album to a partner who was not in it', async () => {
      const { sut, ctx } = setup();
      const access = ctx.get(AccessRepository);
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id });

      await sut.transfer(factory.auth({ user: { id: owner.id } }), album.id, { userId: partner.id });

      await expect(access.album.checkOwnerAccess(partner.id, new Set([album.id]))).resolves.toEqual(
        new Set([album.id]),
      );
    });

    it('refuses a stranger and leaves ownership as it was', async () => {
      const { sut, ctx } = setup();
      const access = ctx.get(AccessRepository);
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: owner.id });

      await expect(
        sut.transfer(factory.auth({ user: { id: owner.id } }), album.id, { userId: stranger.id }),
      ).rejects.toThrow('Invalid user');
      await expect(access.album.checkOwnerAccess(owner.id, new Set([album.id]))).resolves.toEqual(new Set([album.id]));
    });
  });
});
