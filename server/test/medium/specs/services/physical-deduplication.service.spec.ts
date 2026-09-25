import { sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetFileType, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import {
  PhysicalDeduplicationApplySnapshot,
  PhysicalDeduplicationStoredPlan,
  physicalDeduplicationFingerprint,
  physicalDeduplicationPlanItems,
} from 'src/utils/physical-deduplication-plan.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

const dryRunSummary = (masterUserId: string) => ({
  mode: 'dry-run' as const,
  masterUserId,
  ranAt: new Date().toISOString(),
  eligibleAssets: 0,
  linkedAssets: 0,
  skippedExternal: 0,
  skippedMissingMaster: 0,
  reclaimableBytes: 0,
  deletedBytes: 0,
  samples: [],
});

/**
 * Boots the service against a fresh fork-active database with:
 * - real PhysicalFileRepository + ForkSchemaRepository (the data-loss-critical paths)
 * - a mocked StorageRepository whose existsSync/stat answers come from `existing`
 * - a mocked JobRepository so FileDelete queueing is observable without side effects
 */
const bootstrap = async () => {
  const database = await getKyselyDB();
  const existing = new Set<string>();

  // The active fork phase makes the immich_fork.config sidecar authoritative;
  // seed the two required keys so `getConfig` can overlay them.
  await sql`
    INSERT INTO immich_fork.config (key, value)
    VALUES
      ('frameleafCloud', ${JSON.stringify(defaults.frameleafCloud)}::jsonb),
      ('smartAlbums', ${JSON.stringify(defaults.smartAlbums)}::jsonb)
    ON CONFLICT (key) DO NOTHING
  `.execute(database);

  const { ctx: fixtures } = newMediumService(PhysicalDeduplicationService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  const { user: masterUser } = await fixtures.newUser();
  const { user: dupUser } = await fixtures.newUser();

  const { sut, ctx } = newMediumService(PhysicalDeduplicationService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      ForkSchemaRepository,
      PhysicalFileRepository,
      UserRepository,
    ],
    mock: [
      CryptoRepository,
      DatabaseRepository,
      JobRepository,
      LoggingRepository,
      StorageRepository,
      SystemMetadataRepository,
    ],
  });

  ctx.getMock(DatabaseRepository).withLock.mockImplementation((_lock, callback) => callback());
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(CryptoRepository).hashFile.mockResolvedValue(randomBytes(32));
  // every file on disk still holds the bytes it was reviewed with
  ctx.getMock(CryptoRepository).hashFileMatching.mockImplementation((_path, reference) => Promise.resolve(reference));
  // the preview a dry run saves is the one a reviewed plan is built from
  let savedPlan: PhysicalDeduplicationStoredPlan = dryRunSummary(masterUser.id);
  ctx
    .getMock(SystemMetadataRepository)
    .get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.PhysicalDeduplicationMigration
          ? savedPlan
          : { physicalDeduplication: { enabled: true, masterUserId: masterUser.id } }) as never,
      ),
    );
  ctx.getMock(SystemMetadataRepository).set.mockImplementation((key, value) => {
    if (key === SystemMetadataKey.PhysicalDeduplicationMigration) {
      savedPlan = value as PhysicalDeduplicationStoredPlan;
    }
    return Promise.resolve();
  });

  const storage = ctx.getMock(StorageRepository);
  storage.checkFileExists.mockImplementation((path) => Promise.resolve(existing.has(path)));
  storage.stat.mockImplementation((path) =>
    existing.has(path) ? Promise.resolve({ size: 1000 } as Stats) : Promise.reject(new Error('ENOENT')),
  );
  storage.unlink.mockImplementation((path) => {
    existing.delete(path);
    return Promise.resolve();
  });
  const unlinked = () => storage.unlink.mock.calls.map(([path]) => path);

  /** Preview and freeze the reviewed plan as apply does (FL-73), without changing anything yet. */
  const reviewPlan = async () => {
    await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Success);
    const { items, retained } = physicalDeduplicationPlanItems(savedPlan, []);
    const snapshot: PhysicalDeduplicationApplySnapshot = {
      version: 1,
      planId: 'PD-TEST',
      fingerprint: physicalDeduplicationFingerprint(savedPlan),
      reviewToken: 'reviewed',
      ranAt: savedPlan.ranAt,
      masterUserId: masterUser.id,
      scopeUserId: null,
      excludedRetainedAssetIds: [],
      items,
      retained,
      estimatedBytes: items.reduce((total, item) => total + item.sizeInBytes, 0),
    };
    return snapshot;
  };

  /** Apply every copy of a frozen plan as the durable job does, one at a time. */
  const applySnapshot = async (snapshot: PhysicalDeduplicationApplySnapshot) => {
    const verified = new Map();
    const results = [];
    for (const item of snapshot.items) {
      results.push(await sut.applyPlanItem(snapshot, item, verified));
    }
    return results;
  };

  /** Preview, then apply every copy of the reviewed plan as the durable job does, one at a time (FL-73). */
  const applyReviewedPlan = async () => {
    const snapshot = await reviewPlan();
    return { snapshot, results: await applySnapshot(snapshot) };
  };

  const queuedDeletes = () =>
    ctx
      .getMock(JobRepository)
      .queue.mock.calls.filter(([job]) => job.name === JobName.FileDelete)
      .flatMap(([job]) => (job as { data: { files: string[] } }).data.files);

  const newPair = async () => {
    const checksum = randomBytes(20);
    const masterPath = `/data/upload/${randomUUID()}-master.jpg`;
    const dupPath = `/data/upload/${randomUUID()}-dup.jpg`;

    const { asset: master } = await ctx.newAsset({ ownerId: masterUser.id, checksum, originalPath: masterPath });
    await ctx.newExif({ assetId: master.id, fileSizeInByte: 1000 });
    const { asset: duplicate } = await ctx.newAsset({ ownerId: dupUser.id, checksum, originalPath: dupPath });
    await ctx.newExif({ assetId: duplicate.id, fileSizeInByte: 1000 });

    return { master, duplicate, masterPath, dupPath, checksum };
  };

  /** Another account's exact copy of an existing retained original (FL-73: several owners). */
  const newCopyOf = async (checksum: Buffer) => {
    const { user } = await fixtures.newUser();
    const path = `/data/upload/${randomUUID()}-copy.jpg`;
    const { asset } = await ctx.newAsset({ ownerId: user.id, checksum, originalPath: path });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1000 });
    return { asset, path, user };
  };

  const getAssetLink = (id: string) =>
    database
      .selectFrom('asset')
      .select(['originalPath', 'physicalOriginalFileId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  return {
    sut,
    ctx,
    database,
    existing,
    masterUser,
    dupUser,
    queuedDeletes,
    unlinked,
    newPair,
    newCopyOf,
    getAssetLink,
    reviewPlan,
    applySnapshot,
    applyReviewedPlan,
    savedPlan: () => savedPlan,
    auth: factory.auth({ user: { id: masterUser.id, isAdmin: true } }),
  };
};

beforeEach(() => {
  clearConfigCache();
});

describe(PhysicalDeduplicationService.name, () => {
  it('leaves a copy alone when its retained original is missing on disk', async () => {
    const { newPair, unlinked, queuedDeletes, getAssetLink, existing, reviewPlan, applySnapshot } = await bootstrap();
    const { duplicate, masterPath, dupPath } = await newPair();
    existing.add(masterPath).add(dupPath);
    // the retained original was there for the review and is gone when the job reaches its copy
    const snapshot = await reviewPlan();
    existing.delete(masterPath);

    const results = await applySnapshot(snapshot);

    expect(results).toEqual([expect.objectContaining({ state: 'skipped', reasonKey: 'retained-missing' })]);
    expect(unlinked()).toEqual([]);
    expect(queuedDeletes()).toEqual([]);
    await expect(getAssetLink(duplicate.id)).resolves.toEqual({
      originalPath: dupPath,
      physicalOriginalFileId: null,
    });
  });

  it('keeps a generated file of the copy when the retained generated file is missing', async () => {
    const { ctx, database, existing, newPair, unlinked, getAssetLink, applyReviewedPlan } = await bootstrap();
    const { master, duplicate, masterPath, dupPath } = await newPair();

    const masterPreview = `/data/thumbs/${master.id}-preview.jpg`;
    const dupPreview = `/data/thumbs/${duplicate.id}-preview.jpg`;
    await ctx.newAssetFile({ assetId: master.id, type: AssetFileType.Preview, path: masterPreview });
    await ctx.newAssetFile({ assetId: duplicate.id, type: AssetFileType.Preview, path: dupPreview });
    existing.add(masterPath).add(dupPath).add(dupPreview);
    // masterPreview deliberately missing on disk

    const { results } = await applyReviewedPlan();

    // the original was linked and the copy's own original removed...
    expect(results).toEqual([expect.objectContaining({ state: 'applied' })]);
    await expect(getAssetLink(duplicate.id)).resolves.toMatchObject({ originalPath: masterPath });
    expect(unlinked()).toEqual([dupPath]);
    // ...but the copy's preview is untouched: its row still points at its own file
    const previewRow = await database
      .selectFrom('asset_file')
      .select(['path', 'physicalFileId'])
      .where('assetId', '=', duplicate.id)
      .where('type', '=', AssetFileType.Preview)
      .executeTakeFirstOrThrow();
    expect(previewRow).toEqual({ path: dupPreview, physicalFileId: null });
  });

  it('is idempotent: applying a copy again links nothing new and removes nothing more', async () => {
    const { sut, ctx, existing, newPair, unlinked, getAssetLink, applyReviewedPlan } = await bootstrap();
    const { master, duplicate, masterPath, dupPath } = await newPair();

    const masterPreview = `/data/thumbs/${master.id}-preview.jpg`;
    const dupPreview = `/data/thumbs/${duplicate.id}-preview.jpg`;
    await ctx.newAssetFile({ assetId: master.id, type: AssetFileType.Preview, path: masterPreview });
    await ctx.newAssetFile({ assetId: duplicate.id, type: AssetFileType.Preview, path: dupPreview });
    existing.add(masterPath).add(dupPath).add(masterPreview).add(dupPreview);

    const { snapshot, results } = await applyReviewedPlan();
    expect(results).toEqual([expect.objectContaining({ state: 'applied' })]);
    expect(unlinked().toSorted()).toEqual([dupPath, dupPreview].toSorted());
    const afterFirstRun = await getAssetLink(duplicate.id);
    expect(afterFirstRun.originalPath).toBe(masterPath);
    expect(afterFirstRun.physicalOriginalFileId).not.toBeNull();

    ctx.getMock(StorageRepository).unlink.mockClear();
    await expect(sut.applyPlanItem(snapshot, snapshot.items[0]!)).resolves.toEqual(
      expect.objectContaining({ state: 'already-applied', reclaimedBytes: 0 }),
    );

    expect(unlinked()).toEqual([]);
    await expect(getAssetLink(duplicate.id)).resolves.toEqual(afterFirstRun);
  });

  it('dry-run emits no FileDelete and mutates nothing', async () => {
    const { sut, ctx, existing, newPair, getAssetLink } = await bootstrap();
    const { duplicate, masterPath, dupPath } = await newPair();
    existing.add(masterPath);

    await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Success);

    expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    expect(ctx.getMock(StorageRepository).copyFile).not.toHaveBeenCalled();
    await expect(getAssetLink(duplicate.id)).resolves.toEqual({
      originalPath: dupPath,
      physicalOriginalFileId: null,
    });
    expect(ctx.getMock(SystemMetadataRepository).set).toHaveBeenCalledWith(
      SystemMetadataKey.PhysicalDeduplicationMigration,
      expect.objectContaining({ mode: 'dry-run', eligibleAssets: 1, deletedBytes: 0 }),
    );
  });

  it('suppresses physical deletion while another asset still references the file', async () => {
    const { ctx, database, existing, dupUser, newPair, unlinked, getAssetLink, applyReviewedPlan } = await bootstrap();
    const { duplicate, masterPath, dupPath } = await newPair();
    existing.add(masterPath).add(dupPath);

    // A second asset still stores the same on-disk file at dupPath.
    const { asset: other } = await ctx.newAsset({ ownerId: dupUser.id, originalPath: dupPath });
    await ctx.newExif({ assetId: other.id, fileSizeInByte: 1000 });

    const { results } = await applyReviewedPlan();
    expect(results).toEqual([expect.objectContaining({ state: 'applied', reclaimedBytes: 0 })]);
    await expect(getAssetLink(duplicate.id)).resolves.toMatchObject({ originalPath: masterPath });
    // while `other` still references dupPath, the copy's old file is never unlinked
    expect(unlinked()).not.toContain(dupPath);

    // The refcount gate itself: once the last reference is gone the same call deletes.
    const unlink = vi.fn().mockResolvedValue(undefined);
    const physicalFileRepository = ctx.get(PhysicalFileRepository);
    await expect(physicalFileRepository.deleteUnreferencedPath(dupPath, unlink)).resolves.toEqual({
      deleted: false,
      references: 1,
    });
    expect(unlink).not.toHaveBeenCalled();
    await database.deleteFrom('asset').where('id', '=', other.id).execute();
    await expect(physicalFileRepository.deleteUnreferencedPath(dupPath, unlink)).resolves.toEqual({
      deleted: true,
      references: 0,
    });
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  describe('reviewed plan fixtures (FL-73)', () => {
    it('shares one retained original with copies of several owners and verifies every one', async () => {
      const { sut, existing, newPair, newCopyOf, getAssetLink, applyReviewedPlan, savedPlan, auth } = await bootstrap();
      const { duplicate, masterPath, dupPath, checksum } = await newPair();
      const other = await newCopyOf(checksum);
      existing.add(masterPath).add(dupPath).add(other.path);

      const { snapshot, results } = await applyReviewedPlan();

      expect(savedPlan().retained).toEqual([expect.objectContaining({ referencesBefore: 1, referencesAfter: 3 })]);
      expect(results).toEqual([
        expect.objectContaining({ state: 'applied' }),
        expect.objectContaining({ state: 'applied' }),
      ]);
      for (const id of [duplicate.id, other.asset.id]) {
        await expect(getAssetLink(id)).resolves.toMatchObject({ originalPath: masterPath });
      }

      const report = await sut.verifyAppliedCopies(
        auth,
        snapshot,
        snapshot.items.map((item) => item.assetId),
      );
      expect(report).toEqual(
        expect.objectContaining({ copies: 2, verified: 2, retainedIntact: 1, notLinked: 0, removed: 2, restorable: 0 }),
      );
    });

    it('skips every copy when the retained original is unavailable on disk at preview time', async () => {
      const { sut, existing, newPair, savedPlan } = await bootstrap();
      const { dupPath } = await newPair();
      existing.add(dupPath);

      await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Success);

      expect(savedPlan().retained).toEqual([expect.objectContaining({ fileAvailable: false })]);
      expect(savedPlan().copies).toEqual([
        expect.objectContaining({ decision: 'skip', reason: 'retained-file-missing' }),
      ]);
      expect(physicalDeduplicationPlanItems(savedPlan(), []).items).toEqual([]);
    });

    it('leaves copies alone when the retained original was deleted after the review', async () => {
      const { database, existing, newPair, getAssetLink, unlinked, reviewPlan, applySnapshot } = await bootstrap();
      const { master, duplicate, masterPath, dupPath } = await newPair();
      existing.add(masterPath).add(dupPath);

      // The review saw the retained original; it is trashed before the job reaches its copy.
      const snapshot = await reviewPlan();
      await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', master.id).execute();
      const results = await applySnapshot(snapshot);

      expect(results).toEqual([expect.objectContaining({ state: 'skipped', reasonKey: 'retained-changed' })]);
      expect(unlinked()).toEqual([]);
      await expect(getAssetLink(duplicate.id)).resolves.toEqual({
        originalPath: dupPath,
        physicalOriginalFileId: null,
      });
    });

    it('leaves a copy alone when its path changed after the review (shared path change)', async () => {
      const { database, existing, newPair, getAssetLink, unlinked, reviewPlan, applySnapshot } = await bootstrap();
      const { duplicate, masterPath, dupPath } = await newPair();
      const movedPath = `/data/upload/${randomUUID()}-moved.jpg`;
      existing.add(masterPath).add(dupPath).add(movedPath);

      const snapshot = await reviewPlan();
      await database.updateTable('asset').set({ originalPath: movedPath }).where('id', '=', duplicate.id).execute();
      const results = await applySnapshot(snapshot);

      expect(results).toEqual([expect.objectContaining({ state: 'skipped', reasonKey: 'copy-changed' })]);
      expect(unlinked()).toEqual([]);
      await expect(getAssetLink(duplicate.id)).resolves.toEqual({
        originalPath: movedPath,
        physicalOriginalFileId: null,
      });
    });

    it('resumes an interrupted apply, verifies it, and restores a copy whose own file survived', async () => {
      const { sut, ctx, existing, newPair, getAssetLink, unlinked, reviewPlan, auth } = await bootstrap();
      const { duplicate, masterPath, dupPath } = await newPair();
      existing.add(masterPath).add(dupPath);
      const snapshot = await reviewPlan();
      const [item] = snapshot.items;

      // The first attempt linked the copy and stopped before its old file was removed.
      const physicalFileRepository = ctx.get(PhysicalFileRepository);
      const shared = await physicalFileRepository.ensureOriginalPhysicalFile(item.retainedAssetId);
      await physicalFileRepository.linkAssetToOriginalPhysicalFile(duplicate.id, shared!);

      const before = await sut.verifyAppliedCopies(auth, snapshot, [duplicate.id]);
      expect(before).toEqual(expect.objectContaining({ verified: 1, restorable: 1, removed: 0 }));
      expect(before.items).toEqual([expect.objectContaining({ linked: true, copyFile: 'present', restorable: true })]);

      // Restoring puts the asset back on its own file and writes nothing on disk.
      await sut.restoreAppliedCopy(auth, snapshot, [duplicate.id], duplicate.id);
      const restored = await getAssetLink(duplicate.id);
      expect(restored.originalPath).toBe(dupPath);
      expect(restored.physicalOriginalFileId).not.toBeNull();
      expect(unlinked()).toEqual([]);
      const after = await sut.verifyAppliedCopies(auth, snapshot, [duplicate.id]);
      expect(after).toEqual(expect.objectContaining({ restored: 1, restorable: 0, notLinked: 0 }));
    });

    it('cannot restore a copy whose own file the apply removed', async () => {
      const { sut, existing, newPair, applyReviewedPlan, auth } = await bootstrap();
      const { duplicate, masterPath, dupPath } = await newPair();
      existing.add(masterPath).add(dupPath);

      const { snapshot } = await applyReviewedPlan();

      await expect(sut.restoreAppliedCopy(auth, snapshot, [duplicate.id], duplicate.id)).rejects.toThrow(
        "can't go back to it",
      );
    });
  });
});
