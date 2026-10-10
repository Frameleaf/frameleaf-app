import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { AssetFileType, PhysicalFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [AssetRepository],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(PhysicalFileRepository), assets: ctx.get(AssetRepository) };
};

const newAssetWithSize = async (ctx: MediumTestContext, ownerId: string, dto: object = {}) => {
  // the factory default originalPath is shared between assets; refcount tests
  // need a path unique to each asset
  const { asset } = await ctx.newAsset({ ownerId, originalPath: `/data/upload/${randomUUID()}.jpg`, ...dto });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1000 });
  return asset;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PhysicalFileRepository.name, () => {
  describe('ensureOriginalPhysicalFile', () => {
    it('creates the row once and links the asset; a second call reuses it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);

      const first = await sut.ensureOriginalPhysicalFile(asset.id);
      expect(first).toMatchObject({
        canonicalAssetId: asset.id,
        path: asset.originalPath,
        type: PhysicalFileType.Original,
        sizeInBytes: 1000,
      });

      const second = await sut.ensureOriginalPhysicalFile(asset.id);
      expect(second?.id).toBe(first?.id);

      const rows = await defaultDatabase
        .selectFrom('physical_file')
        .select('id')
        .where('canonicalAssetId', '=', asset.id)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it('refuses external, offline and trashed assets', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const trashed = await newAssetWithSize(ctx, user.id, { deletedAt: new Date() });
      const offline = await newAssetWithSize(ctx, user.id, { isOffline: true });

      await expect(sut.ensureOriginalPhysicalFile(trashed.id)).resolves.toBeUndefined();
      await expect(sut.ensureOriginalPhysicalFile(offline.id)).resolves.toBeUndefined();
    });
  });

  describe('upsertPhysicalFile', () => {
    it('is keyed by path: a re-upsert updates in place instead of inserting', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const path = `/data/thumbs/${randomUUID()}.jpg`;

      const first = await sut.upsertPhysicalFile({
        canonicalAssetId: asset.id,
        checksum: randomBytes(20),
        path,
        sizeInBytes: 100,
        type: PhysicalFileType.Preview,
      });
      const second = await sut.upsertPhysicalFile({
        canonicalAssetId: asset.id,
        checksum: randomBytes(20),
        path,
        sizeInBytes: 200,
        type: PhysicalFileType.Preview,
      });

      expect(second.id).toBe(first.id);
      expect(second.sizeInBytes).toBe(200);
    });
  });

  describe('deleteUnreferencedPath (refcount gate)', () => {
    it('counts asset originalPath references and refuses to unlink while any remain', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const physicalFile = await sut.ensureOriginalPhysicalFile(asset.id);
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.deleteUnreferencedPath(asset.originalPath, unlink)).resolves.toMatchObject({
        deleted: false,
      });
      expect(unlink).not.toHaveBeenCalled();

      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
      await expect(sut.deleteUnreferencedPath(asset.originalPath, unlink)).resolves.toEqual({
        deleted: true,
        references: 0,
      });
      expect(unlink).toHaveBeenCalledTimes(1);
      // orphan physical_file row is cleaned up in the same transaction
      await expect(sut.getPhysicalFile(physicalFile!.id)).resolves.toBeUndefined();
    });

    it('counts asset_file references against generated files', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const path = `/data/thumbs/${randomUUID()}-preview.jpg`;
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path });
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.deleteUnreferencedPath(path, unlink)).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(unlink).not.toHaveBeenCalled();

      await defaultDatabase.deleteFrom('asset_file').where('path', '=', path).execute();
      await expect(sut.deleteUnreferencedPath(path, unlink)).resolves.toEqual({ deleted: true, references: 0 });
    });
  });

  describe('canonical retained references', () => {
    it('retains a physical original through its asset pointer even when the asset path differs', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const physical = (await sut.ensureOriginalPhysicalFile(asset.id))!;
      await defaultDatabase
        .updateTable('asset')
        .set({ originalPath: `/data/other/${randomUUID()}.jpg` })
        .where('id', '=', asset.id)
        .execute();
      const unlink = vi.fn().mockResolvedValue(undefined);
      await expect(sut.deleteUnreferencedPath(physical.path, unlink)).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(unlink).not.toHaveBeenCalled();
    });

    it('keeps a Buddy capture path until the reference is released', async () => {
      const { sut } = setup();
      const path = `/data/library/${randomUUID()}.jpg`;
      const runId = randomUUID();
      await sql`INSERT INTO public.buddy_backup_reference ("runId", path) VALUES (${runId}::uuid, ${path})`.execute(
        defaultDatabase,
      );
      const unlink = vi.fn().mockResolvedValue(undefined);
      await expect(sut.deleteUnreferencedPath(path, unlink)).resolves.toEqual({ deleted: false, references: 1 });
      expect(unlink).not.toHaveBeenCalled();
      await sql`UPDATE public.buddy_backup_reference SET released = true WHERE "runId" = ${runId}::uuid`.execute(
        defaultDatabase,
      );
      await expect(sut.deleteUnreferencedPath(path, unlink)).resolves.toEqual({ deleted: true, references: 0 });
      expect(unlink).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteUnreferencedPath retained references (FL-44)', () => {
    it('keeps a preservation package until it is removed, and a restoration result', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const restorationPath = `/data/thumbs/${randomUUID()}-restored.jpg`;
      await sql`
        INSERT INTO public.asset_restoration
          ("assetId", "ownerId", revision, mode, workload, "destinationKind", "destinationName", "sourceType",
           "sourceChecksum", "sourceWidth", "sourceHeight", "previewRegion", "resultPath")
        VALUES (${asset.id}::uuid, ${user.id}::uuid, 1, 'restore', 'restoration', 'local', 'This server', 'IMAGE',
           ${randomBytes(20)}, 100, 100, '{}'::jsonb, ${restorationPath})
      `.execute(defaultDatabase);
      const packagePath = `/data/exports/${randomUUID()}.zip`;
      await sql`
        INSERT INTO public.preservation_package ("ownerId", origin, name, format, path)
        VALUES (${user.id}::uuid, 'export', 'Package', 'zip', ${packagePath})
      `.execute(defaultDatabase);
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.deleteUnreferencedPath(packagePath, unlink)).resolves.toMatchObject({ deleted: false });
      await sql`UPDATE public.preservation_package SET "removedAt" = now() WHERE path = ${packagePath}`.execute(
        defaultDatabase,
      );
      await expect(sut.deleteUnreferencedPath(packagePath, unlink)).resolves.toMatchObject({ deleted: true });

      await expect(sut.deleteUnreferencedPath(restorationPath, unlink)).resolves.toMatchObject({ deleted: false });
      expect(unlink).toHaveBeenCalledTimes(1);
    });
  });

  describe('ownership races (FL-44)', () => {
    const newSharedOriginal = async (ctx: MediumTestContext, sut: PhysicalFileRepository) => {
      const { user: master } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const checksum = randomBytes(20);
      const retained = await newAssetWithSize(ctx, master.id, { checksum });
      const physical = (await sut.ensureOriginalPhysicalFile(retained.id))!;
      const copy = await newAssetWithSize(ctx, other.id, { checksum });
      return { master, other, retained, physical, copy };
    };

    it('unlinks a shared original only once no owner references it, when both owners are deleted at once', async () => {
      const { ctx, sut, assets } = setup();
      const { master, other, physical, copy } = await newSharedOriginal(ctx, sut);
      await sut.linkAssetToOriginalPhysicalFile(copy.id, physical);
      // what a reader outside the deleting transaction sees at the moment each unlink runs
      const referencesAtUnlink: number[] = [];
      const unlink = vi.fn(async () => {
        const { count } = await defaultDatabase
          .selectFrom('asset')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where((eb) =>
            eb.or([eb('originalPath', '=', physical.path), eb('physicalOriginalFileId', '=', physical.id)]),
          )
          .executeTakeFirstOrThrow();
        referencesAtUnlink.push(Number(count));
      });

      const deleteOwner = async (ownerId: string) => {
        await assets.deleteAll(ownerId);
        return sut.deleteUnreferencedPath(physical.path, unlink);
      };
      const results = await Promise.all([deleteOwner(master.id), deleteOwner(other.id)]);

      // whichever owner goes last sees no reference left; an earlier one sees the survivor's
      expect(results.some(({ deleted }) => deleted)).toBe(true);
      expect(unlink).toHaveBeenCalled();
      expect(referencesAtUnlink.every((count) => count === 0)).toBe(true);
      await expect(sut.getPhysicalFile(physical.id)).resolves.toBeUndefined();
    });

    it('never unlinks a shared original while the other owner remains, however the deletes interleave', async () => {
      const { ctx, sut, assets } = setup();
      const { master, physical, copy } = await newSharedOriginal(ctx, sut);
      await sut.linkAssetToOriginalPhysicalFile(copy.id, physical);
      const unlink = vi.fn().mockResolvedValue(undefined);

      const results = await Promise.all([
        assets.deleteAll(master.id).then(() => sut.deleteUnreferencedPath(physical.path, unlink)),
        sut.deleteUnreferencedPath(physical.path, unlink),
      ]);

      expect(results.every(({ deleted }) => !deleted)).toBe(true);
      expect(unlink).not.toHaveBeenCalled();
      await expect(
        defaultDatabase
          .selectFrom('asset')
          .select(['originalPath', 'physicalOriginalFileId'])
          .where('id', '=', copy.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ originalPath: physical.path, physicalOriginalFileId: physical.id });
    });

    it('either keeps the original for a concurrent deduplication link or refuses the link', async () => {
      const { ctx, sut, assets } = setup();
      const { master, physical, copy } = await newSharedOriginal(ctx, sut);
      const unlink = vi.fn().mockResolvedValue(undefined);

      const [deleted, linked] = await Promise.allSettled([
        assets.deleteAll(master.id).then(() => sut.deleteUnreferencedPath(physical.path, unlink)),
        sut.linkAssetToOriginalPhysicalFile(copy.id, physical),
      ]);

      const row = await defaultDatabase
        .selectFrom('asset')
        .select(['originalPath', 'physicalOriginalFileId'])
        .where('id', '=', copy.id)
        .executeTakeFirstOrThrow();
      expect(deleted.status).toBe('fulfilled');
      if (deleted.status === 'fulfilled' && deleted.value.deleted) {
        // the file went first: the link found no physical file to point at and changed nothing
        expect(linked.status).toBe('rejected');
        expect(row.originalPath).toBe(copy.originalPath);
        expect(unlink).toHaveBeenCalledTimes(1);
      } else {
        // the link went first: the copy now owns the original and the file stays
        expect(linked.status).toBe('fulfilled');
        expect(row).toEqual({ originalPath: physical.path, physicalOriginalFileId: physical.id });
        expect(unlink).not.toHaveBeenCalled();
      }
    });
  });

  describe('getMasterOriginalCandidate', () => {
    it('returns the matching active master copy deterministically', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const checksum = randomBytes(20);
      const master = await newAssetWithSize(ctx, user.id, { checksum });

      const first = await sut.getMasterOriginalCandidate(user.id, checksum, 1000);
      const second = await sut.getMasterOriginalCandidate(user.id, checksum, 1000);

      expect(first?.id).toBe(master.id);
      expect(second?.id).toBe(master.id);
    });

    it('ignores trashed and size-mismatched copies', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const trashedChecksum = randomBytes(20);
      await newAssetWithSize(ctx, user.id, { checksum: trashedChecksum, deletedAt: new Date() });
      await expect(sut.getMasterOriginalCandidate(user.id, trashedChecksum, 1000)).resolves.toBeUndefined();

      const liveChecksum = randomBytes(20);
      await newAssetWithSize(ctx, user.id, { checksum: liveChecksum });
      await expect(sut.getMasterOriginalCandidate(user.id, liveChecksum, 999)).resolves.toBeUndefined();
    });
  });

  describe('linkUploadedOriginal (universal storage)', () => {
    const exists = () => Promise.resolve(true);
    const newUpload = async (ctx: MediumTestContext, checksum: Buffer, dto: object = {}) => {
      const { user } = await ctx.newUser();
      return newAssetWithSize(ctx, user.id, { checksum, ...dto });
    };
    const originalOf = (id: string) =>
      defaultDatabase
        .selectFrom('asset')
        .select(['originalPath', 'physicalOriginalFileId'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

    it('links an upload to the file another library already holds, whoever owns it', async () => {
      const { ctx, sut } = setup();
      const checksum = randomBytes(32);
      const existing = await newUpload(ctx, checksum);
      const upload = await newUpload(ctx, checksum);

      const result = await sut.linkUploadedOriginal(upload.id, { checksum, sizeInBytes: 1000 }, { exists });

      expect(result).toMatchObject({
        linked: true,
        physicalFile: { canonicalAssetId: existing.id, path: existing.originalPath },
      });
      await expect(originalOf(upload.id)).resolves.toEqual({
        originalPath: existing.originalPath,
        physicalOriginalFileId: result!.physicalFile.id,
      });
      await expect(originalOf(existing.id)).resolves.toEqual({
        originalPath: existing.originalPath,
        physicalOriginalFileId: result!.physicalFile.id,
      });
    });

    it('registers new content as its own primary file', async () => {
      const { ctx, sut } = setup();
      const checksum = randomBytes(32);
      const upload = await newUpload(ctx, checksum);

      const result = await sut.linkUploadedOriginal(upload.id, { checksum, sizeInBytes: 1000 }, { exists });

      expect(result).toMatchObject({
        linked: false,
        physicalFile: { canonicalAssetId: upload.id, path: upload.originalPath, type: PhysicalFileType.Original },
      });
    });

    it('never links to an external-library file, a size mismatch or a file missing on disk', async () => {
      const { ctx, sut } = setup();
      const checksum = randomBytes(32);
      const { user } = await ctx.newUser();
      const library = await defaultDatabase
        .insertInto('library')
        .values({ name: 'External', ownerId: user.id, importPaths: [], exclusionPatterns: [] })
        .returning('id')
        .executeTakeFirstOrThrow();
      await newAssetWithSize(ctx, user.id, { checksum, isExternal: true, libraryId: library.id });
      const missing = await newUpload(ctx, checksum);
      const upload = await newUpload(ctx, checksum);

      const result = await sut.linkUploadedOriginal(
        upload.id,
        { checksum, sizeInBytes: 1000 },
        { exists: (path) => Promise.resolve(path !== missing.originalPath) },
      );

      expect(result).toMatchObject({ linked: false, physicalFile: { canonicalAssetId: upload.id } });
      await expect(originalOf(missing.id)).resolves.toMatchObject({ physicalOriginalFileId: null });
    });

    it('re-checks the file under its path lock: one a concurrent FileDelete moved away is never linked', async () => {
      const { ctx, sut } = setup();
      const checksum = randomBytes(32);
      const existing = await newUpload(ctx, checksum);
      const upload = await newUpload(ctx, checksum);
      // on disk when first looked at, gone (moved to the file trash) once the path lock is held
      let checks = 0;
      const movedAway = (path: string) => Promise.resolve(path !== existing.originalPath || checks++ === 0);

      const result = await sut.linkUploadedOriginal(upload.id, { checksum, sizeInBytes: 1000 }, { exists: movedAway });

      expect(checks).toBe(2);
      expect(result).toMatchObject({
        linked: false,
        physicalFile: { canonicalAssetId: upload.id, path: upload.originalPath },
      });
      await expect(originalOf(upload.id)).resolves.toEqual({
        originalPath: upload.originalPath,
        physicalOriginalFileId: result!.physicalFile.id,
      });
    });

    it('stores identical new content uploaded by two users at once as one file (Review Focus 1)', async () => {
      const { ctx, sut } = setup();
      const checksum = randomBytes(32);
      const first = await newUpload(ctx, checksum);
      const second = await newUpload(ctx, checksum);

      const results = await Promise.all([
        sut.linkUploadedOriginal(first.id, { checksum, sizeInBytes: 1000 }, { exists }),
        sut.linkUploadedOriginal(second.id, { checksum, sizeInBytes: 1000 }, { exists }),
      ]);

      const files = await defaultDatabase
        .selectFrom('physical_file')
        .selectAll()
        .where('checksum', '=', checksum)
        .execute();
      expect(files).toHaveLength(1);
      expect(results.map((result) => result!.physicalFile.id)).toEqual([files[0].id, files[0].id]);
      // exactly one upload keeps its file; the other's temporary upload is released
      expect(results.filter((result) => result!.linked)).toHaveLength(1);
      const rows = await Promise.all([originalOf(first.id), originalOf(second.id)]);
      expect(rows).toEqual([
        { originalPath: files[0].path, physicalOriginalFileId: files[0].id },
        { originalPath: files[0].path, physicalOriginalFileId: files[0].id },
      ]);
    });
  });

  describe('getGeneratedPathPrimaryAssetId', () => {
    it('names the oldest live asset whose generated file is at the path (a copy never owns its source file)', async () => {
      const { ctx, sut } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      const path = `/data/thumbs/${randomUUID()}-preview.jpeg`;
      const source = await newAssetWithSize(ctx, alice.id);
      await ctx.newAssetFile({ assetId: source.id, type: AssetFileType.Preview, path });
      const copy = await newAssetWithSize(ctx, bob.id);
      await ctx.newAssetFile({ assetId: copy.id, type: AssetFileType.Preview, path });
      await defaultDatabase
        .updateTable('asset')
        .set({ createdAt: new Date('2020-01-01') })
        .where('id', '=', source.id)
        .execute();

      await expect(sut.getGeneratedPathPrimaryAssetId(path)).resolves.toBe(source.id);
      await expect(sut.getGeneratedPathPrimaryAssetId('/data/thumbs/nothing.jpeg')).resolves.toBeUndefined();
    });
  });

  describe('electNextCanonical (primary handover)', () => {
    const newSharedByThree = async (ctx: MediumTestContext, sut: PhysicalFileRepository) => {
      const checksum = randomBytes(32);
      const assets = [];
      for (let i = 0; i < 3; i++) {
        const { user } = await ctx.newUser();
        assets.push(await newAssetWithSize(ctx, user.id, { checksum, createdAt: new Date(Date.UTC(2020, 0, i + 1)) }));
      }
      const physical = (await sut.ensureOriginalPhysicalFile(assets[0].id))!;
      await sut.linkAssetToOriginalPhysicalFile(assets[1].id, physical);
      await sut.linkAssetToOriginalPhysicalFile(assets[2].id, physical);
      return { assets, physical };
    };

    it('makes the oldest remaining asset primary once the primary is deleted', async () => {
      const { ctx, sut } = setup();
      const { assets, physical } = await newSharedByThree(ctx, sut);
      const preview = await sut.upsertPhysicalFile({
        canonicalAssetId: assets[0].id,
        checksum: randomBytes(20),
        path: `/data/thumbs/${randomUUID()}-preview.jpg`,
        sizeInBytes: 100,
        type: PhysicalFileType.Preview,
      });
      await ctx.newAssetFile({
        assetId: assets[1].id,
        type: AssetFileType.Preview,
        path: preview.path,
        physicalFileId: preview.id,
      });

      await defaultDatabase.deleteFrom('asset').where('id', '=', assets[0].id).execute();

      await expect(sut.electNextCanonical(physical.id)).resolves.toEqual({ assetId: assets[1].id });
      await expect(sut.isOriginalCanonical(assets[1].id, physical.id)).resolves.toBe(true);
      await expect(sut.getPhysicalFile(preview.id)).resolves.toMatchObject({ canonicalAssetId: assets[1].id });
      // a second call changes nothing: the file has its primary
      await expect(sut.electNextCanonical(physical.id)).resolves.toBeUndefined();
    });

    it('changes nothing when a non-primary copy is deleted', async () => {
      const { ctx, sut } = setup();
      const { assets, physical } = await newSharedByThree(ctx, sut);

      await defaultDatabase.deleteFrom('asset').where('id', '=', assets[2].id).execute();

      await expect(sut.electNextCanonical(physical.id)).resolves.toBeUndefined();
      await expect(sut.isOriginalCanonical(assets[0].id, physical.id)).resolves.toBe(true);
    });
  });

  describe('getCanonicalGeneratedFile', () => {
    it('resolves the master-owned generated file only for linked duplicates', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const master = await newAssetWithSize(ctx, user.id);
      const duplicate = await newAssetWithSize(ctx, user.id);
      const masterPhysical = await sut.ensureOriginalPhysicalFile(master.id);
      const generated = await sut.upsertPhysicalFile({
        canonicalAssetId: master.id,
        checksum: randomBytes(20),
        path: `/data/thumbs/${randomUUID()}-preview.jpg`,
        sizeInBytes: 100,
        type: PhysicalFileType.Preview,
      });

      // the master itself is canonical, so it never resolves through this path
      await expect(sut.getCanonicalGeneratedFile(master.id, AssetFileType.Preview)).resolves.toBeUndefined();
      // unlinked duplicate: nothing to resolve
      await expect(sut.getCanonicalGeneratedFile(duplicate.id, AssetFileType.Preview)).resolves.toBeUndefined();

      await sut.linkAssetToOriginalPhysicalFile(duplicate.id, masterPhysical!);
      await expect(sut.getCanonicalGeneratedFile(duplicate.id, AssetFileType.Preview)).resolves.toEqual({
        id: generated.id,
        path: generated.path,
      });
    });
  });
});
