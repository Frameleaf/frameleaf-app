import { Kysely } from 'kysely';
import { AlbumSourceKind } from 'src/dtos/album-source.dto.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumChangeRunRepository } from 'src/repositories/album-change-run.repository.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumMergeService } from 'src/services/album-merge.service.js';
import { BaseService } from 'src/services/base.service.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

const entities = (rows: { type: string }[]) => rows.filter(({ type }) => type !== SyncEntityType.SyncCompleteV1);

const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { sut: merge, ctx: mergeContext } = newMediumService(AlbumMergeService, {
    database: db,
    real: [
      AccessRepository,
      AlbumChangeRunRepository,
      AlbumRepository,
      AlbumSourceRepository,
      AlbumUserRepository,
      ClassificationRepository,
      PartnerOriginRepository,
      SmartAlbumRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  mergeContext.getMock(EventRepository).emit.mockResolvedValue();
  mergeContext.getMock(JobRepository).queue.mockResolvedValue();
  mergeContext.getMock(JobRepository).queueAll.mockResolvedValue();
  const runs = BaseService.create(AlbumChangeRunService, merge);
  const { asset: kept } = await ctx.newAsset({ ownerId: user.id });
  const { asset: other } = await ctx.newAsset({ ownerId: user.id });
  const { asset: moved } = await ctx.newAsset({ ownerId: user.id });
  const { album: winner } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Kept' }, [kept.id, other.id]);
  const { album: loser } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Merged away' }, [moved.id]);
  return { ctx, auth, user, merge, runs, winner, loser, moved };
};

describe('native sync after a merge', () => {
  for (const request of [SyncRequestType.AlbumsV1, SyncRequestType.AlbumsV2]) {
    it(`${request} sees the merged-away album as gone and never upserts it again`, async () => {
      const { ctx, auth, merge, winner, loser } = await setup();
      await ctx.syncAckAll(auth, await ctx.syncStream(auth, [request]));

      await merge.merge(auth, winner.id, { otherId: loser.id });

      const events = entities(await ctx.syncStream(auth, [request]));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: SyncEntityType.AlbumDeleteV1, data: { albumId: loser.id } }),
        ]),
      );
      expect(
        events.filter(({ type }) => type !== SyncEntityType.AlbumDeleteV1).map(({ data }: any) => data.id),
      ).not.toContain(loser.id);
    });
  }

  it('AlbumsV3 shows the merged-away album as trashed, not as still there', async () => {
    const { ctx, auth, merge, winner, loser } = await setup();
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.AlbumsV3]));

    await merge.merge(auth, winner.id, { otherId: loser.id });

    const events = entities(await ctx.syncStream(auth, [SyncRequestType.AlbumsV3]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.AlbumV3,
          data: expect.objectContaining({ id: loser.id, deletedAt: expect.any(String) }),
        }),
      ]),
    );
  });

  it('adds the merged photos to the winner on the next sync', async () => {
    const { ctx, auth, merge, winner, loser, moved } = await setup();
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.AlbumToAssetsV1]));

    await merge.merge(auth, winner.id, { otherId: loser.id });

    expect(entities(await ctx.syncStream(auth, [SyncRequestType.AlbumToAssetsV1]))).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumToAssetV1,
        data: { albumId: winner.id, assetId: moved.id },
      }),
    ]);
  });

  it('tells phones the source link now points at the winner, so they do not recreate the album', async () => {
    const { ctx, auth, user, merge, winner, loser } = await setup();
    const links = new AlbumSourceRepository(db);
    const linkId = await links.write((tx) =>
      links.create(tx, {
        userId: user.id,
        albumId: loser.id,
        kind: AlbumSourceKind.IosPhotos,
        sourceId: 'phone-album',
        deviceKey: null,
        name: 'Merged away',
      }),
    );
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.AlbumSourceLinksV1]));

    await merge.merge(auth, winner.id, { otherId: loser.id });

    expect(entities(await ctx.syncStream(auth, [SyncRequestType.AlbumSourceLinksV1]))).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumSourceLinkV1,
        data: expect.objectContaining({ id: linkId, albumId: winner.id }),
      }),
    ]);
  });

  it('brings the album and its photos back to phones after Undo', async () => {
    const { ctx, auth, merge, runs, winner, loser, moved } = await setup();
    const types = [SyncRequestType.AlbumsV1, SyncRequestType.AlbumToAssetsV1];
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));

    await merge.merge(auth, winner.id, { otherId: loser.id });
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
    await runs.undoLatest(auth);

    const events = entities(await ctx.syncStream(auth, types));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.AlbumV1, data: expect.objectContaining({ id: loser.id }) }),
        expect.objectContaining({
          type: SyncEntityType.AlbumToAssetBackfillV1,
          data: { albumId: loser.id, assetId: moved.id },
        }),
        expect.objectContaining({
          type: SyncEntityType.AlbumToAssetDeleteV1,
          data: { albumId: winner.id, assetId: moved.id },
        }),
      ]),
    );
  });
});
