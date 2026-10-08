import { ModuleRef, Reflector } from '@nestjs/core';
import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AlbumUserRole,
  AssetFileType,
  AssetLockReason,
  AssetStatus,
  AssetVisibility,
  ImmichWorker,
  JobName,
  Permission,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import {
  AlbumOriginField,
  AssetOriginField,
  PartnerBackfillState,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { PartnerCopyService, recordAssetEdit } from 'src/services/partner-copy.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { checkAccess } from 'src/utils/access.js';
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
  AlbumRepository,
  AssetRepository,
  ConfigRepository,
  PartnerOriginRepository,
  PartnerRepository,
  PersonRepository,
  PhysicalFileRepository,
  SearchRepository,
  SystemMetadataRepository,
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
      AssetEditRepository,
      AssetJobRepository,
      DuplicateRepository,
      MapRepository,
      PersonRepository,
      SharedLinkAssetRepository,
      StackRepository,
      TrashRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, OcrRepository, StorageRepository, WebsocketRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { assets: sut, assetCtx: ctx };
};

/** AlbumService over the same database; its queued jobs are drained with the copy service's. */
const albumService = () => {
  const { sut, ctx } = newMediumService(AlbumService, {
    database: db,
    real: [...real, AlbumUserRepository, ClassificationRepository, MapRepository, SmartAlbumRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { albums: sut, albumCtx: ctx };
};

const albumAssetIds = async (albumId: string) =>
  (await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute())
    .map(({ assetId }) => assetId)
    .toSorted();

const PARTNER_JOBS = new Set<string>([
  JobName.PartnerCopyAlbum,
  JobName.PartnerCopyAsset,
  JobName.PartnerPropagate,
  JobName.PartnerBackfill,
]);

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
        case JobName.PartnerCopyAlbum: {
          await sut.handleCopyAlbum(job.data);
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
  it.each([ImmichWorker.Api, ImmichWorker.Microservices])(
    'leaves imported media and partnerships intact on %s bootstrap',
    async (worker) => {
      const media = await mkdtemp(join(tmpdir(), 'frameleaf-import-bootstrap-'));
      try {
        const sourcePath = join(media, 'source-original.jpg');
        const destinationPath = join(media, 'frameleaf-copy.jpg');
        const bytes = Buffer.from('independently copied imported original');
        await writeFile(sourcePath, bytes);
        await writeFile(destinationPath, bytes);
        expect((await stat(sourcePath)).ino).not.toBe((await stat(destinationPath)).ino);
        const { sut, ctx, origins } = setup();
        const { user: alice } = await ctx.newUser();
        const { user: bob } = await ctx.newUser();
        await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
        const { asset } = await ctx.newAsset({
          ownerId: alice.id,
          originalPath: destinationPath,
          checksum: createHash('sha1').update(bytes).digest(),
        });
        await ctx.newExif({ assetId: asset.id, fileSizeInByte: bytes.length });
        const original = await ctx.get(PhysicalFileRepository).ensureOriginalPhysicalFile(asset.id);
        const beforeAsset = await db
          .selectFrom('asset')
          .selectAll()
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow();
        const beforePhysical = await ctx.get(PhysicalFileRepository).getPhysicalFile(original!.id);
        const reflector = new Reflector();
        const events = new EventRepository(
          { get: (token: unknown) => (token === Reflector ? reflector : sut) } as unknown as ModuleRef,
          { getWorker: () => worker } as unknown as ConfigRepository,
          ctx.getMock(LoggingRepository),
        );
        events.setup({ services: [PartnerCopyService] });
        await events.emit('AppBootstrap');
        await events.emit('AppBootstrap');

        expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
        expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
        expect(await origins.getBackfill(alice.id, bob.id)).toBeUndefined();
        expect(await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow()).toEqual(
          beforeAsset,
        );
        expect(await ctx.get(PhysicalFileRepository).getPhysicalFile(original!.id)).toEqual(beforePhysical);
        expect(await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute()).toEqual([]);
        expect(await readFile(sourcePath)).toEqual(bytes);
        expect(await readFile(destinationPath)).toEqual(bytes);
        expect(
          (
            await sql<{ id: string }>`SELECT id FROM public.physical_file_trash
              WHERE path = ANY(${[sourcePath, destinationPath]}::text[])`.execute(db)
          ).rows,
        ).toEqual([]);
      } finally {
        await rm(media, { recursive: true, force: true });
      }
    },
  );

  describe('copyAsset', () => {
    it('repairs thumbnail admission on replay of a copy made before source derivatives were published', async () => {
      const { sut, ctx, origins } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const jobs = ctx.getMock(JobRepository);
      jobs.queue.mockRejectedValueOnce(new Error('Admission interrupted'));

      await expect(sut.copyAsset(source.id, bob.id, alice.id)).rejects.toThrow('Admission interrupted');
      const copyId = (await origins.getCopyId('asset', source.id, bob.id))!;
      expect(copyId).toBeDefined();
      const copy = await ctx.get(AssetRepository).getById(copyId, { files: true });
      const original = await ctx.get(AssetRepository).getById(source.id, { files: true });
      expect(copy).toMatchObject({
        ownerId: bob.id,
        originalPath: original!.originalPath,
        physicalOriginalFileId: original!.physicalOriginalFileId,
        files: [],
      });
      expect(jobs.queue.mock.calls).toEqual([[{ name: JobName.AssetGenerateThumbnails, data: { id: copyId } }]]);

      jobs.queue.mockClear();
      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
      expect(jobs.queue.mock.calls).toEqual([[{ name: JobName.AssetGenerateThumbnails, data: { id: copyId } }]]);

      // A partial publication still needs the existing thumbnail job; a complete one does not.
      await ctx.newAssetFile({ assetId: copyId, type: AssetFileType.Preview, path: '/thumbs/recipient.jpeg' });
      jobs.queue.mockClear();
      await sut.copyAsset(source.id, bob.id, alice.id);
      expect(jobs.queue.mock.calls).toEqual([[{ name: JobName.AssetGenerateThumbnails, data: { id: copyId } }]]);
      await ctx.newAssetFile({ assetId: copyId, type: AssetFileType.Thumbnail, path: '/thumbs/recipient.webp' });
      jobs.queue.mockClear();
      await sut.copyAsset(source.id, bob.id, alice.id);
      expect(jobs.queue).not.toHaveBeenCalled();
      expect(jobs.queueAll).not.toHaveBeenCalled();
      await expect(
        ctx.get(AssetRepository).getForThumbnail(copyId, AssetFileType.Preview, false),
      ).resolves.toMatchObject({
        path: '/thumbs/recipient.jpeg',
      });
      await expect(ctx.get(AssetRepository).getById(source.id, { files: true })).resolves.toEqual(original);
      expect(await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute()).toEqual([
        { id: copyId },
      ]);
    });

    it('creates the recipient their own asset linked to the same stored files, with no analysis queued', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser({ quotaSizeInBytes: 1, quotaUsageInBytes: 10 });
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
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
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
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
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      await ctx.newPartner({ sharedById: bob.id, sharedWithId: carol.id });
      await ctx.newPartner({ sharedById: carol.id, sharedWithId: alice.id });
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

    it("copies Locked and sensitive items locked behind the recipient's own PIN (FL-326 Task 13)", async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const marked = await newSourceAsset(ctx, alice.id);
      await db
        .insertInto('asset_lock')
        .values({ assetId: marked.id, reason: AssetLockReason.Detected, lockedBy: null })
        .execute();
      const sensitive = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', sensitive.id).execute();

      const markedCopy = await sut.copyAsset(marked.id, bob.id, alice.id);
      const sensitiveCopy = await sut.copyAsset(sensitive.id, bob.id, alice.id);
      expect(markedCopy).toBeDefined();
      expect(sensitiveCopy).toBeDefined();

      await expect(ctx.get(AssetRepository).getLockReasons([markedCopy!, sensitiveCopy!])).resolves.toEqual([
        expect.objectContaining({ assetId: markedCopy, reason: AssetLockReason.Detected }),
      ]);
      const copy = await db
        .selectFrom('asset')
        .select('is_nsfw')
        .where('id', '=', sensitiveCopy!)
        .executeTakeFirstOrThrow();
      expect(copy.is_nsfw).toBe(true);

      // only Bob's own elevated session reads the locked copy
      const ordinary = factory.auth({ user: bob });
      const elevated = { ...ordinary, session: { id: 'session', hasElevatedPermission: true } } as typeof ordinary;
      const access = ctx.get(AccessRepository);
      const readable = (auth: typeof ordinary) =>
        checkAccess(access, { auth, permission: Permission.AssetRead, ids: new Set([markedCopy!]) });
      await expect(readable(ordinary)).resolves.toEqual(new Set());
      await expect(readable(elevated)).resolves.toEqual(new Set([markedCopy]));
      // Bob has no PIN: the one-time notice is flagged
      const metadata = await ctx.get(UserRepository).getMetadata(bob.id);
      expect(metadata.map(({ key }) => key)).toContain(UserMetadataKey.PartnerLockedNotice);
    });

    it("copies an item the partner's Locked rules hide already locked, even when a later copy step fails", async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const { tag } = await ctx.newTag({ userId: alice.id, value: 'Private' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [source.id] });
      await db
        .insertInto('user_metadata')
        .values({
          userId: alice.id,
          key: UserMetadataKey.Preferences,
          value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
        })
        .execute();
      const copyFaces = vi
        .spyOn(sut as unknown as { copyFaces: () => Promise<void> }, 'copyFaces')
        .mockRejectedValueOnce(new Error('face copy failed'));

      await expect(sut.copyAsset(source.id, bob.id, alice.id)).rejects.toThrow('face copy failed');

      const copies = await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute();
      expect(copies).toHaveLength(1);
      const copyId = copies[0].id;
      const ordinary = factory.auth({ user: bob });
      const readable = () =>
        checkAccess(ctx.get(AccessRepository), {
          auth: ordinary,
          permission: Permission.AssetRead,
          ids: new Set([copyId]),
        });
      await expect(ctx.get(AssetRepository).getLockReasons([copyId])).resolves.toEqual([
        expect.objectContaining({ assetId: copyId, reason: AssetLockReason.Marked }),
      ]);
      await expect(readable()).resolves.toEqual(new Set());

      // a retry finds the copy (one-copy rule) and re-runs the lock mirror, so a copy left unlocked heals
      await db.deleteFrom('asset_lock').where('assetId', '=', copyId).execute();
      copyFaces.mockRestore();
      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getLockReasons([copyId])).resolves.toEqual([
        expect.objectContaining({ assetId: copyId, reason: AssetLockReason.Marked }),
      ]);
      await expect(readable()).resolves.toEqual(new Set());
    });

    it("copies a photo's faces and maps its people into the recipient's library (FL-326 Task 12)", async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const { person: emma } = await ctx.newPerson({ ownerId: alice.id, name: 'Emma' });
      await ctx.newAssetFace({ assetId: source.id, personGroupId: emma.personGroupId });

      const copyId = await sut.copyAsset(source.id, bob.id, alice.id);

      const faces = await db.selectFrom('asset_face').selectAll().where('assetId', '=', copyId!).execute();
      expect(faces).toHaveLength(1);
      const mapping = await ctx.get(PartnerOriginRepository).getPersonMapping(bob.id, emma.personGroupId);
      expect(faces[0].personGroupId).toBe(mapping?.personGroupId);
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: bob.id, personGroupId: mapping!.personGroupId }),
      ).resolves.toMatchObject({ name: 'Emma' });
    });

    it('never links an external-library item', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ isExternal: true }).where('id', '=', source.id).execute();

      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
    });

    it('copies a Live Photo with its motion part, paired and linked to the same stored file', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const { asset: motion } = await ctx.newAsset({ ownerId: alice.id, visibility: AssetVisibility.Hidden });
      await ctx.newExif({ assetId: motion.id, fileSizeInByte: 999 });
      const still = await newSourceAsset(ctx, alice.id);
      await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', still.id).execute();

      const copyId = await sut.copyAsset(still.id, bob.id, alice.id);

      const copy = await db.selectFrom('asset').selectAll().where('id', '=', copyId!).executeTakeFirstOrThrow();
      expect(copy.livePhotoVideoId).toBeTruthy();
      const motionCopy = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', copy.livePhotoVideoId!)
        .executeTakeFirstOrThrow();
      expect(motionCopy).toMatchObject({
        ownerId: bob.id,
        visibility: AssetVisibility.Hidden,
        checksum: motion.checksum,
        originalPath: motion.originalPath,
      });
      // the Hidden motion part is never copied on its own
      await expect(sut.copyAsset(motion.id, bob.id, alice.id)).resolves.toBeUndefined();
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

    it('copies nothing more once the partnership ends, even from a batch already running', async () => {
      const { sut, ctx } = setup();
      const { sut: partners, ctx: partnerCtx } = newMediumService(PartnerService, {
        database: db,
        real,
        mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
      });
      partnerCtx.getMock(EventRepository).emit.mockResolvedValue();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const source = await newSourceAsset(ctx, alice.id);
      const { album } = await ctx.newAlbum({ ownerId: alice.id, albumName: 'Lake' }, [source.id]);
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });

      // the batch read the partnership before it ended, then copies after `remove` ran
      await partners.remove(factory.auth({ user: alice }), bob.id);
      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
      // and an album copy whose partnership ends between the first check and recording its origin
      vi.spyOn(ctx.get(PartnerRepository), 'get').mockResolvedValueOnce({} as never);
      await expect(sut.copyAlbum(album.id, bob.id, alice.id)).resolves.toBeUndefined();

      await expect(db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute()).resolves.toEqual([]);
      await expect(
        db.selectFrom('album_user').select('albumId').where('userId', '=', bob.id).execute(),
      ).resolves.toEqual([]);
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

    it("re-copies the source's faces to a following copy until its owner edits the copy's faces", async () => {
      const { sut, ctx, origins } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);
      const facesOf = (assetId: string) =>
        db.selectFrom('asset_face').select('boundingBoxX1').where('assetId', '=', assetId).execute();
      expect(await facesOf(bobCopy!)).toHaveLength(0);

      await ctx.newAssetFace({ assetId: source.id, boundingBoxX1: 10 });
      await sut.handlePropagate({ kind: 'asset', sourceId: source.id, fields: [AssetOriginField.Faces] });
      expect(await facesOf(bobCopy!)).toEqual([{ boundingBoxX1: 10 }]);

      await origins.markOverridden('asset', [bobCopy!], [AssetOriginField.Faces], bob.id);
      await ctx.newAssetFace({ assetId: source.id, boundingBoxX1: 20 });
      await sut.handlePropagate({ kind: 'asset', sourceId: source.id, fields: [AssetOriginField.Faces] });
      expect(await facesOf(bobCopy!)).toEqual([{ boundingBoxX1: 10 }]);
    });

    it('carries a lock and unlock to a followed copy until its owner changes it (FL-326 Task 13)', async () => {
      const { sut, ctx } = setup();
      const { assets, assetCtx } = assetService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      const other = await newSourceAsset(ctx, alice.id);
      const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);
      const bobOther = await sut.copyAsset(other.id, bob.id, alice.id);
      const byId = (left: string, right: string) => left.localeCompare(right);
      const lockedIds = async () =>
        (await ctx.get(AssetRepository).getLockReasons([bobCopy!, bobOther!]))
          .map(({ assetId }) => assetId)
          .toSorted(byId);
      const unlockAs = async (ownerId: string, ids: string[]) => {
        // as `POST /assets/unlock` does: remove the lock, then record the owner's visibility edit
        await ctx.get(AssetRepository).unlock(ids);
        await recordAssetEdit(
          { partnerOrigin: ctx.get(PartnerOriginRepository), job: ctx.getMock(JobRepository) },
          ownerId,
          ids,
          [AssetOriginField.Visibility],
        );
      };

      await assets.lock(factory.auth({ user: alice }), { ids: [source.id, other.id] });
      await drain(sut, [ctx, assetCtx]);
      await expect(lockedIds()).resolves.toEqual([bobCopy!, bobOther!].toSorted(byId));

      // Bob unlocks one copy himself: that copy's visibility is his from now on
      await unlockAs(bob.id, [bobOther!]);
      await drain(sut, [ctx, assetCtx]);

      // Alice unlocks both and locks `other` again: the followed copy unlocks, Bob's own choice stands
      await unlockAs(alice.id, [source.id, other.id]);
      await assets.lock(factory.auth({ user: alice }), { ids: [other.id] });
      await drain(sut, [ctx, assetCtx]);
      await expect(lockedIds()).resolves.toEqual([]);
    });

    it.each([AssetOriginField.Tags, AssetOriginField.Faces])(
      "locks a followed copy when a %s edit brings the source under the sharer's Locked rules",
      async (field) => {
        const { sut, ctx } = setup();
        const { user: alice } = await ctx.newUser();
        const { user: bob } = await ctx.newUser();
        await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
        const source = await newSourceAsset(ctx, alice.id);
        const bobCopy = await sut.copyAsset(source.id, bob.id, alice.id);
        const { tag } = await ctx.newTag({ userId: alice.id, value: 'Private' });
        const { person } = await ctx.newPerson({ ownerId: alice.id, name: 'Secret' });
        await db
          .insertInto('user_metadata')
          .values({
            userId: alice.id,
            key: UserMetadataKey.Preferences,
            value: {
              privacy: { suppression: { tagIds: [tag.id], personIds: [person.personGroupId], scope: 'visible' } },
            },
          })
          .execute();
        await expect(ctx.get(AssetRepository).getLockReasons([bobCopy!])).resolves.toEqual([]);

        if (field === AssetOriginField.Tags) {
          await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [source.id] });
        } else {
          await ctx.newAssetFace({ assetId: source.id, personGroupId: person.personGroupId });
        }
        await sut.handlePropagate({ kind: 'asset', sourceId: source.id, fields: [field] });

        await expect(ctx.get(AssetRepository).getLockReasons([bobCopy!])).resolves.toEqual([
          expect.objectContaining({ assetId: bobCopy, reason: AssetLockReason.Marked }),
        ]);
      },
    );

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

      await expect(
        db.selectFrom('asset').selectAll().where('id', '=', source.id).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        ownerId: alice.id,
        isFavorite: true,
        status: AssetStatus.Trashed,
        deletedAt: expect.any(Date),
      });
      const copy = await db.selectFrom('asset').selectAll().where('id', '=', bobCopy!).executeTakeFirstOrThrow();
      expect(copy).toMatchObject({ ownerId: bob.id, isFavorite: false, status: AssetStatus.Active, deletedAt: null });
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

    it('never re-creates a copy the recipient purged when the source is read again', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const source = await newSourceAsset(ctx, alice.id);
      await sut.onAssetMetadataExtracted({ assetId: source.id, userId: alice.id });
      await drain(sut, [ctx]);
      const [copy] = await db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute();
      expect(copy).toBeDefined();

      // Bob trashes and permanently deletes his copy; Alice's item is re-extracted (refresh metadata)
      await db.deleteFrom('asset').where('id', '=', copy.id).execute();
      await sut.onAssetMetadataExtracted({ assetId: source.id, userId: alice.id });
      await drain(sut, [ctx]);

      await expect(db.selectFrom('asset').select('id').where('ownerId', '=', bob.id).execute()).resolves.toEqual([]);
      await expect(sut.copyAsset(source.id, bob.id, alice.id)).resolves.toBeUndefined();
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

  describe('albums and partner access (spec §4.4, §4.8)', () => {
    const shareWithAlbum = async () => {
      const { sut, ctx } = setup();
      const { albums, albumCtx } = albumService();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const first = await newSourceAsset(ctx, alice.id);
      const second = await newSourceAsset(ctx, alice.id);
      const third = await newSourceAsset(ctx, alice.id);
      const { album } = await ctx.newAlbum({ ownerId: alice.id, albumName: 'Lake' }, [first.id, second.id]);
      await ctx.get(PartnerOriginRepository).startBackfill(alice.id, bob.id, 3);
      await sut.handleBackfill({ sharedById: alice.id, sharedWithId: bob.id });
      await drain(sut, [ctx]);
      const origins = ctx.get(PartnerOriginRepository);
      const copyOf = async (assetId: string) => (await origins.getCopyId('asset', assetId, bob.id))!;
      const albumCopy = (await origins.getCopyId('album', album.id, bob.id))!;
      return { sut, ctx, albums, albumCtx, alice, bob, album, first, second, third, copyOf, albumCopy, origins };
    };

    it("copies an album the partner owns, holding the recipient's copies, and mirrors its membership", async () => {
      const { sut, ctx, albums, albumCtx, alice, bob, album, first, second, third, copyOf, albumCopy } =
        await shareWithAlbum();

      expect(albumCopy).toBeDefined();
      const copy = await db.selectFrom('album').selectAll().where('id', '=', albumCopy).executeTakeFirstOrThrow();
      expect(copy.albumName).toBe('Lake');
      const owner = await db
        .selectFrom('album_user')
        .select(['userId', 'role'])
        .where('albumId', '=', albumCopy)
        .execute();
      expect(owner).toEqual([{ userId: bob.id, role: AlbumUserRole.Owner }]);
      await expect(albumAssetIds(albumCopy)).resolves.toEqual(
        [await copyOf(first.id), await copyOf(second.id)].toSorted(),
      );

      await albums.addAssets(factory.auth({ user: alice }), album.id, { ids: [third.id] });
      await albums.removeAssets(factory.auth({ user: alice }), album.id, { ids: [first.id] });
      await albums.update(factory.auth({ user: alice }), album.id, { albumName: 'Lake trip' });
      await drain(sut, [ctx, albumCtx]);

      await expect(albumAssetIds(albumCopy)).resolves.toEqual(
        [await copyOf(second.id), await copyOf(third.id)].toSorted(),
      );
      await expect(
        db.selectFrom('album').select('albumName').where('id', '=', albumCopy).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ albumName: 'Lake trip' });
    });

    it("stops mirroring membership once the recipient changes their album's items", async () => {
      const { sut, ctx, albums, albumCtx, alice, bob, album, first, third, copyOf, albumCopy, origins } =
        await shareWithAlbum();

      await albums.removeAssets(factory.auth({ user: bob }), albumCopy, { ids: [await copyOf(first.id)] });
      await expect(origins.getOrigin('album', albumCopy)).resolves.toMatchObject({
        overriddenFields: [AlbumOriginField.Membership],
      });

      await albums.addAssets(factory.auth({ user: alice }), album.id, { ids: [third.id] });
      await drain(sut, [ctx, albumCtx]);
      expect(await albumAssetIds(albumCopy)).not.toContain(await copyOf(third.id));
      // the source album is untouched by the recipient's edit
      expect(await albumAssetIds(album.id)).toContain(first.id);
    });

    it('never copies an album the recipient already sees as a member', async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const asset = await newSourceAsset(ctx, alice.id);
      const { album } = await ctx.newAlbum({ ownerId: alice.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: bob.id, role: AlbumUserRole.Editor });

      await expect(sut.copyAlbum(album.id, bob.id, alice.id)).resolves.toBeUndefined();
    });

    it('gives a library one copy of an album however many partners pass it on (A→B, A→C, B→C)', async () => {
      const { sut, ctx } = setup();
      const origins = ctx.get(PartnerOriginRepository);
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const { user: carol } = await ctx.newUser();
      for (const [sharedById, sharedWithId] of [
        [alice.id, bob.id],
        [alice.id, carol.id],
        [bob.id, carol.id],
      ]) {
        await ctx.newPartner({ sharedById, sharedWithId });
      }
      const photo = await newSourceAsset(ctx, alice.id);
      const { album } = await ctx.newAlbum({ ownerId: alice.id, albumName: 'Lake' }, [photo.id]);
      // Carol receives the photo straight from Alice, then the album by way of Bob first
      const carolPhoto = await sut.copyAsset(photo.id, carol.id, alice.id);

      for (const sharedWithId of [bob.id, carol.id]) {
        await origins.startBackfill(alice.id, sharedWithId, 1);
        await sut.handleBackfill({ sharedById: alice.id, sharedWithId });
        await drain(sut, [ctx]);
      }

      const carolAlbums = await db.selectFrom('album_user').select('albumId').where('userId', '=', carol.id).execute();
      expect(carolAlbums).toHaveLength(1);
      // and the copy holds Carol's copy of the photo, though it came from Alice and the album from Bob
      await expect(albumAssetIds(carolAlbums[0].albumId)).resolves.toEqual([carolPhoto]);
      expect(album.id).not.toBe(carolAlbums[0].albumId);
    });

    it("never lets a partner read the sharer's own rows: only their copies", async () => {
      const { ctx, bob, first, copyOf } = await shareWithAlbum();
      const access = ctx.get(AccessRepository);
      const auth = factory.auth({ user: bob });
      const copyId = await copyOf(first.id);

      for (const permission of [Permission.AssetRead, Permission.AssetView, Permission.AssetDownload]) {
        await expect(checkAccess(access, { auth, permission, ids: new Set([first.id]) })).resolves.toEqual(new Set());
        await expect(checkAccess(access, { auth, permission, ids: new Set([copyId]) })).resolves.toEqual(
          new Set([copyId]),
        );
      }
    });
  });
});
