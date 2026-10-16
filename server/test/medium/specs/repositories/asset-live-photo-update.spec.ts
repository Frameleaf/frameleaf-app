import { BadRequestException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetLockReason, AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

describe('atomic Live Photo asset edits', () => {
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
    const { asset: old } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
    });
    const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, livePhotoVideoId: old.id });
    const { asset: video } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Timeline,
    });
    const repo = new AssetRepository(db);
    const { sut, mocks } = newTestService(AssetService, { asset: repo, access: new AccessRepository(db) });
    mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);
    mocks.user.getLockedProfileImageSources.mockResolvedValue([]);
    return { user, photo, video, old, repo, sut, mocks, auth: AuthFactory.create({ id: user.id }) };
  };
  const dispose = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await db.deleteFrom('asset').where('ownerId', '=', f.user.id).execute();
    await db.deleteFrom('user').where('id', '=', f.user.id).execute();
  };
  const snapshot = async (f: Awaited<ReturnType<typeof fixture>>) => ({
    assets: await db
      .selectFrom('asset')
      .select(['id', 'livePhotoVideoId', 'visibility'])
      .where('ownerId', '=', f.user.id)
      .orderBy('id')
      .execute(),
    exif: await db
      .selectFrom('asset_exif')
      .select(['assetId', 'description'])
      .where('assetId', '=', f.photo.id)
      .execute(),
    locks: await db
      .selectFrom('asset_lock')
      .select('assetId')
      .where('assetId', 'in', [f.photo.id, f.video.id, f.old.id])
      .orderBy('assetId')
      .execute(),
  });

  it.each(['photo', 'motion', 'exif', 'lock'])(
    'rolls back an actual %s write and publishes effects only after a healthy retry commits',
    async (stage) => {
      const f = await fixture();
      try {
        const before = await snapshot(f);
        const original = f.repo.withLivePhotoUpdate.bind(f.repo);
        const inject = vi.spyOn(f.repo, 'withLivePhotoUpdate').mockImplementation((id, motion, write) =>
          original(id, motion, async (assets, access) => {
            const update = assets.update.bind(assets);
            vi.spyOn(assets, 'update').mockImplementation(async (input) => {
              const result = await update(input);
              if ((stage === 'photo' && input.id === f.photo.id) || (stage === 'motion' && input.id === f.video.id))
                throw new Error('injected write failure');
              return result;
            });
            const exif = assets.upsertExif.bind(assets);
            vi.spyOn(assets, 'upsertExif').mockImplementation(async (input) => {
              const result = await exif(input);
              if (stage === 'exif') throw new Error('injected write failure');
              return result;
            });
            const lock = assets.lock.bind(assets);
            vi.spyOn(assets, 'lock').mockImplementation(async (...args) => {
              const result = await lock(...args);
              if (stage === 'lock') throw new Error('injected write failure');
              return result;
            });
            return write(assets, access);
          }),
        );
        const dto = { livePhotoVideoId: f.video.id, description: 'changed', visibility: AssetVisibility.Locked };
        await expect(f.sut.update(f.auth, f.photo.id, dto)).rejects.toThrow('injected write failure');
        expect(await snapshot(f)).toEqual(before);
        expect(f.mocks.job.queue).not.toHaveBeenCalled();
        expect(f.mocks.event.emit).not.toHaveBeenCalled();
        inject.mockRestore();
        const assertCommitted = async () => {
          const row = await db
            .selectFrom('asset')
            .select('livePhotoVideoId')
            .where('id', '=', f.photo.id)
            .executeTakeFirstOrThrow();
          expect(row.livePhotoVideoId).toBe(f.video.id);
        };
        f.mocks.job.queue.mockImplementation(assertCommitted);
        f.mocks.event.emit.mockImplementation(assertCommitted);
        await expect(f.sut.update(f.auth, f.photo.id, dto)).resolves.toEqual(
          expect.objectContaining({ id: f.photo.id, visibility: AssetVisibility.Locked }),
        );
        const after = await snapshot(f);
        expect(after.assets.find((asset) => asset.id === f.video.id)!.visibility).toBe(AssetVisibility.Hidden);
        expect(after.assets.find((asset) => asset.id === f.old.id)!.visibility).toBe(f.photo.visibility);
        expect(after.exif).toEqual([{ assetId: f.photo.id, description: 'changed' }]);
        expect(after.locks.map((lock) => lock.assetId)).toEqual([f.photo.id, f.video.id, f.old.id].sort());
        expect(f.mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: f.video.id, userId: f.user.id });
        expect(f.mocks.event.emit).toHaveBeenCalledWith('AssetShow', { assetId: f.old.id, userId: f.user.id });
      } finally {
        await dispose(f);
      }
    },
  );

  it.each(['insert', 'hide'])('rolls back ordinary Live Photo upload after an actual %s write fails', async (stage) => {
    const f = await fixture();
    const upload = mediumFactory.assetInsert({
      ownerId: f.user.id,
      type: AssetType.Image,
      livePhotoVideoId: f.video.id,
    });
    try {
      const before = await snapshot(f);
      const create = AssetRepository.prototype.create;
      const update = AssetRepository.prototype.update;
      const inserted = vi.spyOn(AssetRepository.prototype, 'create').mockImplementation(async function (
        this: AssetRepository,
        ...args
      ) {
        const result = await create.apply(this, args);
        if (stage === 'insert') throw new Error('injected upload failure');
        return result;
      });
      const hidden = vi.spyOn(AssetRepository.prototype, 'update').mockImplementation(async function (
        this: AssetRepository,
        input,
      ) {
        const result = await update.call(this, input);
        if (stage === 'hide') throw new Error('injected upload failure');
        return result;
      });
      try {
        await expect(f.repo.createLivePhotoUpload(upload)).rejects.toThrow('injected upload failure');
      } finally {
        inserted.mockRestore();
        hidden.mockRestore();
      }
      expect(await snapshot(f)).toEqual(before);
      const result = await f.repo.createLivePhotoUpload(upload);
      expect(result.asset.livePhotoVideoId).toBe(f.video.id);
      expect(result.hiddenId).toBe(f.video.id);
      expect((await f.repo.getById(f.video.id))!.visibility).toBe(AssetVisibility.Hidden);
    } finally {
      await dispose(f);
    }
  });

  it('creates an explicitly Locked ordinary upload and locks its motion in the same transaction without a session', async () => {
    const f = await fixture();
    try {
      const upload = mediumFactory.assetInsert({
        ownerId: f.user.id,
        type: AssetType.Image,
        livePhotoVideoId: f.video.id,
      });
      const result = await f.repo.createLivePhotoUpload(upload, {
        reason: AssetLockReason.Marked,
        lockedBy: f.user.id,
      });
      expect(result.lockedIds.sort()).toEqual([result.asset.id, f.video.id].sort());
      expect((await f.repo.getById(result.asset.id))!.isLocked).toBe(true);
      expect((await f.repo.getById(f.video.id))!.isLocked).toBe(true);
    } finally {
      await dispose(f);
    }
  });

  it('refuses ordinary-session access when the photo becomes Locked while its edit waits on a separate connection', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<number>();
    let first: Promise<void> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${f.photo.id})::int)`.execute(tx);
        entered.resolve();
        await release.promise;
        await new AssetRepository(tx).lock([f.photo.id], AssetLockReason.Marked, f.user.id);
      });
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error('Lock writer did not enter');
        }),
      ]);
      second = db
        .connection()
        .execute(async (db) => {
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
          connection.resolve(rows[0].pid);
          const { sut } = newTestService(AssetService, {
            asset: new AssetRepository(db),
            access: new AccessRepository(db),
          });
          return sut.update(f.auth, f.photo.id, { livePhotoVideoId: f.video.id });
        })
        .then(() => {})
        .catch((error: unknown) => error);
      const pid = await Promise.race([
        connection.promise,
        second.then(() => {
          throw new Error('Edit did not enter its connection');
        }),
      ]);
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{
            blocked: boolean;
          }>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`.execute(db);
          expect(rows[0].blocked).toBe(true);
        },
        { timeout: 5000, interval: 25 },
      );
      release.resolve();
      await first;
      expect(await second).toBeInstanceOf(BadRequestException);
      const current = await snapshot(f);
      expect(current.assets.find((asset) => asset.id === f.photo.id)!.livePhotoVideoId).toBe(f.old.id);
      expect(current.assets.find((asset) => asset.id === f.video.id)!.visibility).toBe(AssetVisibility.Timeline);
      expect(f.mocks.job.queue).not.toHaveBeenCalled();
      expect(f.mocks.event.emit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second].filter((value): value is Promise<unknown> => !!value));
      await dispose(f);
    }
  });
});
