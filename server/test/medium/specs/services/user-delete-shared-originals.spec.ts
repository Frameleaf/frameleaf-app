import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetFileType, StorageFolder, UserStatus } from 'src/enum.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { UserService } from 'src/services/user.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-44 (FN-304): deleting an owner never removes a file another owner's asset still references.
 * Real database, real reference-guarded deletes and real files in an isolated media location.
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
  mediaLocation = await mkdtemp(join(tmpdir(), 'fl44-user-delete-'));
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

const setup = (masterUserId: string | null) => {
  const { sut, ctx } = newMediumService(UserService, {
    database,
    real: [
      AssetRepository,
      ConfigRepository,
      ForkSchemaRepository,
      PhysicalFileRepository,
      StorageRepository,
      UserRepository,
    ],
    mock: [
      AlbumRepository,
      AlbumUserRepository,
      EventRepository,
      JobRepository,
      LoggingRepository,
      SystemMetadataRepository,
    ],
  });
  ctx
    .getMock(SystemMetadataRepository)
    .get.mockResolvedValue({ physicalDeduplication: { enabled: !!masterUserId, masterUserId } } as never);
  ctx.getMock(AlbumRepository).deleteAll.mockResolvedValue();
  ctx.getMock(AlbumUserRepository).forgetRecipient.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  return { sut, ctx };
};

const writeMedia = async (path: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, randomBytes(64));
  return path;
};

/** A retained original in `owner`'s library that `other` has a deduplicated copy of, plus an unshared file. */
const seedSharedOriginal = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user: owner } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const library = StorageCore.getLibraryFolder({ id: owner.id, storageLabel: null });
  const sharedPath = await writeMedia(join(library, '2024', `${randomUUID()}-shared.jpg`));
  const ownPath = await writeMedia(join(library, '2024', `${randomUUID()}-own.jpg`));
  const sharedThumb = await writeMedia(
    join(StorageCore.getFolderLocation(StorageFolder.Thumbnails, owner.id), `${randomUUID()}-thumbnail.webp`),
  );
  const checksum = randomBytes(20);

  const { asset: retained } = await ctx.newAsset({ ownerId: owner.id, checksum, originalPath: sharedPath });
  await ctx.newExif({ assetId: retained.id, fileSizeInByte: 64 });
  const { asset: unshared } = await ctx.newAsset({ ownerId: owner.id, originalPath: ownPath });
  await ctx.newExif({ assetId: unshared.id, fileSizeInByte: 64 });

  const physical = await ctx.get(PhysicalFileRepository).ensureOriginalPhysicalFile(retained.id);
  const { asset: copy } = await ctx.newAsset({ ownerId: other.id, checksum, originalPath: sharedPath });
  await ctx.newExif({ assetId: copy.id, fileSizeInByte: 64 });
  await ctx.get(PhysicalFileRepository).linkAssetToOriginalPhysicalFile(copy.id, physical!);
  // the copy's thumbnail is the retained account's generated file (derivative dedup)
  await ctx.newAssetFile({ assetId: copy.id, type: AssetFileType.Thumbnail, path: sharedThumb });

  await database
    .updateTable('user')
    .set({ status: UserStatus.Removing, deletedAt: new Date() })
    .where('id', '=', owner.id)
    .execute();

  return { owner, other, copy, physical: physical!, library, sharedPath, ownPath, sharedThumb };
};

describe('UserService.handleUserDelete with shared originals (FL-44)', () => {
  it('keeps an original and a thumbnail another owner references and removes only the owner', async () => {
    const { sut, ctx } = setup(null);
    const { owner, copy, physical, sharedPath, ownPath, sharedThumb } = await seedSharedOriginal(ctx);

    await sut.handleUserDelete({ id: owner.id, force: true });

    expect(existsSync(sharedPath)).toBe(true);
    expect(existsSync(sharedThumb)).toBe(true);
    expect(existsSync(ownPath)).toBe(false);
    await expect(
      database.selectFrom('user').select('id').where('id', '=', owner.id).executeTakeFirst(),
    ).resolves.toBeUndefined();
    // the other owner's copy still resolves to the same physical original
    await expect(
      database
        .selectFrom('asset')
        .select(['originalPath', 'physicalOriginalFileId'])
        .where('id', '=', copy.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ originalPath: sharedPath, physicalOriginalFileId: physical.id });
    await expect(ctx.get(PhysicalFileRepository).getPhysicalFile(physical.id)).resolves.toMatchObject({
      path: sharedPath,
    });
  });

  it('refuses to delete the retained account while it is configured, and removes nothing', async () => {
    const { ctx } = setup(null);
    const { owner, sharedPath, ownPath } = await seedSharedOriginal(ctx);
    clearConfigCache();
    const { sut } = setup(owner.id);

    await sut.handleUserDelete({ id: owner.id, force: true });

    expect(existsSync(sharedPath)).toBe(true);
    expect(existsSync(ownPath)).toBe(true);
    await expect(
      database.selectFrom('user').select('id').where('id', '=', owner.id).executeTakeFirst(),
    ).resolves.toEqual({ id: owner.id });
    await expect(
      database.selectFrom('asset').select('id').where('ownerId', '=', owner.id).execute(),
    ).resolves.toHaveLength(2);
  });

  it('removes the shared original once the last owner referencing it is deleted too', async () => {
    const { sut, ctx } = setup(null);
    const { owner, other, sharedPath } = await seedSharedOriginal(ctx);

    await sut.handleUserDelete({ id: owner.id, force: true });
    expect(existsSync(sharedPath)).toBe(true);

    await database
      .updateTable('user')
      .set({ status: UserStatus.Removing, deletedAt: new Date() })
      .where('id', '=', other.id)
      .execute();
    await sut.handleUserDelete({ id: other.id, force: true });
    // the other owner's copy lived in the first owner's library, so the queued FileDelete removes it
    const queued = ctx
      .getMock(JobRepository)
      .queue.mock.calls.flatMap(([job]) => ((job as { data?: { files?: string[] } }).data?.files ?? []) as string[]);
    expect(queued).toContain(sharedPath);
    await expect(
      ctx
        .get(PhysicalFileRepository)
        .deleteUnreferencedPath(sharedPath, () => ctx.get(StorageRepository).unlink(sharedPath)),
    ).resolves.toEqual({ deleted: true, references: 0 });
    expect(existsSync(sharedPath)).toBe(false);
  });
});
