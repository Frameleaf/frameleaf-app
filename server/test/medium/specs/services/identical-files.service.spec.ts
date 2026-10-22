import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { ChecksumAlgorithm, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { IdenticalFilesRepository } from 'src/repositories/identical-files.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  IdenticalFilesService,
  ORPHAN_SETTLE_MS,
  RECOVERED_MEDIA_ALBUM,
} from 'src/services/identical-files.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-413 with real files and Postgres: the identical-files run reads every original from disk, shares the
 * oldest copy across people, merges identical photos inside a library through the owner's duplicate
 * decision job, recovers orphans into Recovered Media, and never removes a byte that is not proven kept.
 */
let database: Kysely<DB>;
let media: string;

beforeEach(async () => {
  // every test gets its own database: a run reads the whole server
  database = await getKyselyDB();
  media = await mkdtemp(join(tmpdir(), 'fl413-'));
  StorageCore.setMediaLocation(media);
});

afterEach(async () => {
  await chmod(media, 0o755).catch(() => {});
  await rm(media, { recursive: true, force: true });
});

const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const old = new Date(Date.now() - 2 * ORPHAN_SETTLE_MS);

const write = async (path: string, bytes: Buffer, mtime = old) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await utimes(path, mtime, mtime);
};

const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [
      AssetRepository,
      AlbumRepository,
      LibraryRepository,
      PhysicalFileRepository,
      PhysicalFileTrashRepository,
      UserRepository,
    ],
    mock: [LoggingRepository],
  });
  const jobs = {
    queue: vi.fn().mockResolvedValue(undefined),
    isPaused: vi.fn().mockResolvedValue(false),
    hasDedupJob: vi.fn().mockResolvedValue(false),
  };
  const createBulk = vi.fn().mockResolvedValue({ id: randomUUID() });
  const crypto = new CryptoRepository();
  // the media check's decode is its own spec's; here a file starting "BROKEN" is damaged
  const integrity = {
    validate: vi.fn(async ({ path }: { path: string }) => {
      const bytes = await readFile(path);
      if (bytes.subarray(0, 6).toString() === 'BROKEN') {
        return { status: 'corrupt', reason: 'decode_failed' };
      }
      return { status: 'healthy', reason: 'verified', ...(await crypto.hashFileDigests(path)), identity: {} };
    }),
  };
  const metadata = new SystemMetadataRepository(database);
  const sut = new IdenticalFilesService(
    LoggingRepository.create(),
    new IdenticalFilesRepository(database),
    ctx.get(AssetRepository),
    ctx.get(AlbumRepository),
    new AssetChecksumRepository(database),
    crypto,
    { withLock: (_lock: unknown, callback: () => Promise<unknown>) => callback() } as unknown as DatabaseRepository,
    { emit: vi.fn() } as never,
    jobs as never,
    ctx.get(PhysicalFileRepository),
    ctx.get(PhysicalFileTrashRepository),
    new StorageRepository(LoggingRepository.create()),
    metadata,
    ctx.get(UserRepository),
    integrity as unknown as MediaIntegrityService,
    { createBulk } as unknown as MediaOperationService,
  );

  /** A photo as the Immich importer leaves it: its file on disk, a SHA-1 record, no storage record. */
  const photo = async (ownerId: string, path: string, bytes: Buffer, createdAt: Date, dto: object = {}) => {
    await write(path, bytes);
    const { asset } = await ctx.newAsset({
      ownerId,
      originalPath: path,
      originalFileName: path.split('/').at(-1)!,
      checksum: sha1(bytes),
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      createdAt,
      ...dto,
    });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: bytes.length });
    return asset;
  };
  const user = async (label: string) =>
    (await ctx.newUser({ storageLabel: `${label}${randomUUID().slice(0, 6)}` })).user;
  const row = (id: string) =>
    database
      .selectFrom('asset')
      .select([
        'id',
        'originalPath',
        'libraryPath',
        'checksum',
        'checksumAlgorithm',
        'physicalOriginalFileId',
        'duplicateId',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const unused = () =>
    sql<{ id: string; path: string; lastAssetId: string | null; lastOwnerId: string | null }>`
      SELECT id, path, "lastAssetId", "lastOwnerId" FROM public.physical_file_trash`
      .execute(database)
      .then(({ rows }) => rows);
  const run = async () => {
    await sut.check({ user: { id: (await user('admin')).id } } as never);
    return sut.handleCheck({ resume: true });
  };
  return { ctx, sut, jobs, createBulk, integrity, metadata, photo, user, row, unused, run };
};

describe(IdenticalFilesService.name, () => {
  it('reads every original, upgrades SHA-1 records and registers their files', async () => {
    const { photo, user, row, run, sut } = setup();
    const alice = await user('alice');
    const bytes = Buffer.from('a photo of the beach');
    const asset = await photo(alice.id, join(media, 'library', alice.storageLabel!, 'beach.jpg'), bytes, old);

    await expect(run()).resolves.toBe(JobStatus.Success);

    expect(await row(asset.id)).toMatchObject({
      checksum: sha256(bytes),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      physicalOriginalFileId: expect.any(String),
    });
    const { rows } = await sql<{
      sha1: Buffer;
    }>`SELECT sha1 FROM public.asset_checksum WHERE "assetId" = ${asset.id}::uuid`.execute(database);
    // devices keep seeing the SHA-1
    expect(rows[0].sha1).toEqual(sha1(bytes));
    const status = await sut.getStatus();
    expect(status).toMatchObject({
      status: 'completed',
      stage: 'done',
      counts: { scanned: 1, upgraded: 1, registered: 1 },
    });
  });

  it('leaves a photo whose file no longer holds its recorded bytes alone', async () => {
    const { photo, user, row, run, sut } = setup();
    const alice = await user('alice');
    const path = join(media, 'library', alice.storageLabel!, 'changed.jpg');
    const asset = await photo(alice.id, path, Buffer.from('recorded'), old);
    await write(path, Buffer.from('something else'));

    await run();

    expect(await row(asset.id)).toMatchObject({
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      physicalOriginalFileId: null,
    });
    expect((await sut.getStatus()).problems).toContainEqual(
      expect.objectContaining({ kind: 'changed', assetId: asset.id }),
    );
  });

  it('shares the oldest file across people and moves the other copy to Unused files, never removing bytes', async () => {
    const { photo, user, row, unused, run, sut } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const bytes = Buffer.from('the same holiday photo');
    const alicePath = join(media, 'library', alice.storageLabel!, 'Holidays', 'IMG_1.jpg');
    const bobPath = join(media, 'library', bob.storageLabel!, '2023', 'IMG_1.jpg');
    const kept = await photo(alice.id, alicePath, bytes, new Date('2020-01-01'));
    const linked = await photo(bob.id, bobPath, bytes, new Date('2021-01-01'));

    await run();

    expect(await row(linked.id)).toMatchObject({ originalPath: alicePath, libraryPath: bobPath });
    expect(await row(kept.id)).toMatchObject({ originalPath: alicePath, libraryPath: null });
    expect(await readFile(alicePath)).toEqual(bytes);
    expect(await exists(bobPath)).toBe(false);
    const [entry] = await unused();
    expect(entry).toMatchObject({ lastAssetId: linked.id, lastOwnerId: bob.id });
    expect(await readFile(entry.path)).toEqual(bytes);
    expect((await sut.getChanges(linked.id))[0]).toMatchObject({
      kind: 'link',
      keptAssetId: kept.id,
      restorable: true,
    });
    expect((await sut.getStatus()).counts).toMatchObject({
      linked: 1,
      filesMovedToUnused: 1,
      bytesMovedToUnused: bytes.length,
    });
  });

  it('keeps the next oldest when the oldest file changed, and links nothing onto a changed file', async () => {
    const { photo, user, row, unused, run, jobs, metadata } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const bytes = Buffer.from('identical bytes');
    const alicePath = join(media, 'library', alice.storageLabel!, 'a.jpg');
    const bobPath = join(media, 'library', bob.storageLabel!, 'b.jpg');
    const oldest = await photo(alice.id, alicePath, bytes, new Date('2020-01-01'));
    const newer = await photo(bob.id, bobPath, bytes, new Date('2021-01-01'));
    // the oldest file changes after the scan read it, before the link
    let changed = false;
    jobs.isPaused.mockImplementation(async () => {
      if (!changed && (await metadata.get(SystemMetadataKey.IdenticalFiles))?.stage === 'link') {
        changed = true;
        await write(alicePath, Buffer.from('edited elsewhere'));
      }
      return false;
    });

    await run();

    expect(changed).toBe(true);
    expect(await row(oldest.id)).toMatchObject({ originalPath: alicePath, libraryPath: null });
    expect(await row(newer.id)).toMatchObject({ originalPath: bobPath, libraryPath: null });
    expect(await readFile(bobPath)).toEqual(bytes);
    expect(await unused()).toEqual([]);
  });

  it('stops between batches when the storage queue pauses and carries on without doing anything twice', async () => {
    const { photo, user, row, unused, run, jobs, metadata, sut } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const bytes = Buffer.from('paused mid run');
    const bobPath = join(media, 'library', bob.storageLabel!, 'b.jpg');
    await photo(alice.id, join(media, 'library', alice.storageLabel!, 'a.jpg'), bytes, new Date('2020-01-01'));
    const linked = await photo(bob.id, bobPath, bytes, new Date('2021-01-01'));
    let paused = false;
    jobs.isPaused.mockImplementation(async () => {
      if (!paused && (await metadata.get(SystemMetadataKey.IdenticalFiles))?.stage === 'link') {
        paused = true;
        return true;
      }
      return false;
    });

    await expect(run()).resolves.toBe(JobStatus.Success);
    expect(jobs.queue).toHaveBeenLastCalledWith({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
    expect((await sut.getStatus()).status).toBe('running');
    expect((await row(linked.id)).libraryPath).toBeNull();

    await expect(sut.handleCheck({ resume: true })).resolves.toBe(JobStatus.Success);
    await expect(sut.handleCheck({ resume: true })).resolves.toBe(JobStatus.Skipped);

    expect((await row(linked.id)).libraryPath).toBe(bobPath);
    expect(await unused()).toHaveLength(1);
    expect((await sut.getStatus()).counts).toMatchObject({ scanned: 2, linked: 1 });
  });

  it('restores a photo’s own file on undo, and never links it again', async () => {
    const { photo, user, row, unused, run, sut } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const bytes = Buffer.from('undo me');
    const bobPath = join(media, 'library', bob.storageLabel!, 'b.jpg');
    await photo(alice.id, join(media, 'library', alice.storageLabel!, 'a.jpg'), bytes, new Date('2020-01-01'));
    const linked = await photo(bob.id, bobPath, bytes, new Date('2021-01-01'));
    await run();
    const [change] = await sut.getChanges(linked.id);

    await expect(sut.undoChange(change.id)).resolves.toMatchObject({ undoneAt: expect.any(String), restorable: false });

    expect(await row(linked.id)).toMatchObject({ originalPath: bobPath, libraryPath: null });
    expect(await readFile(bobPath)).toEqual(bytes);
    expect(await unused()).toEqual([]);

    await run();
    expect((await row(linked.id)).originalPath).toBe(bobPath);
    expect((await sut.getStatus()).problems).toContainEqual(
      expect.objectContaining({ kind: 'undone', assetId: linked.id }),
    );
  });

  it('keeps the photo linked but its own file in place when its folder is read-only', async () => {
    const { photo, user, row, unused, run, sut } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const bytes = Buffer.from('read-only folder');
    const bobFolder = join(media, 'library', bob.storageLabel!, 'locked');
    const bobPath = join(bobFolder, 'b.jpg');
    await photo(alice.id, join(media, 'library', alice.storageLabel!, 'a.jpg'), bytes, new Date('2020-01-01'));
    const linked = await photo(bob.id, bobPath, bytes, new Date('2021-01-01'));
    await chmod(bobFolder, 0o555);
    try {
      await run();
    } finally {
      await chmod(bobFolder, 0o755);
    }

    expect((await row(linked.id)).libraryPath).toBe(bobPath);
    expect(await readFile(bobPath)).toEqual(bytes);
    expect(await unused()).toEqual([]);
    expect((await sut.getStatus()).problems).toContainEqual(
      expect.objectContaining({ kind: 'kept-for-now', assetId: linked.id }),
    );
  });

  it('merges identical photos in one library through the owner’s duplicate decision, keeping the oldest', async () => {
    const { photo, user, row, run, createBulk, sut } = setup();
    const carol = await user('carol');
    const bytes = Buffer.from('imported twice');
    const folder = join(media, 'library', carol.storageLabel!);
    // the newer copy was uploaded to Frameleaf after the Immich import: SHA-256, so it was never matched
    const newer = await photo(carol.id, join(folder, 'copy.jpg'), bytes, new Date('2022-01-01'), {
      checksum: sha256(bytes),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const oldest = await photo(carol.id, join(folder, 'first.jpg'), bytes, new Date('2020-01-01'));
    const edited = await photo(
      carol.id,
      join(folder, 'edited.jpg'),
      Buffer.from('edited twin'),
      new Date('2021-01-01'),
    );
    const editedTwin = await photo(
      carol.id,
      join(folder, 'edited-2.jpg'),
      Buffer.from('edited twin'),
      new Date('2022-06-01'),
      { isEdited: true, checksum: sha256(Buffer.from('edited twin')), checksumAlgorithm: ChecksumAlgorithm.sha256File },
    );

    await run();

    expect(createBulk).toHaveBeenCalledTimes(1);
    const [auth, dto] = createBulk.mock.calls[0];
    expect(auth.user.id).toBe(carol.id);
    expect(dto.payload.duplicateGroups).toEqual([
      expect.objectContaining({ decision: 'keepers', memberIds: [oldest.id, newer.id], keepAssetIds: [oldest.id] }),
    ]);
    // the kept photo takes the SHA-256; the one going to the Trash keeps its SHA-1
    expect(await row(oldest.id)).toMatchObject({
      checksum: sha256(bytes),
      duplicateId: dto.payload.duplicateGroups[0].duplicateId,
    });
    expect(await row(newer.id)).toMatchObject({
      checksum: sha1(bytes),
      duplicateId: dto.payload.duplicateGroups[0].duplicateId,
    });
    // an edited twin is listed for review instead
    expect((await sut.getStatus()).problems).toContainEqual(
      expect.objectContaining({ kind: 'check-before-merging', assetId: editedTwin.id, detail: 'edited' }),
    );
    expect((await row(edited.id)).duplicateId).toEqual((await row(editedTwin.id)).duplicateId);
  });

  it('recovers orphans into Recovered Media, by owner and content, and never imports damaged or settling files', async () => {
    const { photo, user, unused, run, sut } = setup();
    const dave = await user('dave');
    const erin = await user('erin');
    const daveFolder = join(media, 'library', dave.storageLabel!);
    const known = Buffer.from('dave already has this');
    await photo(dave.id, join(daveFolder, 'kept.jpg'), known, old);
    const erinBytes = Buffer.from('erin holds this content');
    const erinPhoto = await photo(erin.id, join(media, 'library', erin.storageLabel!, 'e.jpg'), erinBytes, old);

    await write(join(daveFolder, 'lost', 'new.jpg'), Buffer.from('a forgotten photo'));
    await write(join(daveFolder, 'lost', 'dup.jpg'), known);
    await write(join(daveFolder, 'lost', 'shared.jpg'), erinBytes);
    await write(join(daveFolder, 'lost', 'broken.jpg'), Buffer.from('BROKEN upload'));
    await write(join(daveFolder, 'lost', 'fresh.jpg'), Buffer.from('still uploading'), new Date());
    await write(join(daveFolder, '.frameleaf', 'hidden.jpg'), Buffer.from('internal'));
    await write(join(media, 'upload', dave.id, 'ab', 'cd', 'up.jpg'), Buffer.from('an orphaned upload'));

    await run();

    const status = await sut.getStatus();
    expect(status.counts).toMatchObject({ orphansFound: 5, photosRecovered: 3, orphanDuplicates: 1, damaged: 1 });
    expect(status.recovered).toEqual([{ ownerId: dave.id, photos: 3, albumId: expect.any(String) }]);
    const album = await sql<{ albumName: string; assets: number }>`
      SELECT a."albumName", (SELECT count(*)::int FROM public.album_asset aa WHERE aa."albumId" = a.id) AS assets
      FROM public.album a WHERE a.id = ${status.recovered[0].albumId}::uuid`.execute(database);
    expect(album.rows[0]).toEqual({ albumName: RECOVERED_MEDIA_ALBUM, assets: 3 });
    // imported in place
    const imported = await database
      .selectFrom('asset')
      .select(['originalPath', 'libraryPath'])
      .where('ownerId', '=', dave.id)
      .execute();
    expect(imported.map(({ originalPath }) => originalPath)).toEqual(
      expect.arrayContaining([
        join(daveFolder, 'lost', 'new.jpg'),
        join(media, 'upload', dave.id, 'ab', 'cd', 'up.jpg'),
      ]),
    );
    // the content Erin holds comes back sharing her file, shown at Dave's own path
    expect(imported).toContainEqual({
      originalPath: erinPhoto.originalPath,
      libraryPath: join(daveFolder, 'lost', 'shared.jpg'),
    });
    // the duplicate, the shared copy and the damaged file wait in Unused files; nothing was deleted
    expect((await unused()).map(({ path }) => path.split('/').at(-1)!).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'broken.jpg',
      'dup.jpg',
      'shared.jpg',
    ]);
    expect(await exists(join(daveFolder, 'lost', 'fresh.jpg'))).toBe(true);
    expect(await exists(join(daveFolder, '.frameleaf', 'hidden.jpg'))).toBe(true);
  });

  it('adds later recoveries to the same Recovered Media album, even after a rename', async () => {
    const { user, run, sut } = setup();
    const frank = await user('frank');
    const folder = join(media, 'library', frank.storageLabel!);
    await write(join(folder, 'one.jpg'), Buffer.from('first orphan'));
    await run();
    const albumId = (await sut.getStatus()).recovered[0].albumId!;
    await database.updateTable('album').set({ albumName: 'Found again' }).where('id', '=', albumId).execute();

    await write(join(folder, 'two.jpg'), Buffer.from('second orphan'));
    await run();

    expect((await sut.getStatus()).recovered).toEqual([{ ownerId: frank.id, photos: 1, albumId }]);
    const { rows } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM public.album a
      JOIN public.album_user u ON u."albumId" = a.id WHERE u."userId" = ${frank.id}::uuid`.execute(database);
    expect(rows[0].count).toBe(1);
  });

  it('never touches an external library', async () => {
    const { ctx, photo, user, row, run } = setup();
    const gina = await user('gina');
    const hank = await user('hank');
    const library = await ctx.get(LibraryRepository).create({
      ownerId: gina.id,
      name: 'external',
      importPaths: [join(media, 'external')],
      exclusionPatterns: [],
    });
    const bytes = Buffer.from('on an external drive');
    const external = await photo(gina.id, join(media, 'external', 'x.jpg'), bytes, new Date('2019-01-01'), {
      libraryId: library.id,
      isExternal: true,
    });
    const managed = await photo(
      hank.id,
      join(media, 'library', hank.storageLabel!, 'x.jpg'),
      bytes,
      new Date('2021-01-01'),
    );

    await run();

    expect(await row(external.id)).toMatchObject({
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      physicalOriginalFileId: null,
    });
    expect((await row(managed.id)).libraryPath).toBeNull();
  });

  it('reads a library larger than one batch', async () => {
    const { photo, user, run, sut } = setup();
    const ivy = await user('ivy');
    for (let index = 0; index < 250; index++) {
      await photo(
        ivy.id,
        join(media, 'library', ivy.storageLabel!, `${index}.jpg`),
        Buffer.from(`photo ${index}`),
        old,
      );
    }

    await run();

    expect((await sut.getStatus()).counts).toMatchObject({ scanned: 250, upgraded: 250, registered: 250, problems: 0 });
  });
});
