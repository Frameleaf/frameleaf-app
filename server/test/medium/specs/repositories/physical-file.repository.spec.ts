import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { AssetFileType, PhysicalFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

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

  describe('withLockedNormalizationAsset', () => {
    it('records the checksum evidence as a JSON object, not as JSON text', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      await sut.ensureOriginalPhysicalFile(asset.id);
      const evidence = { sourcePath: asset.originalPath, upstreamPath: asset.originalPath, sizeInBytes: 1000 };

      await sut.withLockedNormalizationAsset(asset.id, randomUUID(), ({ commit }) =>
        commit({
          evidence,
          linkCount: 1,
          sha1: randomBytes(20),
          sha256: randomBytes(32),
          sizeInBytes: 1000,
          upstreamPath: asset.originalPath,
          verifiedPaths: [asset.originalPath],
        }),
      );

      const { rows } = await sql<{ type: string; evidence: unknown }>`
        SELECT jsonb_typeof(evidence) AS type, evidence
        FROM immich_fork.asset_checksum
        WHERE "assetId" = ${asset.id}::uuid
      `.execute(defaultDatabase);
      expect(rows).toEqual([{ type: 'object', evidence }]);
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

  describe('deleteUnreferencedPath retained references (FL-44)', () => {
    const mapTo = async (assetId: string, upstreamPath: string, physicalFileId: string | null = null) => {
      await sql`
        INSERT INTO immich_fork.asset_physical_file ("assetId", "physicalFileId", "upstreamPath")
        VALUES (${assetId}::uuid, ${physicalFileId}::uuid, ${upstreamPath})
      `.execute(defaultDatabase);
    };

    it('keeps a path only a live asset fork mapping names, and frees it with the asset', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const upstreamPath = `/data/library/${randomUUID()}/upstream.jpg`;
      await mapTo(asset.id, upstreamPath);
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.deleteUnreferencedPath(upstreamPath, unlink)).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(unlink).not.toHaveBeenCalled();

      // the mapping of an asset that no longer exists holds nothing
      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
      await expect(sut.deleteUnreferencedPath(upstreamPath, unlink)).resolves.toEqual({
        deleted: true,
        references: 0,
      });
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it('keeps the canonical path of a fork physical file a live mapping still uses', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const canonicalPath = `/data/upload/${randomUUID()}-canonical.jpg`;
      const physicalFileId = randomUUID();
      await sql`
        INSERT INTO immich_fork.physical_file
          (id, "canonicalAssetId", type, checksum, "sizeInBytes", "canonicalPath", "createdAt", "updatedAt")
        VALUES (${physicalFileId}::uuid, ${asset.id}::uuid, 'original', ${randomBytes(20)}, 1000, ${canonicalPath}, now(), now())
      `.execute(defaultDatabase);
      await mapTo(asset.id, `/data/library/${randomUUID()}/upstream.jpg`, physicalFileId);
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.deleteUnreferencedPath(canonicalPath, unlink)).resolves.toMatchObject({ deleted: false });
      expect(unlink).not.toHaveBeenCalled();
    });

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
