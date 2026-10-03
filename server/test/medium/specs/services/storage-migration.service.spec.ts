import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { defaults } from 'src/dtos/config.dto.js';
import { MediaHealthStatus, SystemMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageMigrationRepository } from 'src/repositories/storage-migration.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { StorageMigrationService } from 'src/services/storage-migration.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { StorageMigrationState, storageMigrationStatus } from 'src/utils/storage-migration.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-326 (spec §3.6, Review Focus 5): the universal storage upgrade migration on a seeded library, with
 * a real database, real files in an isolated media location, the real reference-counted link and the
 * real file trash. Interrupted mid-batch and resumed, it neither links nor trashes twice.
 */
let database: Kysely<DB>;
let mediaLocation: string;
let previousMediaLocation: string | undefined;

beforeAll(async () => {
  database = await getKyselyDB();
  await sql`
    INSERT INTO immich_fork.config (key, value)
    VALUES
      ('frameleafCloud', ${JSON.stringify(defaults.frameleafCloud)}::jsonb),
      ('smartAlbums', ${JSON.stringify(defaults.smartAlbums)}::jsonb)
    ON CONFLICT (key) DO NOTHING
  `.execute(database);
  try {
    previousMediaLocation = StorageCore.getMediaLocation();
  } catch {
    // no media location configured for this run
  }
  mediaLocation = await mkdtemp(join(tmpdir(), 'fl326-storage-migration-'));
  StorageCore.setMediaLocation(mediaLocation);
});

afterAll(async () => {
  if (previousMediaLocation !== undefined) {
    StorageCore.setMediaLocation(previousMediaLocation);
  }
  await rm(mediaLocation, { recursive: true, force: true });
});

beforeEach(() => {
  clearConfigCache();
});

const setup = () => {
  const real = [
    AssetRepository,
    ConfigRepository,
    CryptoRepository,
    DatabaseRepository,
    ForkSchemaRepository,
    PhysicalFileRepository,
    PhysicalFileTrashRepository,
    StorageRepository,
    SystemMetadataRepository,
    UserRepository,
  ];
  const { sut: deduplication, ctx } = newMediumService(PhysicalDeduplicationService, {
    database,
    real,
    mock: [JobRepository, LoggingRepository],
  });
  const { sut: fileTrash } = newMediumService(PhysicalFileTrashService, {
    database,
    real,
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();

  const jobs = { queue: vi.fn().mockResolvedValue(undefined) };
  const mediaHealthService = {
    locateForStorageMigration: vi.fn().mockResolvedValue({ checkedAssets: 0, foundAssets: 0 }),
    relinkForStorageMigration: vi.fn().mockResolvedValue('review'),
  };
  const realLink = deduplication.linkToPrimary.bind(deduplication);
  const linkToPrimary = vi.spyOn(deduplication, 'linkToPrimary');
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const sut = new StorageMigrationService(
    logger as never,
    ctx.get(DatabaseRepository),
    ctx.get(ForkSchemaRepository),
    jobs as never,
    new MediaHealthRepository(database),
    ctx.get(PhysicalFileRepository),
    new StorageMigrationRepository(database),
    ctx.get(StorageRepository),
    ctx.get(SystemMetadataRepository),
    mediaHealthService as never,
    deduplication,
    fileTrash,
  );
  return { sut, ctx, linkToPrimary, realLink, mediaHealthService };
};

const write = async (path: string, bytes: Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
};

const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest();

const newAsset = async (
  ctx: MediumTestContext,
  ownerId: string,
  bytes: Buffer,
  options: { onDisk?: Buffer | null; createdAt: Date; dto?: object },
) => {
  const path = join(StorageCore.getLibraryFolder({ id: ownerId, storageLabel: null }), `${randomUUID()}.jpg`);
  const onDisk = options.onDisk === undefined ? bytes : options.onDisk;
  if (onDisk) {
    await write(path, onDisk);
  }
  const { asset } = await ctx.newAsset({
    ownerId,
    checksum: sha1(bytes),
    originalPath: path,
    createdAt: options.createdAt,
    ...options.dto,
  });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: bytes.length });
  return asset;
};

const runToEnd = async (sut: StorageMigrationService) => {
  const seen: StorageMigrationState[] = [];
  for (let step = 0; step < 50; step++) {
    const state = await sut.runBatch();
    seen.push(state);
    if (state.stage === 'done') {
      return seen;
    }
  }
  throw new Error('the migration did not finish');
};

const assetRow = (id: string) =>
  database
    .selectFrom('asset')
    .select(['id', 'originalPath', 'physicalOriginalFileId'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('StorageMigrationService on a seeded library (FL-326)', () => {
  it('relinks, links and trashes exactly once across an interruption, and never touches external files', async () => {
    const { sut, ctx, linkToPrimary, realLink } = setup();
    const users = await Promise.all([1, 2, 3, 4].map(() => ctx.newUser()));
    const [u1, u2, u3, u4] = users.map(({ user }) => user);
    const library = await database
      .insertInto('library')
      .values({ name: 'External', ownerId: u4.id, importPaths: [], exclusionPatterns: [] })
      .returning('id')
      .executeTakeFirstOrThrow();

    const photo = randomBytes(256);
    const primary = await newAsset(ctx, u1.id, photo, { createdAt: new Date('2026-01-01') });
    const copy = await newAsset(ctx, u2.id, photo, { createdAt: new Date('2026-01-02') });
    const missing = await newAsset(ctx, u3.id, photo, { createdAt: new Date('2026-01-03'), onDisk: null });
    const external = await newAsset(ctx, u4.id, randomBytes(128), {
      createdAt: new Date('2026-01-04'),
      onDisk: null,
      dto: { isExternal: true, libraryId: library.id },
    });
    const single = await newAsset(ctx, u1.id, randomBytes(64), { createdAt: new Date('2026-01-05') });

    const video = randomBytes(512);
    const damaged = await newAsset(ctx, u2.id, video, {
      createdAt: new Date('2026-01-01'),
      onDisk: randomBytes(512),
    });
    const good = await newAsset(ctx, u3.id, video, { createdAt: new Date('2026-01-02') });

    // the server restarts while the copy's link is being made: the batch is not checkpointed
    let interrupted = false;
    linkToPrimary.mockImplementation(async (copyId, primaryId, verified) => {
      const result = await realLink(copyId, primaryId, verified);
      if (copyId === copy.id && !interrupted) {
        interrupted = true;
        throw new Error('server restarted');
      }
      return result;
    });

    const before: StorageMigrationState[] = [];
    let failed = false;
    for (let step = 0; step < 50 && !failed; step++) {
      try {
        before.push(await sut.runBatch());
      } catch {
        failed = true;
      }
    }
    expect(failed).toBe(true);
    const after = await runToEnd(sut);

    // progress never went back, from start to finish
    const statuses = [...before, ...after].map((state) => storageMigrationStatus(state));
    for (let index = 1; index < statuses.length; index++) {
      const previous = statuses[index - 1];
      const next = statuses[index];
      for (const stage of ['checking', 'relinking', 'linking'] as const) {
        expect(next.stages[stage].done).toBeGreaterThanOrEqual(previous.stages[stage].done);
      }
      expect(next.relinked).toBeGreaterThanOrEqual(previous.relinked);
      expect(next.bytesFreed).toBeGreaterThanOrEqual(previous.bytesFreed);
    }

    const final = after.at(-1)!;
    expect(final).toMatchObject({ stage: 'done', relinked: 1, toReview: 1 });
    expect(final.skippedAssetIds).toContain(damaged.id);

    const primaryRow = await assetRow(primary.id);
    expect(primaryRow.physicalOriginalFileId).toBeTruthy();
    for (const id of [copy.id, missing.id]) {
      expect(await assetRow(id)).toMatchObject({
        originalPath: primary.originalPath,
        physicalOriginalFileId: primaryRow.physicalOriginalFileId,
      });
    }
    expect(existsSync(primary.originalPath)).toBe(true);

    // the copy's own file went to the file trash, exactly once, never unlinked
    expect(existsSync(copy.originalPath)).toBe(false);
    const trashed = await sql<{ lastAssetId: string; path: string }>`
      SELECT "lastAssetId", path FROM immich_fork.physical_file_trash WHERE "lastAssetId" = ${copy.id}::uuid
    `.execute(database);
    expect(trashed.rows).toHaveLength(1);
    expect(existsSync(trashed.rows[0].path)).toBe(true);
    expect(final.bytesFreed).toBe(photo.length);

    // the damaged copy is left exactly where it was; its group uses the good file
    expect(await assetRow(damaged.id)).toMatchObject({ originalPath: damaged.originalPath });
    expect(existsSync(damaged.originalPath)).toBe(true);
    expect((await assetRow(good.id)).originalPath).toBe(good.originalPath);

    // the external original is never relinked: it stays a Missing finding for review
    expect((await assetRow(external.id)).originalPath).toBe(external.originalPath);
    const findings = await new MediaHealthRepository(database).getRunFindingPage({
      runId: final.runId!,
      statuses: [MediaHealthStatus.Missing, MediaHealthStatus.Relinked],
      limit: 10,
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: external.id, status: MediaHealthStatus.Missing }),
        expect.objectContaining({ assetId: missing.id, status: MediaHealthStatus.Relinked }),
      ]),
    );

    // a lone file is untouched
    expect((await assetRow(single.id)).originalPath).toBe(single.originalPath);
    expect(existsSync(single.originalPath)).toBe(true);

    const stored = await ctx.get(SystemMetadataRepository).get(SystemMetadataKey.UniversalStorageMigration);
    expect(stored).toMatchObject({ stage: 'done' });
  });
});
