import { Kysely } from 'kysely';
import { AssetFileType, AssetLockReason, AssetVisibility, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import {
  AssetOriginField,
  PartnerBackfillState,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { PartnerCopyService } from 'src/services/partner-copy.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-326 (spec §4.3, §4.7): partner copies are the recipient's own rows linked to the same file. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const real = [
  AccessRepository,
  AssetRepository,
  PartnerOriginRepository,
  PartnerRepository,
  PhysicalFileRepository,
  TagRepository,
  UserRepository,
];

const setup = () => {
  const { sut, ctx } = newMediumService(PartnerCopyService, {
    database: db,
    real,
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { sut, ctx, origins: ctx.get(PartnerOriginRepository) };
};

type Ctx = ReturnType<typeof setup>['ctx'];

/** AssetService over the same database; its queued jobs are drained with the copy service's. */
const assetService = () => {
  const { sut, ctx } = newMediumService(AssetService, {
    database: db,
    real: [
      ...real,
      AlbumRepository,
      AssetEditRepository,
      AssetJobRepository,
      DuplicateRepository,
      MapRepository,
      PersonRepository,
      SharedLinkAssetRepository,
      StackRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, OcrRepository, StorageRepository, WebsocketRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { assets: sut, assetCtx: ctx };
};

const PARTNER_JOBS = new Set<string>([JobName.PartnerCopyAsset, JobName.PartnerPropagate, JobName.PartnerBackfill]);

/** Run every queued partner job, and the jobs they queue, until none is left; returns the rounds taken. */
const drain = async (sut: PartnerCopyService, contexts: { getMock: Ctx['getMock'] }[]) => {
  for (let round = 0; round < 25; round++) {
    const items = contexts.flatMap((ctx) => {
      const mock = ctx.getMock(JobRepository);
      const queued = [
        ...mock.queue.mock.calls.map(([item]) => item),
        ...mock.queueAll.mock.calls.flatMap(([items]) => items),
      ];
      mock.queue.mockClear();
      mock.queueAll.mockClear();
      return queued;
    });
    const jobs = items.filter((item) => PARTNER_JOBS.has(item.name));
    if (jobs.length === 0) {
      return round;
    }
    for (const job of jobs) {
      switch (job.name) {
        case JobName.PartnerCopyAsset: {
          await sut.handleCopyAsset(job.data);
          break;
        }
        case JobName.PartnerPropagate: {
          await sut.handlePropagate(job.data);
          break;
        }
        case JobName.PartnerBackfill: {
          await sut.handleBackfill(job.data);
          break;
        }
        default: {
          break;
        }
      }
    }
  }
  throw new Error('partner jobs did not settle');
};

const exifOf = (assetId: string) =>
  db.selectFrom('asset_exif').selectAll().where('assetId', '=', assetId).executeTakeFirstOrThrow();

const newSourceAsset = async (ctx: Ctx, ownerId: string, size = 1234) => {
  const { asset } = await ctx.newAsset({ ownerId });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: size, description: 'at the lake', city: 'Calgary' });
  return asset;
};

describe(PartnerCopyService.name, () => {
  describe('copyAsset', () => {
    it('creates the recipient their own asset linked to the same stored files, with no analysis queued', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser({ quotaSizeInBytes: 1, quotaUsageInBytes: 10 });
      const source = await newSourceAsset(ctx, alice.id);
      await ctx.newAssetFile({ assetId: source.id, type: AssetFileType.Thumbnail, path: '/thumbs/a.webp' });
      await ctx.newAssetFile({ assetId: source.id, type: AssetFileType.Preview, path: '/thumbs/a.jpeg' });
      await ctx.newJobStatus({ assetId: source.id, metadataExtractedAt: new Date() });
      const tag = await ctx.newTag({ userId: alice.id, value: 'trips' });
      await ctx.newTagAsset({ tagIds: [tag.tag.id], assetIds: [source.id] });
      const { tag: bobTrips } = await ctx.newTag({ userId: bob.id, value: 'trips' });

      const copyId = await sut.copyAsset(source.id, bob.id, alice.id);

      expect(copyId).toBeDefined();
      const copy = await db.selectFrom('asset').selectAll().where('id', '=', copyId!).executeTakeFirstOrThrow();
      const sourceRow = await db.selectFrom('asset').selectAll().where('id', '=', source.id).executeTakeFirstOrThrow();
      expect(copy).toMatchObject({
        ownerId: bob.id,
        checksum: sourceRow.checksum,
        originalPath: sourceRow.originalPath,
        physicalOriginalFileId: sourceRow.physicalOriginalFileId,
        isFavorite: false,
        deletedAt: null,
      });
      expect(sourceRow.physicalOriginalFileId).not.toBeNull();

      const exif = await db.selectFrom('asset_exif').selectAll().where('assetId', '=', copyId!).executeTakeFirst();
      expect(exif).toMatchObject({ description: 'at the lake', city: 'Calgary', fileSizeInByte: 1234 });
      const files = await db
        .selectFrom('asset_file')
        .select(['type', 'path'])
        .where('assetId', '=', copyId!)
        .orderBy('type')
        .execute();
      expect(files).toEqual([
        { type: AssetFileType.Preview, path: '/thumbs/a.jpeg' },
        { type: AssetFileType.Thumbnail, path: '/thumbs/a.webp' },
      ]);
      await expect(
        db.selectFrom('asset_job_status').select('assetId').where('assetId', '=', copyId!).executeTakeFirst(),
      ).resolves.toBeDefined();

      // the library's own tag of that name is reused
      const tags = await db.selectFrom('tag_asset').select('tagId').where('assetId', '=', copyId!).execute();
      expect(tags).toEqual([{ tagId: bobTrips.id }]);

      // quota is charged in full and never blocks the copy
      const bobRow = await db
        .selectFrom('user')
        .select('quotaUsageInBytes')
        .where('id', '=', bob.id)
        .executeTakeFirstOrThrow();
      expect(Number(bobRow.quotaUsageInBytes)).toBe(10 + 1234);

      await expect(ctx.get(PartnerOriginRepository).getOrigin('asset', copyId!)).resolves.toEqual({
        id: copyId,
        sourceId: source.id,
        ownerId: bob.id,
        rootOwnerId: alice.id,
        partnerSharedById: alice.id,
        overriddenFields: [],
        following: true,
      });
      expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
      expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
    });

    it.each([
      ['live', null],
      ['trashed', new Date()],
    ])('skips content the library already holds (%s)', async (_label, deletedAt) => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      await ctx.newAsset({ ownerId: bob.id, checksum: source.checksum, deletedAt });

      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
    });

    it('copies once, however often it is asked', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);

      const results = await Promise.all([
        sut.copyAsset(source.id, bob.id, alice.id),
        sut.copyAsset(source.id, bob.id, alice.id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const copies = await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute();
      expect(copies).toHaveLength(1);
    });

    it('never copies an item back to its original owner, through any partner', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const { user: carol } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);
      const carolCopy = await sut.copyAsset(bobCopy!, carol.id, bob.id);

      // C's copy of B's copy still names A as its original owner
      await expect(ctx.get(PartnerOriginRepository).getOrigin('asset', carolCopy!)).resolves.toMatchObject({
        sourceId: bobCopy,
        rootOwnerId: alice.id,
        partnerSharedById: bob.id,
      });
      // alice's library holds it anyway; even after she trashes and purges it, it is never sent back
      await db.deleteFrom('asset').where('id', '=', source.id).execute();
      await expect(sut.copyAsset(carolCopy!, alice.id, carol.id)).resolves.toBeUndefined();
    });

    it('skips Locked and sensitive items until locked sharing lands', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const locked = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ visibility: AssetVisibility.Locked }).where('id', '=', locked.id).execute();
      const marked = await newSourceAsset(ctx, alice.id);
      await db
        .insertInto('asset_lock')
        .values({ assetId: marked.id, reason: AssetLockReason.Marked, lockedBy: null })
        .execute();
      const sensitive = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', sensitive.id).execute();

      for (const { id } of [locked, marked, sensitive]) {
        await expect(sut.copyAsset(id, bob.id, alice.id)).resolves.toBeUndefined();
      }
    });

    it('never links an external-library item', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ isExternal: true }).where('id', '=', source.id).execute();

      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
    });
  });

  describe('backfill', () => {
    it('copies a library in batches and resumes from its cursor', async () => {
      const { sut, ctx, origins } = setup();
      (sut as unknown as { backfillBatchSize: number }).backfillBatchSize = 2;
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      for (let index = 0; index < 3; index++) {
        await newSourceAsset(ctx, alice.id);
      }
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      await origins.startBackfill(alice.id, bob.id, 3);

      await sut.handleBackfill({ sharedById: alice.id, sharedWithId: bob.id });
      await expect(origins.getBackfill(alice.id, bob.id)).resolves.toMatchObject({
        state: PartnerBackfillState.Running,
        done: 2,
        total: 3,
      });
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.PartnerBackfill,
        data: { sharedById: alice.id, sharedWithId: bob.id },
      });
      const afterFirst = await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute();
      expect(afterFirst).toHaveLength(2);

      // a restart replays the job: it picks up after the cursor
      await sut.handleBackfill({ sharedById: alice.id, sharedWithId: bob.id });
      await expect(origins.getBackfill(alice.id, bob.id)).resolves.toMatchObject({
        state: PartnerBackfillState.Done,
        done: 3,
      });
      const afterSecond = await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute();
      expect(afterSecond).toHaveLength(3);
    });

    it('queues each existing partnership once at upgrade', async () => {
      const { sut, ctx, origins } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });

      await sut.queueUpgradeBackfills();
      await expect(origins.getBackfill(alice.id, bob.id)).resolves.toMatchObject({
        state: PartnerBackfillState.Pending,
      });
      await expect(origins.getPartnershipsWithoutBackfill()).resolves.not.toContainEqual({
        sharedById: alice.id,
        sharedWithId: bob.id,
      });
    });

    it('stops following when the partnership ends; the partner keeps every copy', async () => {
      const { sut, ctx, origins } = setup();
      const { sut: partners, ctx: partnerCtx } = newMediumService(PartnerService, {
        database: db,
        real,
        mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
      });
      partnerCtx.getMock(EventRepository).emit.mockResolvedValue();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const copyId = await sut.copyAsset(source.id, bob.id, alice.id);

      await partners.remove(factory.auth({ user: alice }), bob.id);

      await expect(origins.getOrigin('asset', copyId!)).resolves.toMatchObject({ following: false });
      await expect(
        db.selectFrom('asset').select('id').where('id', '=', copyId!).executeTakeFirst(),
      ).resolves.toBeDefined();
      await expect(
        sut.handleCopyAsset({ sourceAssetId: source.id, targetOwnerId: bob.id, partnerSharedById: alice.id }),
      ).resolves.toBe('skipped');
    });
  });

  describe('propagation', () => {
    it("pushes the source's edits to every following copy, onward through the partner's partners", async () => {
      const { sut, ctx } = setup();
      const { assets, assetCtx } = assetService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const { user: carol } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      await ctx.newPartner({ sharedById: bob.id, sharedWithId: carol.id });
      const source = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);
      const carolCopy = await sut.copyAsset(bobCopy!, carol.id, bob.id);

      await assets.update(factory.auth({ user: alice }), source.id, { description: 'sunset', rating: 4 });
      await drain(sut, [ctx, assetCtx]);

      await expect(exifOf(bobCopy!)).resolves.toMatchObject({ description: 'sunset', rating: 4 });
      await expect(exifOf(carolCopy!)).resolves.toMatchObject({ description: 'sunset', rating: 4 });
    });

    it("stops following a field the copy's owner changed, and keeps following the rest", async () => {
      const { sut, ctx } = setup();
      const { assets, assetCtx } = assetService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);

      await assets.update(factory.auth({ user: bob }), bobCopy!, { description: 'mine' });
      await expect(ctx.get(PartnerOriginRepository).getOrigin('asset', bobCopy!)).resolves.toMatchObject({
        overriddenFields: [AssetOriginField.Description],
      });
      // B's edit never reaches A
      await expect(exifOf(source.id)).resolves.toMatchObject({ description: 'at the lake' });

      await assets.update(factory.auth({ user: alice }), source.id, {
        description: 'hers',
        latitude: 51.05,
        longitude: -114.07,
      });
      await drain(sut, [ctx, assetCtx]);

      const exif = await exifOf(bobCopy!);
      expect(exif.description).toBe('mine');
      expect(exif.latitude).toBeCloseTo(51.05);
      expect(exif.longitude).toBeCloseTo(-114.07);
    });

    it('never propagates favorites or trash', async () => {
      const { sut, ctx } = setup();
      const { assets, assetCtx } = assetService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);

      await assets.update(factory.auth({ user: alice }), source.id, { isFavorite: true });
      await assets.deleteAll(factory.auth({ user: alice }), { ids: [source.id] });
      expect(await drain(sut, [ctx, assetCtx])).toBe(0);

      const copy = await db.selectFrom('asset').selectAll().where('id', '=', bobCopy!).executeTakeFirstOrThrow();
      expect(copy).toMatchObject({ isFavorite: false, deletedAt: null });
    });

    it("copies a sharing user's new item to every partner, onward", async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const { user: carol } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      await ctx.newPartner({ sharedById: bob.id, sharedWithId: carol.id });
      const source = await newSourceAsset(ctx, alice.id);

      await sut.onAssetMetadataExtracted({ assetId: source.id, userId: alice.id });
      await drain(sut, [ctx]);

      for (const owner of [bob, carol]) {
        const copies = await db.selectFrom('asset').select('id').where('ownerId', '=', owner.id).execute();
        expect(copies).toHaveLength(1);
      }
    });

    it('keeps one copy per library across a sharing loop and settles (A↔B, B→C, C→A)', async () => {
      const { sut, ctx } = setup();
      const { assets, assetCtx } = assetService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const { user: carol } = await ctx.newUser();
      for (const [sharedById, sharedWithId] of [
        [alice.id, bob.id],
        [bob.id, alice.id],
        [bob.id, carol.id],
        [carol.id, alice.id],
      ]) {
        await ctx.newPartner({ sharedById, sharedWithId });
      }
      const source = await newSourceAsset(ctx, alice.id);
      // C uploaded the same photo independently
      const { asset: carolOwn } = await ctx.newAsset({ ownerId: carol.id, checksum: source.checksum });
      await ctx.newExif({ assetId: carolOwn.id, fileSizeInByte: 1234 });
      const carolOther = await newSourceAsset(ctx, carol.id, 99);

      await sut.onAssetMetadataExtracted({ assetId: source.id, userId: alice.id });
      await sut.onAssetMetadataExtracted({ assetId: carolOwn.id, userId: carol.id });
      await sut.onAssetMetadataExtracted({ assetId: carolOther.id, userId: carol.id });
      await drain(sut, [ctx]);
      await assets.update(factory.auth({ user: alice }), source.id, { description: 'loop' });
      await drain(sut, [ctx, assetCtx]);

      for (const owner of [alice, bob, carol]) {
        const rows = await db.selectFrom('asset').select('checksum').where('ownerId', '=', owner.id).execute();
        const checksums = rows.map(({ checksum }) => Buffer.from(checksum).toString('hex'));
        expect(new Set(checksums).size).toBe(checksums.length);
        expect(checksums).toHaveLength(2);
      }
    });
  });
});
