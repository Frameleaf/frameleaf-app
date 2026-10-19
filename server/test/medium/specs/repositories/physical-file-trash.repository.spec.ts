import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetType, AssetVisibility, ChecksumAlgorithm, PhysicalFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
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
  return { ctx, files: ctx.get(PhysicalFileRepository), sut: ctx.get(PhysicalFileTrashRepository) };
};

const newAssetWithSize = async (ctx: MediumTestContext, ownerId: string, dto: object = {}) => {
  const { asset } = await ctx.newAsset({ ownerId, originalPath: `/data/upload/${randomUUID()}.jpg`, ...dto });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1000 });
  return asset;
};

const trashRows = (checksum: Buffer) =>
  sql<{ path: string; lastOwnerId: string | null }>`
    SELECT path, "lastOwnerId" FROM public.physical_file_trash WHERE checksum = ${checksum}`.execute(defaultDatabase);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

// FL-412: a stored file is stood in for by its path: proven to hold the content, with a fixed identity
const onDisk = (path: string) => Promise.resolve(`identity:${path}`);

describe(PhysicalFileTrashRepository.name, () => {
  describe('deleteUnreferencedPath with the file trash', () => {
    it('moves the last copy of an original to the file trash instead of unlinking it', async () => {
      const { ctx, files } = setup();
      const { user } = await ctx.newUser();
      const checksum = randomBytes(32);
      const asset = await newAssetWithSize(ctx, user.id, { checksum });
      const physical = (await files.ensureOriginalPhysicalFile(asset.id))!;
      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
      const unlink = vi.fn();
      const move = vi.fn().mockResolvedValue(undefined);

      const result = await files.deleteUnreferencedPath(asset.originalPath, unlink, {
        removedAssetId: asset.id,
        trash: {
          move,
          original: { checksum, sizeInBytes: 1000, ownerId: user.id, assetId: asset.id, originalFileName: 'a.jpg' },
        },
      });

      expect(result).toEqual({ deleted: true, references: 0, trashed: true });
      expect(unlink).not.toHaveBeenCalled();
      expect(move).toHaveBeenCalledWith(asset.originalPath, expect.stringMatching(/\/file-trash\/[\da-f-]+\/a\.jpg$/));
      await expect(trashRows(checksum)).resolves.toMatchObject({
        rows: [{ path: move.mock.calls[0][1], lastOwnerId: user.id }],
      });
      await expect(files.getPhysicalFile(physical.id)).resolves.toBeUndefined();
      // the trashed file is itself a reference: no later delete can unlink it
      await expect(files.deleteUnreferencedPath(move.mock.calls[0][1], unlink)).resolves.toMatchObject({
        deleted: false,
      });
    });

    it('still deletes generated files outright', async () => {
      const { ctx, files } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const preview = await files.upsertPhysicalFile({
        canonicalAssetId: asset.id,
        checksum: randomBytes(20),
        path: `/data/thumbs/${randomUUID()}-preview.jpg`,
        sizeInBytes: 100,
        type: PhysicalFileType.Preview,
      });
      const unlink = vi.fn().mockResolvedValue(undefined);
      const move = vi.fn();

      await expect(files.deleteUnreferencedPath(preview.path, unlink, { trash: { move } })).resolves.toEqual({
        deleted: true,
        references: 0,
      });
      expect(unlink).toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    });

    it('keeps an original another asset still references', async () => {
      const { ctx, files } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      await files.ensureOriginalPhysicalFile(asset.id);
      const move = vi.fn();

      await expect(files.deleteUnreferencedPath(asset.originalPath, vi.fn(), { trash: { move } })).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(move).not.toHaveBeenCalled();
    });
  });

  describe('trash, untrash and purge', () => {
    it('rolls back asset, EXIF and original linking together with a failed restore registration', async () => {
      const { ctx, sut, files } = setup();
      const { user } = await ctx.newUser();
      const directory = await mkdtemp(join(tmpdir(), 'frameleaf-restore-registration-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const source = join(directory, 'trashed.jpg');
      const target = join(directory, 'restored.jpg');
      const id = randomUUID();
      const assetId = randomUUID();
      const checksum = randomBytes(32);
      const bytes = Buffer.from('private transactional restore control');
      await writeFile(source, bytes);
      await sql`INSERT INTO public.physical_file_trash
        (id, path, checksum, "sizeInBytes", "originalFileName", "lastOwnerId")
        VALUES (${id}::uuid, ${source}, ${checksum}, ${bytes.length}, 'photo.jpg', ${user.id}::uuid)`.execute(
        defaultDatabase,
      );
      const assets = new AssetRepository(defaultDatabase);
      const failure = new Error('registration interrupted');
      const timestamp = new Date();

      await expect(
        sut.untrash(id, target, rename, async (trx) => {
          await assets.create(
            {
              id: assetId,
              ownerId: user.id,
              libraryId: null,
              checksum,
              checksumAlgorithm: ChecksumAlgorithm.sha256File,
              originalPath: target,
              originalFileName: 'photo.jpg',
              fileCreatedAt: timestamp,
              fileModifiedAt: timestamp,
              localDateTime: timestamp,
              type: AssetType.Image,
              isFavorite: false,
              duration: null,
              visibility: AssetVisibility.Timeline,
              livePhotoVideoId: null,
            },
            undefined,
            trx,
          );
          await assets.upsertExif(
            { exif: { assetId, fileSizeInByte: bytes.length }, lockedPropertiesBehavior: 'override' },
            trx,
          );
          const stored = await files.linkUploadedOriginal(
            assetId,
            { checksum, sizeInBytes: bytes.length },
            { verify: onDisk, identify: onDisk },
            { transaction: trx, proof: undefined },
          );
          expect(stored).toMatchObject({ linked: false });
          throw failure;
        }),
      ).rejects.toBe(failure);

      await expect(readFile(source)).resolves.toEqual(bytes);
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(sut.getById(id)).resolves.toMatchObject({ path: source });
      for (const table of ['asset', 'asset_exif'] as const) {
        const rows =
          table === 'asset'
            ? await defaultDatabase.selectFrom(table).select('id').where('id', '=', assetId).execute()
            : await defaultDatabase.selectFrom(table).select('assetId').where('assetId', '=', assetId).execute();
        expect(rows).toEqual([]);
      }
      const originals = await defaultDatabase
        .selectFrom('physical_file')
        .select('id')
        .where('checksum', '=', checksum)
        .execute();
      expect(originals).toEqual([]);
    });

    it('recovers a surviving restore journal through a fresh repository', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'frameleaf-restore-restart-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const source = join(directory, 'trashed.jpg');
      const target = join(directory, 'restored.jpg');
      const id = randomUUID();
      const intentId = randomUUID();
      const bytes = Buffer.from('private surviving restore journal control');
      await writeFile(target, bytes);
      await sql`INSERT INTO public.physical_file_trash
        (id, path, checksum, "sizeInBytes", "originalFileName")
        VALUES (${id}::uuid, ${source}, ${randomBytes(32)}, ${bytes.length}, 'photo.jpg')`.execute(defaultDatabase);
      await sql`INSERT INTO public.move_history (id, "entityId", "pathType", "oldPath", "newPath")
        VALUES (${intentId}::uuid, ${intentId}::uuid, 'file_trash', ${source}, ${target})`.execute(defaultDatabase);

      await new PhysicalFileTrashRepository(defaultDatabase).recoverMoves(rename);

      await expect(readFile(source)).resolves.toEqual(bytes);
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      const remaining = await defaultDatabase
        .selectFrom('move_history')
        .select('id')
        .where('id', '=', intentId)
        .execute();
      expect(remaining).toEqual([]);
    });

    it('recovers an untrash move that completed before its callback rejected', async () => {
      const { sut } = setup();
      const directory = await mkdtemp(join(tmpdir(), 'frameleaf-untrash-rollback-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const source = join(directory, 'trashed.jpg');
      const target = join(directory, 'restored.jpg');
      const id = randomUUID();
      const checksum = randomBytes(32);
      const bytes = Buffer.from('private untrash rollback control');
      await writeFile(source, bytes);
      await sql`INSERT INTO public.physical_file_trash
        (id, path, checksum, "sizeInBytes", "originalFileName")
        VALUES (${id}::uuid, ${source}, ${checksum}, ${bytes.length}, 'photo.jpg')`.execute(defaultDatabase);
      const failure = new Error('move acknowledgement failed');
      const move = vi.fn(async (from: string, to: string) => {
        await rename(from, to);
        if (from === source) throw failure;
      });

      await expect(sut.untrash(id, target, move)).rejects.toBe(failure);

      await expect(readFile(source)).resolves.toEqual(bytes);
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(sut.getById(id)).resolves.toMatchObject({ path: source });
      const journal = await sql`SELECT id FROM public.move_history
        WHERE "pathType" = 'file_trash' AND "oldPath" = ${source}`.execute(defaultDatabase);
      expect(journal.rows).toEqual([]);
      expect(move).toHaveBeenLastCalledWith(target, source);
    });

    const trashOne = async (
      ctx: MediumTestContext,
      sut: PhysicalFileTrashRepository,
      files: PhysicalFileRepository,
    ) => {
      const { user } = await ctx.newUser();
      const checksum = randomBytes(32);
      const asset = await newAssetWithSize(ctx, user.id, { checksum });
      const physical = (await files.ensureOriginalPhysicalFile(asset.id))!;
      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
      const result = await sut.trash(
        {
          physicalFileId: physical.id,
          path: asset.originalPath,
          checksum,
          sizeInBytes: 1000,
          lastOwnerId: user.id,
          lastAssetId: asset.id,
          originalFileName: 'IMG_1.jpg',
        },
        vi.fn().mockResolvedValue(undefined),
      );
      return { user, checksum, asset, physical, result };
    };

    it('trashes an unreferenced original once and finds it by content', async () => {
      const { ctx, sut, files } = setup();
      const { checksum, physical, result } = await trashOne(ctx, sut, files);

      expect(result).toMatchObject({ status: 'trashed', entry: { physicalFileId: physical.id, sizeInBytes: 1000 } });
      await expect(sut.findByChecksum(checksum, 1000)).resolves.toMatchObject({ originalFileName: 'IMG_1.jpg' });
      await expect(sut.findByChecksum(checksum, 999)).resolves.toBeUndefined();
      const listed = await sut.list({ skip: 0, take: 500 });
      expect(listed.items.map(({ id }) => id)).toContain(result.status === 'trashed' && result.entry.id);
      expect(listed.totalBytes).toBeGreaterThanOrEqual(1000);
    });

    it('reports a missing file and keeps its physical file row', async () => {
      const { ctx, sut, files } = setup();
      const { user } = await ctx.newUser();
      const asset = await newAssetWithSize(ctx, user.id);
      const physical = (await files.ensureOriginalPhysicalFile(asset.id))!;
      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
      const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });

      const result = await sut.trash(
        {
          physicalFileId: physical.id,
          path: physical.path,
          checksum: physical.checksum,
          sizeInBytes: 1000,
          lastOwnerId: user.id,
          lastAssetId: asset.id,
          originalFileName: 'x.jpg',
        },
        vi.fn().mockRejectedValue(gone),
      );

      expect(result).toEqual({ status: 'missing' });
      await expect(files.getPhysicalFile(physical.id)).resolves.toBeDefined();
    });

    it('untrashes to a target and purges permanently', async () => {
      const { ctx, sut, files } = setup();
      const first = await trashOne(ctx, sut, files);
      const second = await trashOne(ctx, sut, files);
      if (first.result.status !== 'trashed' || second.result.status !== 'trashed') {
        throw new Error('not trashed');
      }
      const move = vi.fn().mockResolvedValue(undefined);
      const unlink = vi.fn().mockResolvedValue(undefined);

      await expect(sut.untrash(first.result.entry.id, '/data/upload/restored.jpg', move)).resolves.toMatchObject({
        id: first.result.entry.id,
      });
      expect(move).toHaveBeenCalledWith(first.result.entry.path, '/data/upload/restored.jpg');
      await expect(sut.getById(first.result.entry.id)).resolves.toBeUndefined();

      await expect(sut.purge(second.result.entry.id, unlink)).resolves.toMatchObject({ id: second.result.entry.id });
      expect(unlink).toHaveBeenCalledWith(
        second.result.entry.path,
        expect.objectContaining({ id: second.result.entry.id }),
      );
      await expect(sut.getById(second.result.entry.id)).resolves.toBeUndefined();
    });
  });

  describe('upload linking (Review Focus 3)', () => {
    it('takes content in the file trash back out and links it, never storing a second copy', async () => {
      const { ctx, sut, files } = setup();
      const { user } = await ctx.newUser();
      const checksum = randomBytes(32);
      const old = await newAssetWithSize(ctx, user.id, { checksum });
      const physical = (await files.ensureOriginalPhysicalFile(old.id))!;
      await defaultDatabase.deleteFrom('asset').where('id', '=', old.id).execute();
      await sut.trash(
        {
          physicalFileId: physical.id,
          path: physical.path,
          checksum,
          sizeInBytes: 1000,
          lastOwnerId: user.id,
          lastAssetId: old.id,
          originalFileName: 'IMG_1.jpg',
        },
        vi.fn().mockResolvedValue(undefined),
      );
      const { user: partner } = await ctx.newUser();
      const upload = await newAssetWithSize(ctx, partner.id, { checksum });
      const untrash = vi.fn().mockResolvedValue(undefined);

      const result = await files.linkUploadedOriginal(
        upload.id,
        { checksum, sizeInBytes: 1000 },
        { verify: onDisk, identify: onDisk, untrash },
      );

      expect(result).toMatchObject({ linked: true, physicalFile: { canonicalAssetId: upload.id } });
      expect(untrash).toHaveBeenCalledWith(expect.stringContaining('/file-trash/'), result!.physicalFile.path);
      await expect(trashRows(checksum)).resolves.toMatchObject({ rows: [] });
      const rows = await defaultDatabase
        .selectFrom('physical_file')
        .select('id')
        .where('checksum', '=', checksum)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });
});
