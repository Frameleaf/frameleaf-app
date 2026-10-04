import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetLockReason, AssetType, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let uploads: AssetUploadResourceRepository;
let assets: AssetRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  uploads = new AssetUploadResourceRepository(db);
  assets = new AssetRepository(db);
});
afterAll(async () => {
  await db.destroy();
});

// Verification is separately exercised over real immutable bytes by the service unit boundary test.
// This suite begins at verified state to exercise actual PostgreSQL publication/rollback/locks.
const setup = async (quota?: number, existingOwnerId?: string) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const user = existingOwnerId
    ? { id: existingOwnerId }
    : (await ctx.newUser({ quotaSizeInBytes: quota ?? null, quotaUsageInBytes: 0 })).user;
  const resource = async (filename: string) => {
    const row = await uploads.create(randomUUID(), user.id, {
      checksum: randomBytes(32),
      contentType: filename.endsWith('.jpg') ? 'image/jpeg' : 'video/quicktime',
      size: 4,
      metadata: {
        filename,
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
        publication: 'live-photo',
        metadata: [{ key: 'upload-pair-test', value: { filename } }],
      },
    });
    expect(row.state).toBe('pair-receiving');
    return db
      .updateTable('asset_upload_resource')
      .set({
        state: 'pair-verified',
        offset: 4,
        verifiedChecksum: row.expectedChecksum,
        legacyChecksum: randomBytes(20),
        finalPath: `/private/${row.id}/${filename}`,
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  };
  const still = await resource('still.jpg');
  const video = await resource('motion.mov');
  const prepared = (row: AssetUploadResource, type: AssetType, locked = false) => ({
    asset: {
      ownerId: user.id,
      libraryId: null,
      checksum: row.verifiedChecksum!,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      originalPath: row.finalPath!,
      originalFileName: row.metadata.filename!,
      type,
      fileCreatedAt: new Date(),
      fileModifiedAt: new Date(),
      localDateTime: new Date(),
      visibility: AssetVisibility.Timeline,
    },
    lock: locked ? { reason: AssetLockReason.Marked, lockedBy: user.id } : undefined,
  });
  const commit = (locked = false) =>
    uploads.lockedMany([video.id, still.id], user.id, (tx, rows) =>
      uploads.publishLivePhoto(
        tx,
        rows.find((row) => row.id === still.id)!,
        rows.find((row) => row.id === video.id)!,
        {
          still: prepared(still, AssetType.Image, locked),
          video: prepared(video, AssetType.Video, locked),
        },
      ),
    );
  const state = async () => ({
    assets: await db
      .selectFrom('asset')
      .select(['id', 'livePhotoVideoId', 'visibility'])
      .where('ownerId', '=', user.id)
      .orderBy('id')
      .execute(),
    resources: await db
      .selectFrom('asset_upload_resource')
      .select(['id', 'state', 'resultAssetId'])
      .where('ownerId', '=', user.id)
      .orderBy('id')
      .execute(),
    quota: (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  });
  return { user, still, video, prepared, commit, state };
};

describe('atomic Live Photo verified-resource publication', () => {
  it('commits both rows/link, Hidden video, both SHA/metadata/result records and combined once quota', async () => {
    const h = await setup();
    const pair = await h.commit();
    expect(await h.state()).toMatchObject({
      quota: 8,
      resources: [expect.objectContaining({ state: 'published' }), expect.objectContaining({ state: 'published' })],
    });
    expect(await assets.getById(pair.still.resultAssetId!)).toMatchObject({
      livePhotoVideoId: pair.video.resultAssetId,
      visibility: AssetVisibility.Timeline,
    });
    expect(await assets.getById(pair.video.resultAssetId!)).toMatchObject({ visibility: AssetVisibility.Hidden });
    for (const row of [pair.still, pair.video]) {
      expect(row.resultStatus).toBe('created');
      expect(row.ingested).toBe(false);
      expect(await assets.getMetadata(row.resultAssetId!)).toEqual([
        expect.objectContaining({ key: 'upload-pair-test', value: { filename: row.metadata.filename } }),
      ]);
      const evidence = await sql<{
        sha256: Buffer;
      }>`SELECT sha256 FROM public.asset_checksum WHERE "assetId" = ${row.resultAssetId}::uuid`.execute(db);
      expect(evidence.rows[0].sha256).toEqual(row.verifiedChecksum);
    }
    const before = await h.state();
    const replay = await h.commit();
    expect(replay.still.resultAssetId).toBe(pair.still.resultAssetId);
    expect(replay.video.resultAssetId).toBe(pair.video.resultAssetId);
    expect(await h.state()).toEqual(before);
  });

  it('rolls back video publication/evidence/quota when an unrelated still duplicate is found', async () => {
    const h = await setup();
    await assets.create(h.prepared(h.still, AssetType.Image).asset);
    const before = await h.state();
    await expect(h.commit()).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
    expect(
      (await sql`SELECT * FROM public.asset_checksum WHERE sha256 = ${h.video.verifiedChecksum}`.execute(db)).rows,
    ).toEqual([]);
  });

  it('refuses an existing Locked video without relinking or changing its lock or quota', async () => {
    const h = await setup();
    const existing = await assets.create(h.prepared(h.video, AssetType.Video).asset, {
      reason: AssetLockReason.Marked,
      lockedBy: h.user.id,
    });
    const before = await h.state();
    const lock = await db.selectFrom('asset_lock').selectAll().where('assetId', '=', existing.id).execute();
    await expect(h.commit()).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
    expect(await db.selectFrom('asset_lock').selectAll().where('assetId', '=', existing.id).execute()).toEqual(lock);
  });

  it('creates both Locked records with the same owner/reason and keeps motion Hidden', async () => {
    const h = await setup();
    const pair = await h.commit(true);
    const locks = await db
      .selectFrom('asset_lock')
      .select(['assetId', 'reason', 'lockedBy'])
      .where('assetId', 'in', [pair.still.resultAssetId!, pair.video.resultAssetId!])
      .execute();
    expect(locks).toHaveLength(2);
    expect(locks.every((lock) => lock.reason === AssetLockReason.Marked && lock.lockedBy === h.user.id)).toBe(true);
  });

  it('refuses mixed Locked privacy without publishing either row', async () => {
    const h = await setup();
    const before = await h.state();
    await expect(
      uploads.lockedMany([h.still.id, h.video.id], h.user.id, (tx, rows) =>
        uploads.publishLivePhoto(
          tx,
          rows[0].id === h.still.id ? rows[0] : rows[1],
          rows[0].id === h.video.id ? rows[0] : rows[1],
          { still: h.prepared(h.still, AssetType.Image, true), video: h.prepared(h.video, AssetType.Video) },
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
  });

  it('refuses combined quota overflow even when either half individually fits', async () => {
    const h = await setup(7);
    const before = await h.state();
    await expect(h.commit()).rejects.toBeInstanceOf(BadRequestException);
    expect(await h.state()).toEqual(before);
  });

  it('refuses foreign, expired and cancelled resources before publication', async () => {
    const h = await setup();
    const other = await setup();
    const before = await h.state();
    await expect(
      uploads.lockedMany([h.still.id, other.video.id], h.user.id, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await db
      .updateTable('asset_upload_resource')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', h.video.id)
      .execute();
    await expect(h.commit()).rejects.toBeInstanceOf(NotFoundException);
    await db
      .updateTable('asset_upload_resource')
      .set({ expiresAt: new Date(Date.now() + 60_000), state: 'cancelled' })
      .where('id', '=', h.video.id)
      .execute();
    await expect(h.commit()).rejects.toBeInstanceOf(NotFoundException);
    expect((await h.state()).assets).toEqual(before.assets);
    expect((await h.state()).quota).toBe(before.quota);
  });

  it('refuses unverified/stale digest and wrong types with whole-pair rollback', async () => {
    const h = await setup();
    const before = await h.state();
    await db.updateTable('asset_upload_resource').set({ state: 'receiving' }).where('id', '=', h.video.id).execute();
    await expect(h.commit()).rejects.toBeInstanceOf(ConflictException);
    await db
      .updateTable('asset_upload_resource')
      .set({ state: 'pair-verified' })
      .where('id', '=', h.video.id)
      .execute();
    await db
      .updateTable('asset_upload_resource')
      .set({ expectedChecksum: randomBytes(32) })
      .where('id', '=', h.video.id)
      .execute();
    await expect(h.commit()).rejects.toBeInstanceOf(ConflictException);
    await db
      .updateTable('asset_upload_resource')
      .set({ expectedChecksum: h.video.expectedChecksum })
      .where('id', '=', h.video.id)
      .execute();
    await expect(
      uploads.lockedMany([h.still.id, h.video.id], h.user.id, (tx, rows) =>
        uploads.publishLivePhoto(
          tx,
          rows.find((r) => r.id === h.still.id)!,
          rows.find((r) => r.id === h.video.id)!,
          {
            still: h.prepared(h.still, AssetType.Video),
            video: h.prepared(h.video, AssetType.Video),
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
  });

  it('refuses reversed concurrent pair locks promptly and preserves successful same-pair replay', async () => {
    const h = await setup();
    const { promise: ready, resolve: acquired } = Promise.withResolvers<void>();
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    const first = uploads.lockedMany([h.video.id, h.still.id], h.user.id, async () => {
      acquired();
      await hold;
    });
    await ready;
    try {
      await expect(
        uploads.lockedMany([h.still.id, h.video.id], h.user.id, () => Promise.resolve()),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      release();
      await first;
    }
    await h.commit();
    const before = await h.state();
    await h.commit();
    expect(await h.state()).toEqual(before);
  });

  it('does not accept a different published pair or relink existing assets on replay', async () => {
    const h = await setup();
    const pair = await h.commit();
    const other = await setup();
    await db.updateTable('asset').set({ livePhotoVideoId: null }).where('id', '=', pair.still.resultAssetId!).execute();
    const before = await h.state();
    await expect(h.commit()).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
    await expect(
      uploads.lockedMany([h.still.id, other.video.id], h.user.id, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('qualifies completion only for both current created resource ingestions, not one half', async () => {
    const h = await setup();
    const pair = await h.commit();
    await db.updateTable('asset_upload_resource').set({ ingested: true }).where('id', '=', h.still.id).execute();
    const still = await uploads.get(h.still.id, h.user.id);
    expect(await uploads.livePhotoPairIngested(still)).toBe(false);
    await db.updateTable('asset_upload_resource').set({ ingested: true }).where('id', '=', h.video.id).execute();
    expect(await uploads.livePhotoPairIngested(still)).toBe(true);
    expect(await uploads.livePhotoPairIngested(await uploads.get(h.video.id, h.user.id))).toBe(true);
    await db.updateTable('asset').set({ livePhotoVideoId: null }).where('id', '=', pair.still.resultAssetId!).execute();
    expect(await uploads.livePhotoPairIngested(still)).toBe(false);
  });
  it('refuses a currently deleted owner and leaves both resources private', async () => {
    const h = await setup();
    const before = await h.state();
    await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', h.user.id).execute();
    await expect(h.commit()).rejects.toBeInstanceOf(NotFoundException);
    expect(await h.state()).toEqual(before);
  });
  it('refuses mixed resources from two successfully published pairs belonging to the same owner', async () => {
    const h = await setup();
    await h.commit();
    const other = await setup(undefined, h.user.id);
    await other.commit();
    const before = await h.state();
    await expect(
      uploads.lockedMany([h.still.id, other.video.id], h.user.id, (tx, rows) =>
        uploads.publishLivePhoto(
          tx,
          rows.find((row) => row.id === h.still.id)!,
          rows.find((row) => row.id === other.video.id)!,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await h.state()).toEqual(before);
  });

  it('recovers only pair-finalizing and retains existing expiry cleanup for held private halves', async () => {
    const h = await setup();
    expect((await uploads.recoverable()).some((row) => row.id === h.still.id)).toBe(false);
    await db
      .updateTable('asset_upload_resource')
      .set({ state: 'pair-finalizing' })
      .where('id', '=', h.still.id)
      .execute();
    expect((await uploads.recoverable()).some((row) => row.id === h.still.id)).toBe(true);
    await db
      .updateTable('asset_upload_resource')
      .set({ state: 'pair-verified' })
      .where('id', '=', h.still.id)
      .execute();
    const remove = vi.fn(() => Promise.resolve());
    await uploads.cleanup(h.still.id, remove);
    expect(remove).not.toHaveBeenCalled();
    await db
      .updateTable('asset_upload_resource')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', h.still.id)
      .execute();
    expect((await uploads.cleanupCandidates()).some((row) => row.id === h.still.id)).toBe(true);
    await uploads.cleanup(h.still.id, remove);
    expect(remove).toHaveBeenCalledOnce();
    expect((await h.state()).resources.find((row) => row.id === h.still.id)!.state).toBe('cancelled');
    expect((await h.state()).assets).toEqual([]);
    expect((await h.state()).quota).toBe(0);
  });
});
