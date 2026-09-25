import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import type { OnThisDayData } from 'src/types.js';
import {
  JobName,
  JobStatus,
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryShowLessKind,
  MemoryType,
} from 'src/enum.js';
import { MemoryService } from 'src/services/memory.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { MemoryFactory } from 'test/factories/memory.factory.js';
import { getForMemory } from 'test/mappers.js';
import { factory, newUuid, newUuids } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(MemoryService.name, () => {
  let sut: MemoryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MemoryService));
    // FL-62: the owner's curation and show-less rules are read on every search and generation pass
    mocks.memory.getCurations.mockResolvedValue(new Map());
    mocks.memory.getHiddenMemoryIds.mockResolvedValue([]);
    mocks.memory.getShowLess.mockResolvedValue([]);
    mocks.memory.getBirthdaySubjects.mockResolvedValue([]);
    mocks.memory.getRecapSubjects.mockResolvedValue([]);
    mocks.memory.cleanupCurations.mockResolvedValue();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('onMemoryCleanup', () => {
    it('should clean up memories', async () => {
      mocks.memory.cleanup.mockResolvedValue([]);
      // The same cleanup also reclaims finished and stale highlight exports (FL-62).
      mocks.memory.getReclaimableExports.mockResolvedValue([]);
      await sut.onMemoriesCleanup();
      expect(mocks.memory.cleanup).toHaveBeenCalled();
      expect(mocks.memory.getReclaimableExports).toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('should search memories with assets', async () => {
      const [userId] = newUuids();

      const asset = AssetFactory.create();
      const memory1 = MemoryFactory.from({ ownerId: userId }).asset(asset).build();
      const memory2 = MemoryFactory.create({ ownerId: userId });
      mocks.memory.search.mockResolvedValue([getForMemory(memory1), getForMemory(memory2)]);
      mocks.memory.statistics.mockResolvedValue({ total: 2 });

      await expect(sut.search(factory.auth({ user: { id: userId } }), {})).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: memory1.id,
            assets: expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
          }),
        ]),
      );
      mocks.memory.search.mockResolvedValue([]);
      await expect(sut.search(factory.auth(), {})).resolves.toEqual([]);
    });

    it('should map empty result', async () => {
      mocks.memory.search.mockResolvedValue([]);
      await expect(sut.search(factory.auth(), {})).resolves.toEqual([]);
    });
  });

  describe('get', () => {
    it('should throw an error when no access', async () => {
      await expect(sut.get(factory.auth(), 'not-found')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw an error when the memory is not found', async () => {
      const [memoryId] = newUuids();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memoryId]));
      mocks.memory.get.mockResolvedValue(void 0);

      await expect(sut.get(factory.auth(), memoryId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should get a memory by id', async () => {
      const userId = newUuid();
      const memory = MemoryFactory.create({ ownerId: userId });

      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));

      await expect(sut.get(factory.auth({ user: { id: userId } }), memory.id)).resolves.toMatchObject({
        id: memory.id,
      });

      expect(mocks.memory.get).toHaveBeenCalledWith(memory.id);
      expect(mocks.access.memory.checkOwnerAccess).toHaveBeenCalledWith(memory.ownerId, new Set([memory.id]));
    });

    it('should hide private NSFW memory assets when requested', async () => {
      const userId = newUuid();
      const memory = MemoryFactory.create({ ownerId: userId });

      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));

      await expect(
        sut.get({ ...factory.auth({ user: { id: userId } }), hideNsfwAssets: true }, memory.id),
      ).resolves.toMatchObject({
        id: memory.id,
      });

      expect(mocks.memory.get).toHaveBeenCalledWith(memory.id, {
        excludeNsfw: true,
        excludePersonIds: [],
        excludePetIds: [],
      });
      expect(mocks.access.memory.checkOwnerAccess).toHaveBeenCalledWith(memory.ownerId, new Set([memory.id]), true);
    });
  });

  describe('create', () => {
    it('should skip assets the user does not have access to', async () => {
      const [assetId, userId] = newUuids();
      const memory = MemoryFactory.create({ ownerId: userId });

      mocks.memory.create.mockResolvedValue(getForMemory(memory));

      await expect(
        sut.create(factory.auth({ user: { id: userId } }), {
          type: memory.type,
          data: memory.data as OnThisDayData,
          memoryAt: memory.memoryAt,
          isSaved: memory.isSaved,
          assetIds: [assetId],
        }),
      ).resolves.toMatchObject({ assets: [] });

      expect(mocks.memory.create).toHaveBeenCalledWith(
        {
          type: memory.type,
          data: memory.data,
          ownerId: memory.ownerId,
          memoryAt: memory.memoryAt,
          isSaved: memory.isSaved,
        },
        new Set(),
      );
    });

    it('should create a memory', async () => {
      const [assetId, userId] = newUuids();
      const asset = AssetFactory.create({ id: assetId, ownerId: userId });
      const memory = MemoryFactory.from().asset(asset).build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.memory.create.mockResolvedValue(getForMemory(memory));

      await expect(
        sut.create(factory.auth({ user: { id: userId } }), {
          type: memory.type,
          data: memory.data as OnThisDayData,
          assetIds: memory.assets.map((asset) => asset.id),
          memoryAt: memory.memoryAt,
        }),
      ).resolves.toBeDefined();

      expect(mocks.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: userId }),
        new Set([assetId]),
      );
    });

    it('should create a memory without assets', async () => {
      const memory = MemoryFactory.create();

      mocks.memory.create.mockResolvedValue(getForMemory(memory));

      await expect(
        sut.create(factory.auth(), {
          type: memory.type,
          data: memory.data as OnThisDayData,
          memoryAt: memory.memoryAt,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('should require access', async () => {
      await expect(sut.update(factory.auth(), 'not-found', { isSaved: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.memory.update).not.toHaveBeenCalled();
    });

    it('should update a memory', async () => {
      const memory = MemoryFactory.create();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.update.mockResolvedValue(getForMemory(memory));

      await expect(sut.update(factory.auth(), memory.id, { isSaved: true })).resolves.toBeDefined();

      expect(mocks.memory.update).toHaveBeenCalledWith(memory.id, expect.objectContaining({ isSaved: true }));
    });

    it('should hide private NSFW assets from updated memory responses when requested', async () => {
      const memory = MemoryFactory.create();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.update.mockResolvedValue(getForMemory(memory));

      await expect(
        sut.update({ ...factory.auth(), hideNsfwAssets: true }, memory.id, { isSaved: true }),
      ).resolves.toBeDefined();

      expect(mocks.memory.update).toHaveBeenCalledWith(memory.id, expect.objectContaining({ isSaved: true }), {
        excludeNsfw: true,
        excludePersonIds: [],
        excludePetIds: [],
      });
    });
  });

  describe('remove', () => {
    it('should require access', async () => {
      await expect(sut.remove(factory.auth(), newUuid())).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.memory.delete).not.toHaveBeenCalled();
    });

    it('should delete a memory', async () => {
      const memoryId = newUuid();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memoryId]));
      mocks.memory.delete.mockResolvedValue();

      await expect(sut.remove(factory.auth(), memoryId)).resolves.toBeUndefined();

      expect(mocks.memory.delete).toHaveBeenCalledWith(memoryId);
    });
  });

  describe('addAssets', () => {
    it('should require memory access', async () => {
      const [memoryId, assetId] = newUuids();

      await expect(sut.addAssets(factory.auth(), memoryId, { ids: [assetId] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.memory.addAssetIds).not.toHaveBeenCalled();
    });

    it('should require asset access', async () => {
      const assetId = newUuid();
      const memory = MemoryFactory.create();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.memory.getAssetIds.mockResolvedValue(new Set());

      await expect(sut.addAssets(factory.auth(), memory.id, { ids: [assetId] })).resolves.toEqual([
        { error: 'no_permission', id: assetId, success: false },
      ]);

      expect(mocks.memory.addAssetIds).not.toHaveBeenCalled();
    });

    it('should skip assets already in the memory', async () => {
      const asset = AssetFactory.create();
      const memory = MemoryFactory.from().asset(asset).build();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.memory.getAssetIds.mockResolvedValue(new Set([asset.id]));

      await expect(sut.addAssets(factory.auth(), memory.id, { ids: [asset.id] })).resolves.toEqual([
        { error: 'duplicate', id: asset.id, success: false },
      ]);

      expect(mocks.memory.addAssetIds).not.toHaveBeenCalled();
    });

    it('should add assets', async () => {
      const assetId = newUuid();
      const memory = MemoryFactory.create();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.memory.update.mockResolvedValue(getForMemory(memory));
      mocks.memory.getAssetIds.mockResolvedValue(new Set());
      mocks.memory.addAssetIds.mockResolvedValue();

      await expect(sut.addAssets(factory.auth(), memory.id, { ids: [assetId] })).resolves.toEqual([
        { id: assetId, success: true },
      ]);

      expect(mocks.memory.addAssetIds).toHaveBeenCalledWith(memory.id, [assetId]);
    });
  });

  describe('removeAssets', () => {
    it('should require memory access', async () => {
      await expect(sut.removeAssets(factory.auth(), 'not-found', { ids: ['asset1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.memory.removeAssetIds).not.toHaveBeenCalled();
    });

    it('should skip assets not in the memory', async () => {
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set(['memory1']));
      mocks.memory.getAssetIds.mockResolvedValue(new Set());

      await expect(sut.removeAssets(factory.auth(), 'memory1', { ids: ['not-found'] })).resolves.toEqual([
        { error: 'not_found', id: 'not-found', success: false },
      ]);

      expect(mocks.memory.removeAssetIds).not.toHaveBeenCalled();
    });

    it('should remove assets', async () => {
      const memory = MemoryFactory.create();
      const asset = AssetFactory.create();

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.memory.getAssetIds.mockResolvedValue(new Set([asset.id]));
      mocks.memory.removeAssetIds.mockResolvedValue();
      mocks.memory.update.mockResolvedValue(getForMemory(memory));

      await expect(sut.removeAssets(factory.auth(), memory.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);

      expect(mocks.memory.removeAssetIds).toHaveBeenCalledWith(memory.id, [asset.id]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Private highlight export (FL-62)
  // ---------------------------------------------------------------------------------------

  const exportRun = (overrides: Record<string, unknown> = {}) => ({
    id: newUuid(),
    ownerId: newUuid(),
    memoryId: newUuid(),
    title: '2026',
    format: MemoryExportFormat.Archive,
    status: MemoryExportStatus.Pending,
    assetIds: [] as string[],
    assetCount: 0,
    processedAssets: 0,
    path: null,
    sizeInBytes: null,
    error: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  describe('createExport', () => {
    it('should refuse a memory with no assets', async () => {
      const userId = newUuid();
      const memory = MemoryFactory.create({ ownerId: userId });

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));

      await expect(sut.createExport(factory.auth({ user: { id: userId } }), memory.id, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should recheck the download permission and queue a durable job', async () => {
      const userId = newUuid();
      const asset = AssetFactory.create({ ownerId: userId });
      const memory = MemoryFactory.from({ ownerId: userId }).asset(asset).build();
      const run = exportRun({ ownerId: userId, memoryId: memory.id, assetIds: [asset.id], assetCount: 1 });

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.memory.searchExports.mockResolvedValue([]);
      mocks.memory.createExport.mockResolvedValue(run as never);

      await expect(sut.createExport(factory.auth({ user: { id: userId } }), memory.id, {})).resolves.toMatchObject({
        id: run.id,
        status: MemoryExportStatus.Pending,
        isDownloadable: false,
      });

      // the asset access check is what stops a memory read standing in for a download right
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.MemoryExport, data: { id: run.id } });
    });

    it('should return the export already in flight instead of starting a second one', async () => {
      const userId = newUuid();
      const asset = AssetFactory.create({ ownerId: userId });
      const memory = MemoryFactory.from({ ownerId: userId }).asset(asset).build();
      const running = exportRun({ ownerId: userId, memoryId: memory.id, status: MemoryExportStatus.Running });

      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.memory.searchExports.mockResolvedValue([running] as never);

      await expect(sut.createExport(factory.auth({ user: { id: userId } }), memory.id, {})).resolves.toMatchObject({
        id: running.id,
      });

      expect(mocks.memory.createExport).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('getExport', () => {
    it('should read an export scoped to the caller', async () => {
      const userId = newUuid();
      const run = exportRun({ ownerId: userId });

      mocks.memory.getExport.mockResolvedValue(run as never);

      await expect(sut.getExport(factory.auth({ user: { id: userId } }), run.id)).resolves.toMatchObject({
        id: run.id,
      });
      // owner scoping is the query, not a post-filter: another user simply gets nothing back
      expect(mocks.memory.getExport).toHaveBeenCalledWith(run.id, userId);
    });

    it("should not find another user's export", async () => {
      mocks.memory.getExport.mockResolvedValue(void 0);

      await expect(sut.getExport(factory.auth(), newUuid())).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cancelExport', () => {
    it('should finish a queued export immediately', async () => {
      const userId = newUuid();
      const run = exportRun({ ownerId: userId, status: MemoryExportStatus.Pending });

      mocks.memory.getExport.mockResolvedValue(run as never);
      mocks.memory.requestExportCancel.mockResolvedValue({ ...run, cancelRequestedAt: new Date() } as never);
      mocks.memory.updateExport.mockResolvedValue({
        ...run,
        status: MemoryExportStatus.Cancelled,
        finishedAt: new Date(),
      } as never);

      await expect(sut.cancelExport(factory.auth({ user: { id: userId } }), run.id)).resolves.toMatchObject({
        status: MemoryExportStatus.Cancelled,
      });
    });

    it('should mark a running export as cancelling and leave the worker to finish it', async () => {
      const userId = newUuid();
      const run = exportRun({ ownerId: userId, status: MemoryExportStatus.Running });

      mocks.memory.getExport.mockResolvedValue(run as never);
      mocks.memory.requestExportCancel.mockResolvedValue({ ...run, cancelRequestedAt: new Date() } as never);
      mocks.memory.updateExport.mockResolvedValue({ ...run, status: MemoryExportStatus.Cancelling } as never);

      await expect(sut.cancelExport(factory.auth({ user: { id: userId } }), run.id)).resolves.toMatchObject({
        status: MemoryExportStatus.Cancelling,
      });
      expect(mocks.memory.updateExport).toHaveBeenCalledWith(run.id, { status: MemoryExportStatus.Cancelling });
    });

    it('should leave a finished export alone', async () => {
      const userId = newUuid();
      const run = exportRun({ ownerId: userId, status: MemoryExportStatus.Ready, path: '/data/exports/a.zip' });

      mocks.memory.getExport.mockResolvedValue(run as never);

      await expect(sut.cancelExport(factory.auth({ user: { id: userId } }), run.id)).resolves.toMatchObject({
        status: MemoryExportStatus.Ready,
      });
      expect(mocks.memory.requestExportCancel).not.toHaveBeenCalled();
    });
  });

  describe('downloadExport', () => {
    it('should refuse an export that is not ready', async () => {
      const userId = newUuid();
      mocks.memory.getExport.mockResolvedValue(
        exportRun({ ownerId: userId, status: MemoryExportStatus.Running }) as never,
      );

      await expect(sut.downloadExport(factory.auth({ user: { id: userId } }), newUuid())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should refuse an expired export rather than serving it late', async () => {
      const userId = newUuid();
      mocks.memory.getExport.mockResolvedValue(
        exportRun({
          ownerId: userId,
          status: MemoryExportStatus.Ready,
          path: '/data/exports/a.zip',
          expiresAt: new Date(Date.now() - 1000),
        }) as never,
      );

      await expect(sut.downloadExport(factory.auth({ user: { id: userId } }), newUuid())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.storage.createReadStream).not.toHaveBeenCalled();
    });

    it('should stream a ready export', async () => {
      const userId = newUuid();
      mocks.memory.getExport.mockResolvedValue(
        exportRun({
          ownerId: userId,
          status: MemoryExportStatus.Ready,
          path: '/data/exports/a.zip',
          expiresAt: new Date(Date.now() + 60_000),
          title: 'Lisbon, Portugal',
        }) as never,
      );
      mocks.storage.createReadStream.mockResolvedValue({ stream: new PassThrough(), length: 10 });

      await expect(sut.downloadExport(factory.auth({ user: { id: userId } }), newUuid())).resolves.toMatchObject({
        disposition: expect.stringContaining('Lisbon'),
      });
      expect(mocks.storage.createReadStream).toHaveBeenCalledWith('/data/exports/a.zip', 'application/zip');
    });
  });

  describe('handleMemoryExport', () => {
    beforeEach(() => {
      // The run row is the worker's only record of progress; every path writes to it.
      mocks.memory.updateExport.mockResolvedValue(void 0);
    });

    const givenZip = () => {
      const stream = new PassThrough();
      const addFile = vitest.fn();
      mocks.storage.createZipStream.mockReturnValue({
        stream,
        addFile,
        finalize: vitest.fn().mockImplementation(() => Promise.resolve(stream.end())),
      } as never);
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
      return { addFile };
    };

    it('should skip a run it cannot claim', async () => {
      mocks.memory.claimExport.mockResolvedValue(void 0);

      await expect(sut.handleMemoryExport({ id: newUuid() })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storage.createZipStream).not.toHaveBeenCalled();
    });

    it('should cancel without writing when the owner asked before the worker started', async () => {
      const run = exportRun({ status: MemoryExportStatus.Running, cancelRequestedAt: new Date() });
      mocks.memory.claimExport.mockResolvedValue(run as never);

      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storage.createZipStream).not.toHaveBeenCalled();
      expect(mocks.memory.updateExport).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: MemoryExportStatus.Cancelled }),
      );
    });

    it("should never write another user's asset into the archive", async () => {
      const ownerId = newUuid();
      const mine = AssetFactory.create({ ownerId });
      const theirs = AssetFactory.create({ ownerId: newUuid() });
      const run = exportRun({ ownerId, assetIds: [mine.id, theirs.id], assetCount: 2 });

      mocks.memory.claimExport.mockResolvedValue({ ...run, status: MemoryExportStatus.Running } as never);
      mocks.memory.getExportForJob.mockResolvedValue({ ...run, cancelRequestedAt: null } as never);
      mocks.asset.getByIds.mockResolvedValue([mine, theirs] as never);
      mocks.storage.stat.mockResolvedValue({ size: 42 } as never);
      const { addFile } = givenZip();

      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Success);

      expect(addFile).toHaveBeenCalledTimes(1);
      expect(addFile).toHaveBeenCalledWith(mine.originalPath, expect.any(String));
      expect(mocks.memory.updateExport).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: MemoryExportStatus.Ready, sizeInBytes: 42 }),
      );
    });

    it('should rename the archive into place only once it is complete', async () => {
      const ownerId = newUuid();
      const asset = AssetFactory.create({ ownerId });
      const run = exportRun({ ownerId, assetIds: [asset.id], assetCount: 1 });

      mocks.memory.claimExport.mockResolvedValue({ ...run, status: MemoryExportStatus.Running } as never);
      mocks.memory.getExportForJob.mockResolvedValue({ ...run, cancelRequestedAt: null } as never);
      mocks.asset.getByIds.mockResolvedValue([asset] as never);
      mocks.storage.stat.mockResolvedValue({ size: 1 } as never);
      givenZip();

      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Success);

      const [partial, target] = mocks.storage.rename.mock.calls[0];
      expect(partial).toBe(`${target}.partial`);
    });

    it('should fail the run and remove the partial file when writing throws', async () => {
      const ownerId = newUuid();
      const run = exportRun({ ownerId, assetIds: [newUuid()], assetCount: 1 });

      mocks.memory.claimExport.mockResolvedValue({ ...run, status: MemoryExportStatus.Running } as never);
      mocks.asset.getByIds.mockRejectedValue(new Error('database is gone'));

      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Failed);
      expect(mocks.storage.unlink).toHaveBeenCalled();
      expect(mocks.memory.updateExport).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: MemoryExportStatus.Failed, error: 'database is gone' }),
      );
    });
  });

  describe('curation (FL-62)', () => {
    it('leaves hidden memories out and applies the show-less rules', async () => {
      const [userId, hiddenId, personId, petId] = newUuids();
      mocks.memory.getHiddenMemoryIds.mockResolvedValue([hiddenId]);
      mocks.memory.getShowLess.mockResolvedValue([
        { kind: MemoryShowLessKind.Type, value: MemoryType.Birthday, createdAt: new Date() },
        { kind: MemoryShowLessKind.Date, value: '09-25', createdAt: new Date() },
        { kind: MemoryShowLessKind.Person, value: personId, createdAt: new Date() },
        { kind: MemoryShowLessKind.Pet, value: petId, createdAt: new Date() },
      ]);
      mocks.memory.search.mockResolvedValue([]);

      await sut.search(factory.auth({ user: { id: userId } }), {});

      expect(mocks.memory.search).toHaveBeenCalledWith(
        userId,
        {},
        expect.objectContaining({
          excludeIds: [hiddenId],
          excludeTypes: [MemoryType.Birthday],
          excludeDates: ['09-25'],
          excludeSubjectIds: [personId, petId],
          excludePersonIds: [personId],
          excludePetIds: [petId],
        }),
      );
    });

    it('lists only the hidden memories, and nothing when none are hidden', async () => {
      const [userId, hiddenId] = newUuids();
      mocks.memory.search.mockResolvedValue([]);

      await expect(sut.search(factory.auth({ user: { id: userId } }), { isHidden: true })).resolves.toEqual([]);
      expect(mocks.memory.search).not.toHaveBeenCalled();

      mocks.memory.getHiddenMemoryIds.mockResolvedValue([hiddenId]);
      await sut.search(factory.auth({ user: { id: userId } }), { isHidden: true });
      expect(mocks.memory.search).toHaveBeenCalledWith(
        userId,
        { isHidden: true },
        expect.objectContaining({ onlyIds: [hiddenId] }),
      );
    });

    it('opens one memory by id whatever its curation', async () => {
      const [userId, memoryId] = newUuids();
      mocks.memory.getHiddenMemoryIds.mockResolvedValue([memoryId]);
      mocks.memory.search.mockResolvedValue([]);

      await sut.search(factory.auth({ user: { id: userId } }), { id: memoryId });

      expect(mocks.memory.search).toHaveBeenCalledWith(
        userId,
        { id: memoryId },
        { excludePersonIds: [], excludePetIds: [] },
      );
    });

    it("returns the owner's order, title and hidden state", async () => {
      const userId = newUuid();
      const first = AssetFactory.create();
      const second = AssetFactory.create();
      const memory = MemoryFactory.from({ ownerId: userId }).asset(first).asset(second).build();
      mocks.memory.search.mockResolvedValue([getForMemory(memory)]);
      mocks.memory.getCurations.mockResolvedValue(
        new Map([
          [memory.id, { memoryId: memory.id, hiddenAt: new Date(), title: 'Our summer', assetOrder: [second.id] }],
        ]),
      );

      const [result] = await sut.search(factory.auth({ user: { id: userId } }), {});

      expect(result.title).toBe('Our summer');
      expect(result.isHidden).toBe(true);
      expect(result.assets.map(({ id }) => id)).toEqual([second.id, first.id]);
    });

    it('hides a memory without touching its saved state', async () => {
      const userId = newUuid();
      const memory = MemoryFactory.create({ ownerId: userId });
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.memory.setCuration.mockResolvedValue();

      await sut.update(factory.auth({ user: { id: userId } }), memory.id, { isHidden: true });

      expect(mocks.memory.setCuration).toHaveBeenCalledWith(userId, memory.id, {
        hidden: true,
        title: undefined,
        assetOrder: undefined,
      });
      expect(mocks.memory.update).not.toHaveBeenCalled();
    });

    it("keeps only the memory's own items in a new order", async () => {
      const [userId, a, b, stranger] = newUuids();
      const memory = MemoryFactory.create({ ownerId: userId });
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.get.mockResolvedValue(getForMemory(memory));
      mocks.memory.getAssetIds.mockResolvedValue(new Set([a, b]));
      mocks.memory.setCuration.mockResolvedValue();

      await sut.update(factory.auth({ user: { id: userId } }), memory.id, { assetOrder: [b, stranger, a] });

      expect(mocks.memory.setCuration).toHaveBeenCalledWith(userId, memory.id, {
        hidden: undefined,
        title: undefined,
        assetOrder: [b, a],
      });
    });
  });

  describe('show less (FL-62)', () => {
    it('refuses an unknown memory type and an impossible date', async () => {
      await expect(
        sut.addShowLess(factory.auth(), { kind: MemoryShowLessKind.Type, value: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.addShowLess(factory.auth(), { kind: MemoryShowLessKind.Date, value: '13-40' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.memory.addShowLess).not.toHaveBeenCalled();
    });

    it("refuses another owner's person", async () => {
      const personId = newUuid();
      mocks.memory.getOwnSubjectNames.mockResolvedValue(new Map());

      await expect(
        sut.addShowLess(factory.auth(), { kind: MemoryShowLessKind.Person, value: personId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.memory.addShowLess).not.toHaveBeenCalled();
    });

    it('adds a rule for one of the owner’s people and returns the rules with names', async () => {
      const [userId, personId] = newUuids();
      const createdAt = new Date();
      mocks.memory.getOwnSubjectNames.mockImplementation((_owner, subject) =>
        Promise.resolve(subject === 'person' ? new Map([[personId, 'Ada']]) : new Map()),
      );
      mocks.memory.addShowLess.mockResolvedValue();
      mocks.memory.getShowLess.mockResolvedValue([{ kind: MemoryShowLessKind.Person, value: personId, createdAt }]);

      await expect(
        sut.addShowLess(factory.auth({ user: { id: userId } }), { kind: MemoryShowLessKind.Person, value: personId }),
      ).resolves.toEqual([{ kind: MemoryShowLessKind.Person, value: personId, name: 'Ada', createdAt }]);
      expect(mocks.memory.addShowLess).toHaveBeenCalledWith(userId, MemoryShowLessKind.Person, personId);
    });
    describe('in a locked session', () => {
      const [userId, personId, petId] = newUuids();
      const locked = () => ({
        ...factory.auth({ user: { id: userId } }),
        hideNsfwAssets: true,
        hiddenContent: {
          userId,
          includeNsfw: false,
          tagIds: [],
          personIds: [personId],
          petIds: [petId],
          scope: 'owned' as const,
        },
      });

      it('answers for a suppressed person or pet as if it did not exist', async () => {
        mocks.memory.getOwnSubjectNames.mockResolvedValue(new Map([[personId, 'Ada']]));

        await expect(sut.addShowLess(locked(), { kind: MemoryShowLessKind.Person, value: personId })).rejects.toThrow(
          'Not one of your people',
        );
        await expect(sut.addShowLess(locked(), { kind: MemoryShowLessKind.Pet, value: petId })).rejects.toThrow(
          'Not one of your pets',
        );
        expect(mocks.memory.addShowLess).not.toHaveBeenCalled();
      });

      it('never names a suppressed person or pet in the rules', async () => {
        const createdAt = new Date();
        mocks.memory.getOwnSubjectNames.mockImplementation((_owner, subject) =>
          Promise.resolve(subject === 'person' ? new Map([[personId, 'Ada']]) : new Map([[petId, 'Biscuit']])),
        );
        mocks.memory.getShowLess.mockResolvedValue([
          { kind: MemoryShowLessKind.Person, value: personId, createdAt },
          { kind: MemoryShowLessKind.Pet, value: petId, createdAt },
        ]);

        const rules = await sut.getShowLess(locked());

        expect(rules.map(({ name }) => name)).toEqual([null, null]);
      });
    });

    it('reads a single memory without the photos of people and pets shown less', async () => {
      const [userId, personId, petId] = newUuids();
      const memory = MemoryFactory.create({ ownerId: userId });
      mocks.access.memory.checkOwnerAccess.mockResolvedValue(new Set([memory.id]));
      mocks.memory.setCuration.mockResolvedValue();
      mocks.memory.getShowLess.mockResolvedValue([
        { kind: MemoryShowLessKind.Person, value: personId, createdAt: new Date() },
        { kind: MemoryShowLessKind.Pet, value: petId, createdAt: new Date() },
      ]);
      mocks.memory.get.mockResolvedValue(getForMemory(memory));

      await sut.update(factory.auth({ user: { id: userId } }), memory.id, { isHidden: false });

      expect(mocks.memory.get).toHaveBeenCalledWith(memory.id, {
        excludePersonIds: [personId],
        excludePetIds: [petId],
      });
    });
  });

  describe('birthdays and recaps (FL-62)', () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const personId = '00000000-0000-4000-8000-000000000002';
    const petId = '00000000-0000-4000-8000-000000000003';

    const assetsOn = (count: number, start: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
        localDateTime: new Date(start + index * 86_400_000),
      }));

    beforeEach(() => {
      mocks.user.getList.mockResolvedValue([{ id: userId }] as never);
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getByDayOfYear.mockResolvedValue([]);
      mocks.asset.getEventStoryCandidates.mockResolvedValue([]);
      mocks.asset.getYearInReviewCandidates.mockResolvedValue([]);
      mocks.memory.getExistingMemoryDates.mockResolvedValue([]);
      mocks.memory.hasSubjectMemory.mockResolvedValue(false);
      mocks.memory.create.mockResolvedValue({} as never);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("makes a birthday memory on the person's birthday, shown for that day in every time zone", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
      mocks.memory.getBirthdaySubjects.mockImplementation((_owner, monthDays) =>
        Promise.resolve(
          monthDays.includes('09-25')
            ? [{ subject: 'person', id: personId, name: 'Ada', birthDate: '1990-09-25' }]
            : [],
        ),
      );
      mocks.memory.getSubjectAssets.mockResolvedValue(assetsOn(5, Date.UTC(2020, 0, 1)));

      await sut.onMemoriesCreate();

      expect(mocks.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: userId,
          type: MemoryType.Birthday,
          data: expect.objectContaining({
            kind: 'birthday',
            date: '2026-09-25',
            subject: 'person',
            subjectId: personId,
            name: 'Ada',
            age: 36,
          }),
          showAt: '2026-09-24T10:00:00.000Z',
          hideAt: '2026-09-26T11:59:59.999Z',
        }),
        expect.any(Set),
      );
    });

    it('makes no birthday memory for a person the owner asked to see less of', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
      mocks.memory.getShowLess.mockResolvedValue([
        { kind: MemoryShowLessKind.Person, value: personId, createdAt: new Date() },
      ]);
      mocks.memory.getBirthdaySubjects.mockResolvedValue([
        { subject: 'person', id: personId, name: 'Ada', birthDate: '1990-09-25' },
      ]);
      mocks.memory.getSubjectAssets.mockResolvedValue(assetsOn(5, Date.UTC(2020, 0, 1)));

      await sut.onMemoriesCreate();

      expect(mocks.memory.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MemoryType.Birthday }),
        expect.anything(),
      );
    });

    it("makes last year's recap for a much-photographed pet", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'));
      mocks.memory.getRecapSubjects.mockResolvedValue([{ subject: 'pet', id: petId, name: 'Rex', count: 25 }]);
      mocks.memory.getSubjectAssets.mockResolvedValue(assetsOn(25, Date.UTC(2025, 0, 1)));

      await sut.onMemoriesCreate();

      expect(mocks.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MemoryType.PersonRecap,
          data: { kind: 'person_recap', year: 2025, subject: 'pet', subjectId: petId, name: 'Rex', assetCount: 25 },
        }),
        expect.any(Set),
      );
      expect(mocks.memory.getSubjectAssets).toHaveBeenCalledWith(userId, 'pet', petId, {
        from: new Date('2025-01-01T00:00:00.000Z'),
        to: new Date('2026-01-01T00:00:00.000Z'),
      });
    });
  });
});
