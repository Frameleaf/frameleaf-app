import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { StorageCore } from 'src/cores/storage.core.js';
import { PhysicalFileType } from 'src/enum.js';
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
      expect(unlink).toHaveBeenCalledWith(second.result.entry.path);
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
        { exists: () => Promise.resolve(true), untrash },
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
