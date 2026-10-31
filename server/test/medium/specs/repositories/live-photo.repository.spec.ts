import { Insertable, Kysely, sql } from 'kysely';
import { AssetLockReason, AssetType, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LivePhotoRepository } from 'src/repositories/live-photo.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { LivePhotoService } from 'src/services/live-photo.service.js';
import { linkLivePhotoAssets } from 'src/utils/asset.util.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  return {
    assetRepository: new AssetRepository(database),
    database,
    sut: new LivePhotoRepository(database),
    userRepository: new UserRepository(database),
  };
};

const createUser = async (userRepository: UserRepository) => {
  const user = await mediumFactory.userWithClusterGroup(defaultDatabase);
  await userRepository.create(user);
  return user;
};

const createAsset = async (assetRepository: AssetRepository, dto: Partial<Insertable<AssetTable>>) => {
  const asset = mediumFactory.assetInsert(dto);
  await assetRepository.create(asset);
  return asset;
};

const setLivePhotoCID = (database: Kysely<DB>, assetId: string, livePhotoCID: string) =>
  database.insertInto('asset_exif').values({ assetId, livePhotoCID }).execute();

describe(LivePhotoRepository.name, () => {
  beforeEach(async () => {
    defaultDatabase = await getKyselyDB();
  });

  afterEach(async () => {
    await defaultDatabase?.destroy();
  });

  describe('getUnlinkedByContentId', () => {
    it('returns an unlinked image + video that share a ContentIdentifier', async () => {
      const { sut, assetRepository, userRepository, database } = setup();
      const user = await createUser(userRepository);
      const photo = await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Image,
        originalFileName: 'IMG_0001.heic',
      });
      const video = await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Video,
        originalFileName: 'IMG_0001.mov',
      });
      await setLivePhotoCID(database, photo.id, 'CID-1');
      await setLivePhotoCID(database, video.id, 'CID-1');

      await expect(sut.getUnlinkedByContentId(user.id)).resolves.toEqual([{ photoId: photo.id, videoId: video.id }]);
    });

    it('excludes a video that is already a live photo target', async () => {
      const { sut, assetRepository, userRepository, database } = setup();
      const user = await createUser(userRepository);
      const video = await createAsset(assetRepository, { ownerId: user.id, type: AssetType.Video });
      // An existing photo already links the video.
      await createAsset(assetRepository, { ownerId: user.id, type: AssetType.Image, livePhotoVideoId: video.id });
      // A second, unlinked photo shares the same identifier — but the video is taken.
      const photo = await createAsset(assetRepository, { ownerId: user.id, type: AssetType.Image });
      await setLivePhotoCID(database, photo.id, 'CID-2');
      await setLivePhotoCID(database, video.id, 'CID-2');

      await expect(sut.getUnlinkedByContentId(user.id)).resolves.toEqual([]);
    });

    it('ignores hidden assets', async () => {
      const { sut, assetRepository, userRepository, database } = setup();
      const user = await createUser(userRepository);
      const photo = await createAsset(assetRepository, { ownerId: user.id, type: AssetType.Image });
      const video = await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      await setLivePhotoCID(database, photo.id, 'CID-3');
      await setLivePhotoCID(database, video.id, 'CID-3');

      await expect(sut.getUnlinkedByContentId(user.id)).resolves.toEqual([]);
    });
  });

  describe('getUnlinkedByFilename', () => {
    it('matches by filename stem within the capture-time window', async () => {
      const { sut, assetRepository, userRepository } = setup();
      const user = await createUser(userRepository);
      const photo = await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Image,
        originalFileName: 'IMG_2.HEIC',
        fileCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      const video = await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Video,
        originalFileName: 'IMG_2.mov',
        fileCreatedAt: new Date('2024-01-01T00:00:01.000Z'),
      });

      await expect(sut.getUnlinkedByFilename(user.id, 2)).resolves.toEqual([{ photoId: photo.id, videoId: video.id }]);
    });

    it('does not match across the time window or between different stems', async () => {
      const { sut, assetRepository, userRepository } = setup();
      const user = await createUser(userRepository);
      // Same stem, but captured a minute apart.
      await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Image,
        originalFileName: 'IMG_3.heic',
        fileCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Video,
        originalFileName: 'IMG_3.mov',
        fileCreatedAt: new Date('2024-01-01T00:01:00.000Z'),
      });
      // Same capture time, but different stems.
      await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Image,
        originalFileName: 'IMG_4.heic',
        fileCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      await createAsset(assetRepository, {
        ownerId: user.id,
        type: AssetType.Video,
        originalFileName: 'CLIP_9.mov',
        fileCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      await expect(sut.getUnlinkedByFilename(user.id, 2)).resolves.toEqual([]);
    });
  });
});

describe('atomic Live Photo relinking', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });
  const fixture = async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, livePhotoVideoId: null });
    const { asset: video } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Timeline,
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Relink transaction' });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: video.id });
    return {
      ctx,
      user,
      photo,
      video,
      album,
      repo: new LivePhotoRepository(db),
      auth: AuthFactory.create({ id: user.id }),
    };
  };
  const dispose = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await db.deleteFrom('album').where('id', '=', f.album.id).execute();
    await db.deleteFrom('asset').where('ownerId', '=', f.user.id).execute();
    await db.deleteFrom('user').where('id', '=', f.user.id).execute();
  };
  const service = (repo: LivePhotoRepository) =>
    new LivePhotoService(
      { setContext() {} } as never,
      new AssetRepository(db),
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
      repo,
      undefined as never,
      undefined as never,
    );
  const assertUnlinked = async (f: Awaited<ReturnType<typeof fixture>>) => {
    expect(
      await db.selectFrom('asset').select('livePhotoVideoId').where('id', '=', f.photo.id).executeTakeFirstOrThrow(),
    ).toEqual({ livePhotoVideoId: null });
    expect(
      await db.selectFrom('asset').select('visibility').where('id', '=', f.video.id).executeTakeFirstOrThrow(),
    ).toEqual({ visibility: AssetVisibility.Timeline });
    expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', f.album.id).execute()).toEqual([
      { assetId: f.video.id },
    ]);
  };
  const waitBlocked = async (pid: number) => {
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{
          blocked: boolean;
        }>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`.execute(db);
        expect(rows[0].blocked).toBe(true);
      },
      { timeout: 5000, interval: 25 },
    );
  };

  it.each(['photo', 'video', 'albums'])('rolls back a failed %s write including membership removal', async (stage) => {
    const f = await fixture();
    try {
      await expect(
        f.repo.withRelinkTransaction(f.photo.id, f.video.id, async (assets, albums) => {
          const update = assets.update.bind(assets);
          vi.spyOn(assets, 'update').mockImplementation(async (input) => {
            const result = await update(input);
            if ((stage === 'photo' && input.id === f.photo.id) || (stage === 'video' && input.id === f.video.id))
              throw new Error('injected write failure');
            return result;
          });
          const remove = albums.removeAssetsFromAll.bind(albums);
          vi.spyOn(albums, 'removeAssetsFromAll').mockImplementation(async (ids) => {
            await remove(ids);
            if (stage === 'albums') throw new Error('injected write failure');
          });
          await linkLivePhotoAssets(
            { asset: assets, album: albums },
            { photoAssetId: f.photo.id, motionAssetId: f.video.id },
          );
        }),
      ).rejects.toThrow('injected write failure');
      await assertUnlinked(f);
      await expect(service(f.repo).relinkOne(f.auth, f.photo.id, f.video.id)).resolves.toEqual({ success: true });
      expect(
        (await db.selectFrom('asset').select('livePhotoVideoId').where('id', '=', f.photo.id).executeTakeFirstOrThrow())
          .livePhotoVideoId,
      ).toBe(f.video.id);
      expect(
        (await db.selectFrom('asset').select('visibility').where('id', '=', f.video.id).executeTakeFirstOrThrow())
          .visibility,
      ).toBe(AssetVisibility.Hidden);
      expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', f.album.id).execute()).toEqual(
        [],
      );
    } finally {
      await dispose(f);
    }
  });

  it('allows only one of two competing photos to claim a motion video', async () => {
    const f = await fixture();
    const { asset: other } = await f.ctx.newAsset({
      ownerId: f.user.id,
      type: AssetType.Image,
      livePhotoVideoId: null,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<number>();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = f.repo.withRelinkTransaction(f.photo.id, f.video.id, async (assets, albums) => {
        entered.resolve();
        await release.promise;
        await linkLivePhotoAssets(
          { asset: assets, album: albums },
          { photoAssetId: f.photo.id, motionAssetId: f.video.id },
        );
      });
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error('First relink did not acquire its locks');
        }),
      ]);
      second = db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
        connection.resolve(rows[0].pid);
        return service(new LivePhotoRepository(tx)).relinkOne(f.auth, other.id, f.video.id);
      });
      const pid = await Promise.race([
        connection.promise,
        second.then(() => {
          throw new Error('Second relink did not enter its transaction');
        }),
      ]);
      await waitBlocked(pid);
      release.resolve();
      await first;
      await expect(second).resolves.toEqual({ success: false, error: 'Video is already part of a live photo' });
      expect(
        (await db.selectFrom('asset').select('livePhotoVideoId').where('id', '=', other.id).executeTakeFirstOrThrow())
          .livePhotoVideoId,
      ).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await dispose(f);
    }
  });

  it('rechecks Locked state after waiting for a privacy writer', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<number>();
    let writer: Promise<unknown> | undefined;
    let relink: Promise<unknown> | undefined;
    try {
      writer = db.transaction().execute(async (tx) => {
        for (const id of [f.photo.id, f.video.id].sort())
          await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
        await tx
          .insertInto('asset_lock')
          .values({
            assetId: f.video.id,
            reason: AssetLockReason.Marked,
            lockedBy: f.user.id,
            previousVisibility: null,
          })
          .execute();
        entered.resolve();
        await release.promise;
      });
      await Promise.race([
        entered.promise,
        writer.then(() => {
          throw new Error('Privacy writer did not acquire its locks');
        }),
      ]);
      relink = db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
        connection.resolve(rows[0].pid);
        return service(new LivePhotoRepository(tx)).relinkOne(f.auth, f.photo.id, f.video.id);
      });
      const pid = await Promise.race([
        connection.promise,
        relink.then(() => {
          throw new Error('Relink did not enter its transaction');
        }),
      ]);
      await waitBlocked(pid);
      release.resolve();
      await writer;
      await expect(relink).resolves.toEqual({ success: false, error: 'Asset not found' });
      await assertUnlinked(f);
    } finally {
      release.resolve();
      await Promise.allSettled([writer, relink]);
      await dispose(f);
    }
  });

  it('refuses album contention without holding asset rows or making partial changes', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holder: Promise<unknown> | undefined;
    const callback = vi.fn().mockResolvedValue(undefined);
    try {
      holder = db.transaction().execute(async (tx) => {
        await tx.selectFrom('album').select('id').where('id', '=', f.album.id).forUpdate().execute();
        entered.resolve();
        await release.promise;
      });
      await Promise.race([
        entered.promise,
        holder.then(() => {
          throw new Error('Album writer did not acquire its lock');
        }),
      ]);
      await expect(f.repo.withRelinkTransaction(f.photo.id, f.video.id, callback)).rejects.toThrow('retry relinking');
      expect(callback).not.toHaveBeenCalled();
      await assertUnlinked(f);
    } finally {
      release.resolve();
      await holder;
      await dispose(f);
    }
  });
});
