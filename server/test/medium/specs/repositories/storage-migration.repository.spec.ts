import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AssetFileType,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  PhysicalFileType,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageMigrationRepository, storageMigrationGroupKey } from 'src/repositories/storage-migration.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return {
    ctx,
    sut: new StorageMigrationRepository(defaultDatabase),
    physicalFiles: new PhysicalFileRepository(defaultDatabase),
    mediaHealth: new MediaHealthRepository(defaultDatabase),
  };
};

const newAsset = async (
  ctx: MediumTestContext,
  ownerId: string,
  checksum: Buffer,
  options: { size?: number; createdAt?: Date; dto?: object } = {},
) => {
  const { asset } = await ctx.newAsset({
    ownerId,
    checksum,
    originalPath: `/data/upload/${ownerId}/${randomUUID()}.jpg`,
    ...(options.createdAt && { createdAt: options.createdAt }),
    ...options.dto,
  });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: options.size ?? 1000 });
  return asset;
};

const newLibrary = (ownerId: string) =>
  defaultDatabase
    .insertInto('library')
    .values({ name: 'External', ownerId, importPaths: [], exclusionPatterns: [] })
    .returning('id')
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StorageMigrationRepository.name, () => {
  describe('assets', () => {
    it('pages every active asset in id order, external ones included, and counts them', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const before = await sut.countAssets();
      const library = await newLibrary(user.id);
      const managed = await newAsset(ctx, user.id, randomBytes(20));
      const external = await newAsset(ctx, user.id, randomBytes(20), {
        dto: { isExternal: true, libraryId: library.id },
      });
      await newAsset(ctx, user.id, randomBytes(20), { dto: { deletedAt: new Date() } });

      expect(await sut.countAssets()).toBe(before + 2);

      const ids: string[] = [];
      let cursor: string | null = null;
      while (true) {
        const page = await sut.getAssetPage(cursor, 2);
        ids.push(...page.map(({ id }) => id));
        if (page.length < 2) {
          break;
        }
        cursor = page.at(-1)!.id;
      }
      expect(ids).toEqual([...ids].sort());
      expect(ids).toEqual(expect.arrayContaining([managed.id, external.id]));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('finds in-group sources oldest first, never the asset itself or an external one', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const library = await newLibrary(user.id);
      const { user: second } = await ctx.newUser();
      const { user: third } = await ctx.newUser();
      const { user: fourth } = await ctx.newUser();
      const checksum = randomBytes(20);
      const missing = await newAsset(ctx, user.id, checksum, { createdAt: new Date('2026-01-03') });
      const newer = await newAsset(ctx, second.id, checksum, { createdAt: new Date('2026-01-02') });
      const oldest = await newAsset(ctx, third.id, checksum, { createdAt: new Date('2026-01-01') });
      await newAsset(ctx, user.id, checksum, {
        createdAt: new Date('2025-01-01'),
        dto: { isExternal: true, libraryId: library.id },
      });
      await newAsset(ctx, fourth.id, checksum, { size: 999 });

      const sources = await sut.getGroupSources(missing.id, checksum, 1000);
      expect(sources.map(({ id }) => id)).toEqual([oldest.id, newer.id]);
    });
  });

  describe('duplicate groups', () => {
    it('lists library-storage groups held in more than one file, oldest first, after a cursor', async () => {
      const { ctx, sut, physicalFiles } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const library = await newLibrary(user.id);

      const checksum = Buffer.from(`ff${randomBytes(19).toString('hex')}`, 'hex');
      const second = await newAsset(ctx, other.id, checksum, { createdAt: new Date('2026-02-02') });
      const first = await newAsset(ctx, user.id, checksum, { createdAt: new Date('2026-02-01') });
      await newAsset(ctx, user.id, checksum, { dto: { isExternal: true, libraryId: library.id } });

      // one group already shares one file: not a duplicate group any more
      const shared = Buffer.from(`fe${randomBytes(19).toString('hex')}`, 'hex');
      const primary = await newAsset(ctx, user.id, shared);
      const linked = await newAsset(ctx, other.id, shared);
      const file = await physicalFiles.ensureOriginalPhysicalFile(primary.id);
      await physicalFiles.linkAssetToOriginalPhysicalFile(linked.id, file!);

      const before = storageMigrationGroupKey(Buffer.from('fd'.padEnd(40, 'f'), 'hex'), 1000);
      const groups = await sut.getDuplicateGroupPage(before, 100);
      const group = groups.find(({ checksum: value }) => value.equals(checksum));
      expect(group).toEqual({
        key: storageMigrationGroupKey(checksum, 1000),
        checksum,
        sizeInBytes: 1000,
        assetIds: [first.id, second.id],
      });
      expect(groups.some(({ checksum: value }) => value.equals(shared))).toBe(false);

      // after its own key, the group is not listed again
      const after = await sut.getDuplicateGroupPage(group!.key, 100);
      expect(after.some(({ checksum: value }) => value.equals(checksum))).toBe(false);
      expect(await sut.countDuplicateGroups()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('unreferenced originals', () => {
    it('lists an original no asset names any more, with the asset that last owned it', async () => {
      const { ctx, sut, physicalFiles } = setup();
      const { user } = await ctx.newUser();
      const { user: owner } = await ctx.newUser();
      const checksum = randomBytes(20);
      const primary = await newAsset(ctx, owner.id, checksum);
      const copy = await newAsset(ctx, user.id, checksum);
      const primaryFile = await physicalFiles.ensureOriginalPhysicalFile(primary.id);
      const copyFile = await physicalFiles.ensureOriginalPhysicalFile(copy.id);
      const before = await sut.countUnreferencedOriginals();

      await physicalFiles.linkAssetToOriginalPhysicalFile(copy.id, primaryFile!);

      expect(await sut.countUnreferencedOriginals()).toBe(before + 1);
      const page = await sut.getUnreferencedOriginalPage(null, 10_000);
      expect(page.find(({ id }) => id === copyFile!.id)).toEqual({
        id: copyFile!.id,
        path: copy.originalPath,
        checksum,
        sizeInBytes: 1000,
        lastAssetId: copy.id,
        lastOwnerId: user.id,
        originalFileName: copy.originalFileName,
      });
      expect(page.some(({ id }) => id === primaryFile!.id)).toBe(false);
    });

    it('never lists a file a generated file still names', async () => {
      const { ctx, sut, physicalFiles } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAsset(ctx, user.id, randomBytes(20));
      const path = `/data/thumbs/${randomUUID()}.jpg`;
      const file = await physicalFiles.upsertPhysicalFile({
        canonicalAssetId: null,
        checksum: randomBytes(20),
        path,
        sizeInBytes: 5,
        type: PhysicalFileType.Original,
      });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path });

      const page = await sut.getUnreferencedOriginalPage(null, 10_000);
      expect(page.some(({ id }) => id === file.id)).toBe(false);
    });
  });

  describe('MediaHealthRepository.getRunFindingPage', () => {
    it("pages one run's Missing findings, library storage only when asked", async () => {
      const { ctx, mediaHealth } = setup();
      const { user } = await ctx.newUser();
      const library = await newLibrary(user.id);
      const run = await mediaHealth.createRun(MediaHealthCategory.Missing);
      const managed = await newAsset(ctx, user.id, randomBytes(20));
      const external = await newAsset(ctx, user.id, randomBytes(20), {
        dto: { isExternal: true, libraryId: library.id },
      });
      for (const asset of [managed, external]) {
        await mediaHealth.upsertFinding({
          runId: run.id,
          assetId: asset.id,
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
          severity: MediaHealthSeverity.Critical,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: {},
          resolution: {},
          checkedAt: new Date(),
        });
      }

      const all = await mediaHealth.getRunFindingPage({
        runId: run.id,
        statuses: [MediaHealthStatus.Missing],
        limit: 10,
      });
      expect(all.map(({ assetId }) => assetId).sort()).toEqual([managed.id, external.id].sort());

      const managedOnly = await mediaHealth.getRunFindingPage({
        runId: run.id,
        statuses: [MediaHealthStatus.Missing],
        limit: 10,
        managedOnly: true,
      });
      expect(managedOnly.map(({ assetId }) => assetId)).toEqual([managed.id]);

      const after = await mediaHealth.getRunFindingPage({
        runId: run.id,
        statuses: [MediaHealthStatus.Missing],
        afterId: all.at(-1)!.id,
        limit: 10,
      });
      expect(after).toEqual([]);
    });
  });
});
