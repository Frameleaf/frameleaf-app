import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetPathType,
  AssetStatus,
  AssetVisibility,
  JobName,
  JobStatus,
  PhysicalFileType,
  SharedLinkType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      DuplicateRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      PersonRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository, WebsocketRepository],
  });

  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
  // FL-90: a move into the Locked folder announces AssetLocked so Studio previews stop.
  ctx.getMock(EventRepository).emit.mockResolvedValue();

  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetService.name, () => {
  describe('get', () => {
    it('should not return an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.get(factory.auth({ user: otherUser }), asset.id)).rejects.toThrow(
        'Not found or no asset.read access',
      );
    });
  });

  describe('getStatistics', () => {
    it('should return stats as numbers, not strings', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });
      const auth = factory.auth({ user: { id: user.id } });
      await expect(sut.getStatistics(auth, {})).resolves.toEqual({ images: 1, total: 1, videos: 0 });
    });
  });

  describe('copy', () => {
    it('should copy albums', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: oldAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(albumRepo.getAssetIds(album.id, [oldAsset.id, newAsset.id])).resolves.toEqual(
        new Set([oldAsset.id, newAsset.id]),
      );
    });

    it('should copy shared links', async () => {
      const { sut, ctx } = setup();
      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const { id: sharedLinkId } = await sharedLinkRepo.create({
        allowUpload: false,
        key: Buffer.from('123'),
        type: SharedLinkType.Individual,
        userId: user.id,
        assetIds: [oldAsset.id],
      });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });
      await expect(sharedLinkRepo.get(user.id, sharedLinkId)).resolves.toEqual(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: oldAsset.id }), expect.objectContaining({ id: newAsset.id })],
        }),
      );
    });

    it('should merge stacks', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });
      await ctx.newExif({ assetId: asset2.id, description: 'foo' });

      await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const {
        stack: { id: newStackId },
      } = await ctx.newStack({ ownerId: user.id }, [newAsset.id, asset2.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(stackRepo.getById(oldAsset.id)).resolves.toEqual(undefined);

      const newStack = await stackRepo.getById(newStackId);
      expect(newStack).toEqual(
        expect.objectContaining({
          primaryAssetId: newAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: asset2.id })]),
        }),
      );
      expect(newStack!.assets.length).toEqual(4);
    });

    it('should copy stack', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const {
        stack: { id: stackId },
      } = await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      const stack = await stackRepo.getById(stackId);
      expect(stack).toEqual(
        expect.objectContaining({
          primaryAssetId: oldAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: newAsset.id })]),
        }),
      );
      expect(stack!.assets.length).toEqual(3);
    });

    it('should copy favorite status', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(assetRepo.getById(newAsset.id)).resolves.toEqual(expect.objectContaining({ isFavorite: true }));
    });

    it('should copy sidecar file', async () => {
      const { sut, ctx } = setup();
      const storageRepo = ctx.getMock(StorageRepository);
      const jobRepo = ctx.getMock(JobRepository);

      storageRepo.copyFile.mockResolvedValue();
      jobRepo.queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: oldAsset.id,
        path: '/path/to/my/sidecar.xmp',
        type: AssetFileType.Sidecar,
      });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      expect(storageRepo.copyFile).toHaveBeenCalledWith('/path/to/my/sidecar.xmp', `${newAsset.originalPath}.xmp`);

      expect(jobRepo.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: newAsset.id },
      });
    });
  });

  describe('delete', () => {
    it('should delete asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      const sidecarPath = '/path/to/sidecar.xmp';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath, sidecarPath, asset.originalPath], removedAssetId: asset.id },
      });
    });

    it('should delete a stacked primary asset (2 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);

      const stackRepo = ctx.get(StackRepository);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(stackRepo.getById(stack.id)).resolves.toBe(undefined);
    });

    it('should delete a stacked primary asset (3 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // new primary asset is picked
      await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toMatchObject({ primaryAssetId: asset2.id });
    });

    it('should delete a stacked primary asset (3 trashed assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      await ctx.get(AssetRepository).updateAll([asset1.id, asset2.id, asset3.id], {
        deletedAt: new Date(),
        status: AssetStatus.Deleted,
      });

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toBe(undefined);
    });

    it('should not delete offline assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isOffline: true, deletedAt: new Date() });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: `/path/to/sidecar.xmp` }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath], removedAssetId: asset.id },
      });
    });

    it('skips an asset restored after its deletion was queued (FL-71)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ id: asset.id });
      expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.FileDelete }),
      );
    });

    describe('file cleanup that survives a failure (FL-169)', () => {
      let forkDatabase: Kysely<DB>;

      beforeAll(async () => {
        forkDatabase = await getActiveForkKyselyDB();
      });

      const fileDeletes = (ctx: ReturnType<typeof setup>['ctx']) =>
        ctx
          .getMock(JobRepository)
          .queue.mock.calls.flatMap(([job]) => (job.name === JobName.FileDelete ? [job.data.files] : []));

      it('keeps the asset when its file cleanup cannot be queued, and a retry deletes it', async () => {
        const { sut, ctx } = setup(forkDatabase);
        const queue = ctx.getMock(JobRepository).queue;
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const thumbnailPath = `/path/to/${asset.id}-thumbnail.jpg`;
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath });
        queue.mockRejectedValueOnce(new Error('redis unavailable'));

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).rejects.toThrow(
          'redis unavailable',
        );
        await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ id: asset.id });

        queue.mockResolvedValue();
        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toBeUndefined();
        expect(fileDeletes(ctx).at(-1)).toEqual([thumbnailPath, asset.originalPath]);
      });

      it('has committed the removal before the deletion is announced', async () => {
        const { sut, ctx } = setup(forkDatabase);
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const seenWhenAnnounced: unknown[] = [];
        ctx.getMock(EventRepository).emit.mockImplementation(async (...args) => {
          if (args[0] === 'AssetDelete') {
            // read on another connection: only a committed removal is visible here
            seenWhenAnnounced.push(
              await forkDatabase.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst(),
            );
          }
        });

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(seenWhenAnnounced).toEqual([undefined]);
      });

      it('has queued the files when a step after the removal fails', async () => {
        const { sut, ctx } = setup(forkDatabase);
        const queue = ctx.getMock(JobRepository).queue;
        queue.mockResolvedValue();
        ctx.getMock(EventRepository).emit.mockRejectedValue(new Error('listener failed'));
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toBeUndefined();
        expect(fileDeletes(ctx)).toEqual([[asset.originalPath]]);
      });

      it('holds its files until the removal commits, so a FileDelete that starts early still deletes them', async () => {
        const { sut, ctx } = setup(forkDatabase);
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const unlink = vi.fn(async () => {});
        let deletion: Promise<{ deleted: boolean; references: number }> | undefined;
        ctx.getMock(JobRepository).queue.mockImplementation(async (job) => {
          if (job.name !== JobName.FileDelete) {
            return;
          }
          // the FileDelete worker picks the job up before the removal's transaction has committed
          const state = { settled: false };
          deletion = new PhysicalFileRepository(forkDatabase)
            .deleteUnreferencedPath(asset.originalPath, unlink, { removedAssetId: job.data.removedAssetId })
            .finally(() => {
              state.settled = true;
            });
          for (let attempt = 0; attempt < 100 && !state.settled; attempt++) {
            const { rows } = await sql<{ waiting: number }>`
              SELECT count(*)::int AS waiting FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            `.execute(forkDatabase);
            if (rows[0].waiting > 0) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        });

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        // without the path lock it would have counted the removed row as a reference and kept the file
        await expect(deletion).resolves.toEqual({ deleted: true, references: 0 });
        expect(unlink).toHaveBeenCalledOnce();
      });

      it('never releases an original another asset still uses', async () => {
        const { sut, ctx } = setup(forkDatabase);
        const queue = ctx.getMock(JobRepository).queue;
        queue.mockResolvedValue();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        await ctx.newAsset({ ownerId: user.id, originalPath: asset.originalPath });

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(fileDeletes(ctx)).toEqual([[asset.originalPath]]);
        const unlink = vi.fn(async () => {});
        await expect(
          new PhysicalFileRepository(forkDatabase).deleteUnreferencedPath(asset.originalPath, unlink),
        ).resolves.toMatchObject({ deleted: false });
        expect(unlink).not.toHaveBeenCalled();
      });

      const addDevelopRevision = async (assetId: string, ownerId: string) => {
        const masterPath = `/data/develop/${assetId}-master.tif`;
        await sql`
          INSERT INTO immich_fork.asset_develop_revision ("assetId", "ownerId", revision, recipe, "masterPath")
          VALUES (${assetId}::uuid, ${ownerId}::uuid, 1, '{}'::jsonb, ${masterPath})
        `.execute(forkDatabase);
        return masterPath;
      };

      const addRestoration = async (assetId: string, ownerId: string) => {
        const resultPath = `/data/restorations/${assetId}-result.jpg`;
        const previewAfterPath = `/data/restorations/${assetId}-after.jpg`;
        await sql`
          INSERT INTO public.asset_restoration
            ("assetId", "ownerId", revision, mode, workload, "destinationKind", "destinationName", "sourceType",
             "sourceChecksum", "sourceWidth", "sourceHeight", "previewRegion", "resultPath", "previewAfterPath")
          VALUES (${assetId}::uuid, ${ownerId}::uuid, 1, 'restore', 'restoration', 'local', 'This server', 'IMAGE',
             ${randomBytes(20)}, 100, 100, '{}'::jsonb, ${resultPath}, ${previewAfterPath})
        `.execute(forkDatabase);
        return [resultPath, previewAfterPath];
      };

      it('keeps every listed file when the removal rolls back after its cleanup was queued', async () => {
        const { sut, ctx } = setup(forkDatabase);
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const thumbnailPath = `/path/to/${asset.id}-thumbnail.jpg`;
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath });
        // no row is counted as referencing a develop output, so only the removed asset can keep it
        const developPath = await addDevelopRevision(asset.id, user.id);
        let queued: { files: Array<string | null | undefined>; removedAssetId?: string } | undefined;
        ctx.getMock(JobRepository).queue.mockImplementation((job) => {
          if (job.name !== JobName.FileDelete) {
            return Promise.resolve();
          }
          // the job reached the queue, then the removal's transaction failed and rolled back
          queued = job.data;
          return Promise.reject(new Error('commit failed'));
        });

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).rejects.toThrow('commit failed');

        await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ id: asset.id });
        expect(queued?.removedAssetId).toBe(asset.id);
        expect(queued?.files).toEqual(expect.arrayContaining([thumbnailPath, developPath, asset.originalPath]));
        const physical = new PhysicalFileRepository(forkDatabase);
        const unlink = vi.fn(async () => {});
        for (const file of queued!.files as string[]) {
          await expect(
            physical.deleteUnreferencedPath(file, unlink, { removedAssetId: queued!.removedAssetId }),
          ).resolves.toMatchObject({ deleted: false });
        }
        expect(unlink).not.toHaveBeenCalled();
      });

      it('releases the outputs of restorations and develop revisions, whose rows go with the asset', async () => {
        const { sut, ctx } = setup(forkDatabase);
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const restorationPaths = await addRestoration(asset.id, user.id);
        const developPath = await addDevelopRevision(asset.id, user.id);

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        const [files] = fileDeletes(ctx);
        expect(files).toEqual(expect.arrayContaining([...restorationPaths, developPath, asset.originalPath]));
        const revisions = await sql`
          SELECT 1 FROM immich_fork.asset_develop_revision WHERE "assetId" = ${asset.id}::uuid
        `.execute(forkDatabase);
        expect(revisions.rows).toEqual([]);
        const unlink = vi.fn(async () => {});
        for (const file of [...restorationPaths, developPath]) {
          await expect(
            new PhysicalFileRepository(forkDatabase).deleteUnreferencedPath(file, unlink, { removedAssetId: asset.id }),
          ).resolves.toEqual({ deleted: true, references: 0 });
        }
      });

      describe('stacks, handoffs and storage moves (FL-179)', () => {
        const recordMove = async (assetId: string, oldPath: string, newPath: string) => {
          const { id } = await forkDatabase
            .insertInto('move_history')
            .values({ entityId: assetId, pathType: AssetPathType.Original, oldPath, newPath })
            .returning('id')
            .executeTakeFirstOrThrow();
          return id;
        };

        const movesOf = (assetId: string) =>
          forkDatabase.selectFrom('move_history').select('id').where('entityId', '=', assetId).execute();

        /** Waits until `count` locks are waited for: advisory (path) locks, or any lock. */
        const waitForLockWaiters = async (kind: 'advisory' | 'any', count = 1) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const { rows } = await sql<{ waiting: number }>`
              SELECT count(*)::int AS waiting FROM pg_locks
              WHERE NOT granted AND (${kind} = 'any' OR locktype = 'advisory')
                AND (database IS NULL OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))
            `.execute(forkDatabase);
            if (rows[0].waiting >= count) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error(`nothing waited for a ${kind} lock`);
        };
        const waitForPathLockWaiter = () => waitForLockWaiters('advisory');

        const noop = () => Promise.resolve();
        const renamed = () => Promise.resolve(true);
        const originalMove = (asset: { id: string; originalPath: string }, moveId: string, to: string) => ({
          moveId,
          assetId: asset.id,
          pathType: AssetPathType.Original,
          from: asset.originalPath,
          source: asset.originalPath,
          to,
        });
        /** Holds a lock taken in its own transaction until the returned release is called. */
        const holdLock = async (lock: (tx: Kysely<DB>) => Promise<unknown>) => {
          let release!: () => void;
          const released = new Promise<void>((resolve) => (release = resolve));
          let held!: () => void;
          const holding = new Promise<void>((resolve) => (held = resolve));
          const done = forkDatabase.transaction().execute(async (tx) => {
            await lock(tx);
            held();
            await released;
          });
          await holding;
          return async () => {
            release();
            await done;
          };
        };

        it('leaves the stack as it was when the removal rolls back, and changes it when the retry commits', async () => {
          const { sut, ctx } = setup(forkDatabase);
          const queue = ctx.getMock(JobRepository).queue;
          const { user } = await ctx.newUser();
          const { asset: primary } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const { asset: other } = await ctx.newAsset({ ownerId: user.id });
          const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, other.id]);
          queue.mockImplementation((job) =>
            job.name === JobName.FileDelete ? Promise.reject(new Error('commit failed')) : Promise.resolve(),
          );

          await expect(sut.handleAssetDeletion({ id: primary.id, deleteOnDisk: true })).rejects.toThrow(
            'commit failed',
          );

          await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toMatchObject({
            primaryAssetId: primary.id,
          });
          await expect(ctx.get(AssetRepository).getById(other.id)).resolves.toMatchObject({ stackId: stack.id });

          queue.mockResolvedValue();
          await expect(sut.handleAssetDeletion({ id: primary.id, deleteOnDisk: true })).resolves.toBe(
            JobStatus.Success,
          );

          await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toBeUndefined();
          await expect(ctx.get(AssetRepository).getById(other.id)).resolves.toMatchObject({ stackId: null });
        });

        it('dissolves the stack when a member leaves only the primary', async () => {
          const { sut, ctx } = setup(forkDatabase);
          ctx.getMock(JobRepository).queue.mockResolvedValue();
          const { user } = await ctx.newUser();
          const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
          const { asset: member } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, member.id]);

          await expect(sut.handleAssetDeletion({ id: member.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

          await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toBeUndefined();
        });

        it('keeps the stack and its primary when a member leaves two others', async () => {
          const { sut, ctx } = setup(forkDatabase);
          ctx.getMock(JobRepository).queue.mockResolvedValue();
          const { user } = await ctx.newUser();
          const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
          const { asset: member } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const { asset: other } = await ctx.newAsset({ ownerId: user.id });
          const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, member.id, other.id]);

          await expect(sut.handleAssetDeletion({ id: member.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

          await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toMatchObject({
            primaryAssetId: primary.id,
          });
        });

        it('keeps develop revisions while a handoff runs, for the listener to clean up later', async () => {
          const { sut, ctx } = setup(forkDatabase);
          ctx.getMock(JobRepository).queue.mockResolvedValue();
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const developPath = await addDevelopRevision(asset.id, user.id);

          await sql`
            INSERT INTO immich_fork.migration_audit (name, phase, status)
            VALUES ('official-handoff-preparation', 'active', 'running')
          `.execute(forkDatabase);
          try {
            await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(
              JobStatus.Success,
            );
          } finally {
            await sql`
              DELETE FROM immich_fork.migration_audit
              WHERE name = 'official-handoff-preparation' AND status = 'running'
            `.execute(forkDatabase);
          }

          await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toBeUndefined();
          expect(fileDeletes(ctx).flat()).not.toContain(developPath);
          const revisions = await sql`
            SELECT 1 FROM immich_fork.asset_develop_revision WHERE "assetId" = ${asset.id}::uuid
          `.execute(forkDatabase);
          expect(revisions.rows).toHaveLength(1);
        });

        it('releases a file a storage move left at its new path, and forgets the move', async () => {
          const { sut, ctx } = setup(forkDatabase);
          ctx.getMock(JobRepository).queue.mockResolvedValue();
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const movedPath = `/data/library/${asset.id}-moved.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, movedPath);

          await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

          // and a copy an interrupted move across filesystems staged beside the new path
          expect(fileDeletes(ctx)).toEqual([[asset.originalPath, movedPath, `${movedPath}.${moveId}.moving`]]);
          await expect(movesOf(asset.id)).resolves.toEqual([]);
        });

        it('renames the file and saves its new path as one unit', async () => {
          const { ctx } = setup(forkDatabase);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          const to = `/data/library/${asset.id}-template.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const operations = { rename: vi.fn(() => Promise.resolve(true)), finish: vi.fn(noop), undo: vi.fn(noop) };

          await expect(
            ctx.get(AssetRepository).moveFile(
              {
                moveId,
                assetId: asset.id,
                pathType: AssetPathType.Original,
                from: asset.originalPath,
                source: asset.originalPath,
                to,
              },
              operations,
            ),
          ).resolves.toBe('moved');

          await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ originalPath: to });
          await expect(movesOf(asset.id)).resolves.toEqual([]);
          expect(operations.rename).toHaveBeenCalledOnce();
          expect(operations.finish).toHaveBeenCalledOnce();
          expect(operations.undo).not.toHaveBeenCalled();
        });

        it('moves nothing once the asset is removed, or when it names another file', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset: removed } = await ctx.newAsset({ ownerId: user.id });
          const { asset: changed } = await ctx.newAsset({ ownerId: user.id });
          const removedMove = await recordMove(removed.id, removed.originalPath, `/data/library/${removed.id}-t.jpg`);
          const changedMove = await recordMove(
            changed.id,
            '/data/library/earlier.jpg',
            `/data/library/${changed.id}-t.jpg`,
          );
          await repository.remove({ id: removed.id });
          const rename = vi.fn(() => Promise.resolve(true));

          await expect(
            repository.moveFile(
              {
                moveId: removedMove,
                assetId: removed.id,
                pathType: AssetPathType.Original,
                from: removed.originalPath,
                source: removed.originalPath,
                to: `/data/library/${removed.id}-t.jpg`,
              },
              { rename, finish: noop, undo: noop },
            ),
          ).resolves.toBe('removed');
          await expect(
            repository.moveFile(
              {
                moveId: changedMove,
                assetId: changed.id,
                pathType: AssetPathType.Original,
                from: '/data/library/earlier.jpg',
                source: '/data/library/earlier.jpg',
                to: `/data/library/${changed.id}-t.jpg`,
              },
              { rename, finish: noop, undo: noop },
            ),
          ).resolves.toBe('changed');

          expect(rename).not.toHaveBeenCalled();
          await expect(repository.getById(changed.id)).resolves.toMatchObject({ originalPath: changed.originalPath });
          await expect(movesOf(removed.id)).resolves.toEqual([]);
          await expect(movesOf(changed.id)).resolves.toEqual([]);
        });

        const addPhysicalOriginal = async (path: string, canonicalAssetId: string | null) => {
          const { id } = await forkDatabase
            .insertInto('physical_file')
            .values({
              canonicalAssetId,
              checksum: randomBytes(20),
              path,
              sizeInBytes: 100,
              type: PhysicalFileType.Original,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return id;
        };

        it('points every asset sharing the moved file at its new path', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          const { asset: sharer } = await ctx.newAsset({ ownerId: user.id, originalPath: asset.originalPath });
          const physicalId = await addPhysicalOriginal(asset.originalPath, asset.id);
          await forkDatabase
            .updateTable('asset')
            .set({ physicalOriginalFileId: physicalId })
            .where('id', 'in', [asset.id, sharer.id])
            .execute();
          const to = `/data/library/${asset.id}-shared.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);

          await expect(
            repository.moveFile(
              {
                moveId,
                assetId: asset.id,
                pathType: AssetPathType.Original,
                from: asset.originalPath,
                source: asset.originalPath,
                to,
              },
              { rename: () => Promise.resolve(true), finish: noop, undo: noop },
            ),
          ).resolves.toBe('moved');

          await expect(repository.getById(sharer.id)).resolves.toMatchObject({ originalPath: to });
          const physical = await forkDatabase
            .selectFrom('physical_file')
            .select('path')
            .where('id', '=', physicalId)
            .executeTakeFirstOrThrow();
          expect(physical.path).toBe(to);
        });

        it('puts the file back and keeps the recorded move when the new path cannot be saved', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          const to = `/data/library/${asset.id}-taken.jpg`;
          const physicalId = await addPhysicalOriginal(asset.originalPath, asset.id);
          await forkDatabase
            .updateTable('asset')
            .set({ physicalOriginalFileId: physicalId })
            .where('id', '=', asset.id)
            .execute();
          // another physical file already has the new path, so saving it fails
          await addPhysicalOriginal(to, null);
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const operations = { rename: vi.fn(() => Promise.resolve(true)), finish: vi.fn(noop), undo: vi.fn(noop) };

          await expect(
            repository.moveFile(
              {
                moveId,
                assetId: asset.id,
                pathType: AssetPathType.Original,
                from: asset.originalPath,
                source: asset.originalPath,
                to,
              },
              operations,
            ),
          ).rejects.toThrow();

          expect(operations.undo).toHaveBeenCalledOnce();
          expect(operations.finish).not.toHaveBeenCalled();
          await expect(repository.getById(asset.id)).resolves.toMatchObject({ originalPath: asset.originalPath });
          await expect(movesOf(asset.id)).resolves.toEqual([{ id: moveId }]);
        });

        it('makes a removal that starts during a move wait for it, and see the file at its new path', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          const to = `/data/library/${asset.id}-racing.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          let renameStarted!: () => void;
          const started = new Promise<void>((resolve) => (renameStarted = resolve));
          let allowRename!: () => void;
          const allowed = new Promise<void>((resolve) => (allowRename = resolve));

          const moving = repository.moveFile(
            {
              moveId,
              assetId: asset.id,
              pathType: AssetPathType.Original,
              from: asset.originalPath,
              source: asset.originalPath,
              to,
            },
            {
              rename: async () => {
                renameStarted();
                await allowed;
                return true;
              },
              finish: noop,
              undo: noop,
            },
          );
          await started;

          const queued: string[][] = [];
          const removing = repository.remove(
            { id: asset.id },
            {
              files: (removed) => [
                removed.originalPath,
                ...removed.pendingMoves.flatMap((move) => [move.oldPath, move.newPath]),
              ],
              queue: (files) => {
                queued.push(files);
                return Promise.resolve();
              },
            },
          );
          // the removal waits on the move's path locks
          await waitForPathLockWaiter();
          allowRename();

          await expect(moving).resolves.toBe('moved');
          await expect(removing).resolves.toMatchObject({ originalPath: to, pendingMoves: [] });
          expect(queued).toEqual([[to]]);
          await expect(repository.getById(asset.id)).resolves.toBeUndefined();
        });

        it('starts a removal over, rather than deadlock, when a move is recorded under it', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          // sorts before the original, so the move locks it first and then waits for the original
          const to = `/0-moved/${asset.id}.jpg`;
          const releaseRow = await holdLock((tx) =>
            tx.selectFrom('asset').select('id').where('id', '=', asset.id).forUpdate().execute(),
          );

          const queued: string[][] = [];
          // locks the original's path, then waits for the asset row
          const removing = repository.remove(
            { id: asset.id },
            {
              files: (removed) => [
                removed.originalPath,
                ...removed.pendingMoves.flatMap((move) => [move.oldPath, move.newPath]),
              ],
              queue: (files) => {
                queued.push(files);
                return Promise.resolve();
              },
            },
          );
          await waitForLockWaiters('any');
          // a move recorded now takes the new path's lock, then waits for the original's
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const moving = repository.moveFile(originalMove(asset, moveId, to), {
            rename: renamed,
            finish: noop,
            undo: noop,
          });
          // the move waits on the original's path lock the removal holds
          await waitForPathLockWaiter();
          await releaseRow();

          // locking the new path late would have closed a cycle with the move
          await expect(moving).resolves.toBe('moved');
          await expect(removing).resolves.toMatchObject({ originalPath: to, pendingMoves: [] });
          expect(queued).toEqual([[to]]);
        });

        it('makes a user’s bulk deletion lock the stacks before the assets, as a removal does', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
          const { asset: member } = await ctx.newAsset({ ownerId: user.id });
          const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, member.id]);
          const releaseStack = await holdLock((tx) =>
            tx.selectFrom('stack').select('id').where('id', '=', stack.id).forUpdate().execute(),
          );

          const deleting = repository.deleteAll(user.id);
          await waitForLockWaiters('any');
          // waiting on the stack, it holds no asset row yet, so a removal holding the stack can finish
          await expect(
            forkDatabase
              .transaction()
              .execute((tx) =>
                sql`SELECT id FROM public.asset WHERE id = ${primary.id}::uuid FOR UPDATE NOWAIT`.execute(tx),
              ),
          ).resolves.toBeDefined();
          await releaseStack();

          await expect(deleting).resolves.toHaveLength(2);
          await expect(repository.getById(primary.id)).resolves.toBeUndefined();
        });

        it('points the Frameleaf mapping at the new path, so a later removal releases the file there', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
          await sql`
            INSERT INTO immich_fork.asset_physical_file ("assetId", "upstreamPath")
            VALUES (${asset.id}::uuid, ${asset.originalPath})
          `.execute(forkDatabase);
          const to = `/data/library/${asset.id}-mapped.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);

          await expect(
            repository.moveFile(originalMove(asset, moveId, to), { rename: renamed, finish: noop, undo: noop }),
          ).resolves.toBe('moved');

          const mapping = await sql<{ upstreamPath: string }>`
            SELECT "upstreamPath" FROM immich_fork.asset_physical_file WHERE "assetId" = ${asset.id}::uuid
          `.execute(forkDatabase);
          expect(mapping.rows).toEqual([{ upstreamPath: to }]);
          const queued: string[][] = [];
          await expect(
            repository.remove(
              { id: asset.id },
              {
                files: (removed) => [removed.originalPath],
                queue: (files) => {
                  queued.push(files);
                  return Promise.resolve();
                },
              },
            ),
          ).resolves.toMatchObject({ originalPath: to });
          expect(queued).toEqual([[to]]);
        });

        it('moves nothing a mapping names while a handoff runs, and keeps the move recorded', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          await sql`
            INSERT INTO immich_fork.asset_physical_file ("assetId", "upstreamPath")
            VALUES (${asset.id}::uuid, ${asset.originalPath})
          `.execute(forkDatabase);
          const to = `/data/library/${asset.id}-handoff.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const rename = vi.fn(renamed);

          await sql`
            INSERT INTO immich_fork.migration_audit (name, phase, status)
            VALUES ('official-handoff-preparation', 'active', 'running')
          `.execute(forkDatabase);
          try {
            await expect(
              repository.moveFile(originalMove(asset, moveId, to), { rename, finish: noop, undo: noop }),
            ).resolves.toBe('deferred');
          } finally {
            await sql`
              DELETE FROM immich_fork.migration_audit
              WHERE name = 'official-handoff-preparation' AND status = 'running'
            `.execute(forkDatabase);
          }

          expect(rename).not.toHaveBeenCalled();
          await expect(repository.getById(asset.id)).resolves.toMatchObject({ originalPath: asset.originalPath });
          await expect(movesOf(asset.id)).resolves.toEqual([{ id: moveId }]);
        });

        it('defers a move while a normalization has the asset reserved, and keeps it recorded', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          await sql`
            INSERT INTO immich_fork.asset_storage_reservation
              ("assetId", token, "sourcePath", "upstreamPath", "temporaryPath", status)
            VALUES (${asset.id}::uuid, ${randomUUID()}::uuid, ${asset.originalPath},
              ${`/data/upstream/${asset.id}.jpg`}, ${`/data/upstream/${asset.id}.tmp`}, 'reserved')
          `.execute(forkDatabase);
          const to = `/data/library/${asset.id}-reserved.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const rename = vi.fn(renamed);

          await expect(
            repository.moveFile(originalMove(asset, moveId, to), { rename, finish: noop, undo: noop }),
          ).resolves.toBe('deferred');

          expect(rename).not.toHaveBeenCalled();
          await expect(repository.getById(asset.id)).resolves.toMatchObject({ originalPath: asset.originalPath });
          await expect(movesOf(asset.id)).resolves.toEqual([{ id: moveId }]);
        });

        it('keeps the move recorded, moving nothing, while the mapping names another file', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          await sql`
            INSERT INTO immich_fork.asset_physical_file ("assetId", "upstreamPath")
            VALUES (${asset.id}::uuid, ${`/data/upstream/${asset.id}.jpg`})
          `.execute(forkDatabase);
          const to = `/data/library/${asset.id}-mismatched.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);
          const rename = vi.fn(renamed);

          await expect(
            repository.moveFile(originalMove(asset, moveId, to), { rename, finish: noop, undo: noop }),
          ).resolves.toBe('mismatched');

          expect(rename).not.toHaveBeenCalled();
          await expect(movesOf(asset.id)).resolves.toEqual([{ id: moveId }]);
        });

        it('moves every asset naming the file, with or without a physical file linking them', async () => {
          const { ctx } = setup(forkDatabase);
          const repository = ctx.get(AssetRepository);
          const { user } = await ctx.newUser();
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          const { asset: other } = await ctx.newAsset({ ownerId: user.id, originalPath: asset.originalPath });
          const to = `/data/library/${asset.id}-unlinked.jpg`;
          const moveId = await recordMove(asset.id, asset.originalPath, to);

          await expect(
            repository.moveFile(originalMove(asset, moveId, to), { rename: renamed, finish: noop, undo: noop }),
          ).resolves.toBe('moved');

          await expect(repository.getById(other.id)).resolves.toMatchObject({ originalPath: to });
        });
      });

      it('deletes develop revisions with the asset in the legacy phase', async () => {
        const legacyDatabase = await getKyselyDB();
        await sql`UPDATE immich_fork.state SET phase = 'legacy', active = false WHERE id = 1`.execute(legacyDatabase);
        const { sut, ctx } = setup(legacyDatabase);
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
        const masterPath = `/data/develop/${asset.id}-legacy.tif`;
        await sql`
          INSERT INTO immich_fork.asset_develop_revision ("assetId", "ownerId", revision, recipe, "masterPath")
          VALUES (${asset.id}::uuid, ${user.id}::uuid, 1, '{}'::jsonb, ${masterPath})
        `.execute(legacyDatabase);

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(fileDeletes(ctx).flat()).toContain(masterPath);
        const revisions = await sql`
          SELECT 1 FROM immich_fork.asset_develop_revision WHERE "assetId" = ${asset.id}::uuid
        `.execute(legacyDatabase);
        expect(revisions.rows).toEqual([]);
      });
    });
  });

  describe('update', () => {
    it('should not update an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.update(factory.auth({ user: otherUser }), asset.id, {})).rejects.toThrow(
        'Not found or no asset.update access',
      );
    });

    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.update(auth, asset.id, {
        latitude: 42,
        longitude: 42,
        rating: 3,
        description: 'foo',
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone UTC+0', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  describe('updateAll', () => {
    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.updateAll(auth, {
        ids: [asset.id],
        latitude: 42,
        description: 'foo',
        longitude: 42,
        rating: 3,
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should release typed place names when the items move (FL-36, V-24)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, city: 'Paris', country: 'France' });
      await ctx.database
        .updateTable('asset_exif')
        .set({ lockedProperties: ['city', 'country', 'description'] })
        .where('assetId', '=', asset.id)
        .execute();

      await sut.updateAll(auth, { ids: [asset.id], latitude: 35.68, longitude: 139.69 });

      const { lockedProperties } = await ctx.database
        .selectFrom('asset_exif')
        .select('lockedProperties')
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect([...(lockedProperties ?? [])].sort()).toEqual(['description', 'latitude', 'longitude']);
    });

    it('should relatively update assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
          }),
        }),
      );
    });

    it('should relatively update assets with timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC+5' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -1441 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-18T18:10:00+00:00',
            timeZone: 'UTC+5',
            lockedProperties: ['timeZone', 'dateTimeOriginal'],
          }),
        }),
      );
    });

    it('should relatively update assets and set a timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11, timeZone: 'UTC+5' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
            timeZone: 'UTC+5',
          }),
        }),
      );
    });

    it('should set asset time zones to UTC', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], timeZone: 'UTC' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:11:00+00:00',
            timeZone: 'UTC',
          }),
        }),
      );
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with UTC time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('upsertBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(1);
      expect(metadata[0]).toEqual(
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }),
      );
    });

    it('should work on conflict', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } });

      // verify existing metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } }),
      ]);

      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }];
      await sut.upsertBulkMetadata(auth, { items });

      // verify updated metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }),
      ]);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata1 = await ctx.get(AssetRepository).getMetadata(asset1.id);
      expect(metadata1).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } }),
      ]);

      const metadata2 = await ctx.get(AssetRepository).getMetadata(asset2.id);
      expect(metadata2).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } }),
      ]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: AssetMetadataKey.MobileApp,
            value: { iCloudId: 'id1' },
          }),
          expect.objectContaining({
            key: 'some-other-key',
            value: { foo: 'bar' },
          }),
        ]),
      );
    });
  });

  describe('deleteBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work even if the item does not exist', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset1.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset2.id, key: AssetMetadataKey.MobileApp },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset1.id)).resolves.toEqual([]);
      await expect(ctx.get(AssetRepository).getMetadata(asset2.id)).resolves.toEqual([]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset.id, key: 'some-other-key' },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([]);
    });

    it('should not delete unspecified keys', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }],
      });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual([expect.objectContaining({ key: 'some-other-key', value: { foo: 'bar' } })]);
    });
  });

  describe('editAsset', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(
        sut.editAsset(auth, asset.id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] }),
      ).rejects.toThrow('Not found or no asset.edit.create access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });

      const editAction = { action: AssetEditAction.Rotate, parameters: { angle: 90 } } as const;
      const editResponse = { ...editAction, id: expect.any(String) };
      await expect(sut.editAsset(auth, asset.id, { edits: [editAction] })).resolves.toEqual({
        assetId: asset.id,
        edits: [editResponse],
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ isEdited: true }),
      );
      await expect(ctx.get(AssetEditRepository).getAll(asset.id)).resolves.toEqual([editResponse]);
    });
  });

  describe('moving an album cover into the Locked folder (FL-53)', () => {
    const older = new Date('2024-01-01T00:00:00.000Z');
    const newer = new Date('2024-06-01T00:00:00.000Z');

    const coverSetup = async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const auth = factory.auth({ user, session: { id: factory.uuid(), hasElevatedPermission: true } });
      const { asset: cover } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer });
      const { asset: fallback } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: older });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: cover.id }, [
        cover.id,
        fallback.id,
      ]);
      // another person's album the owner added the photo to, where it is the only member
      const { album: sharedAlbum } = await ctx.newAlbum({ ownerId: member.id, albumThumbnailAssetId: cover.id }, [
        cover.id,
      ]);
      const coverOf = (albumId: string) =>
        ctx.database
          .selectFrom('album')
          .select('albumThumbnailAssetId')
          .where('id', '=', albumId)
          .executeTakeFirstOrThrow()
          .then(({ albumThumbnailAssetId }) => albumThumbnailAssetId);
      return { sut, ctx, auth, cover, fallback, album, sharedAlbum, coverOf };
    };

    it('releases the cover when one asset is moved', async () => {
      const { sut, auth, cover, fallback, album, sharedAlbum, coverOf } = await coverSetup();

      await sut.update(auth, cover.id, { visibility: AssetVisibility.Locked });

      await expect(coverOf(album.id)).resolves.toBe(fallback.id);
      await expect(coverOf(sharedAlbum.id)).resolves.toBeNull();
    });

    it('releases the cover when assets are moved in bulk', async () => {
      const { sut, auth, cover, fallback, album, sharedAlbum, coverOf } = await coverSetup();

      await sut.updateAll(auth, { ids: [cover.id], visibility: AssetVisibility.Locked });

      await expect(coverOf(album.id)).resolves.toBe(fallback.id);
      await expect(coverOf(sharedAlbum.id)).resolves.toBeNull();
    });

    it('keeps the cover when an asset is only archived', async () => {
      const { sut, auth, cover, album, coverOf } = await coverSetup();

      await sut.updateAll(auth, { ids: [cover.id], visibility: AssetVisibility.Archive });

      await expect(coverOf(album.id)).resolves.toBe(cover.id);
    });

    it("moves a person's featured face off the photo and queues a new thumbnail from the next face", async () => {
      const { sut, ctx, auth, cover, fallback } = await coverSetup();
      const { person } = await ctx.newPerson({ ownerId: auth.user.id, thumbnailPath: '/thumbs/person.jpeg' });
      const { assetFace: lockedFace } = await ctx.newAssetFace({
        assetId: cover.id,
        personGroupId: person.personGroupId,
      });
      const { assetFace: nextFace } = await ctx.newAssetFace({
        assetId: fallback.id,
        personGroupId: person.personGroupId,
      });
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: lockedFace.id })
        .where('ownerId', '=', auth.user.id)
        .where('personGroupId', '=', person.personGroupId)
        .execute();

      await sut.updateAll(auth, { ids: [cover.id], visibility: AssetVisibility.Locked });

      await expect(
        ctx.database
          .selectFrom('person')
          .select(['faceAssetId', 'thumbnailPath'])
          .where('ownerId', '=', auth.user.id)
          .where('personGroupId', '=', person.personGroupId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ faceAssetId: nextFace.id, thumbnailPath: '' });
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: auth.user.id, personGroupId: person.personGroupId },
        },
      ]);
    });
  });

  describe('notifying stack siblings when Locked state changes (FL-53)', () => {
    it('pushes a real-time update for a stack sibling when the other member is locked', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { id: factory.uuid(), hasElevatedPermission: true } });
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
      const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [primary.id, sibling.id]);

      await sut.update(auth, primary.id, { visibility: AssetVisibility.Locked });

      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledWith(
        'on_asset_update',
        user.id,
        expect.objectContaining({ id: primary.id, visibility: AssetVisibility.Locked }),
      );
      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledWith(
        'on_asset_update',
        user.id,
        expect.objectContaining({ id: sibling.id, visibility: AssetVisibility.Locked }),
      );
    });

    it('pushes a real-time update for every sibling in a bulk move', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { id: factory.uuid(), hasElevatedPermission: true } });
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
      const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [primary.id, sibling.id]);

      await sut.updateAll(auth, { ids: [primary.id], visibility: AssetVisibility.Locked });

      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledWith(
        'on_asset_update',
        user.id,
        expect.objectContaining({ id: sibling.id, visibility: AssetVisibility.Locked }),
      );
    });

    it('pushes only its own update for an asset that is not in a stack', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { id: factory.uuid(), hasElevatedPermission: true } });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.update(auth, asset.id, { visibility: AssetVisibility.Locked });

      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledTimes(1);
      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledWith(
        'on_asset_update',
        user.id,
        expect.objectContaining({ id: asset.id }),
      );
    });
  });
});
