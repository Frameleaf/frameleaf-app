import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import {
  AdminAuditAction,
  AssetStatus,
  JobName,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  UserStatus,
} from 'src/enum.js';
import { AssetSyncResult } from 'src/repositories/library.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  LIBRARY_SCAN_BATCH,
  LIBRARY_SCAN_LEASE_MS,
  LibraryScanService,
  checkExistingAsset,
  mapLibraryScan,
} from 'src/services/library-scan.service.js';
import { emptyLibraryScanResult, libraryPathsFingerprint } from 'src/utils/library-scan.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const directory = { isDirectory: () => true } as Stats;
const file = (mtime = new Date('2024-01-01')) => ({ isDirectory: () => false, mtime }) as Stats;
const enoent = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));

async function* walkOf(...batches: string[][]) {
  for (const batch of batches) {
    // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject
    yield await Promise.resolve(batch);
  }
}

describe(LibraryScanService.name, () => {
  let sut: LibraryScanService;
  let mocks: ServiceMocks;
  let operations: Record<string, ReturnType<typeof vi.fn>>;

  const library = factory.library({ name: 'Family archive', importPaths: ['/mnt/photos'], exclusionPatterns: [] });
  const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

  const operationOf = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
    ({
      id: newUuid(),
      ownerId: authStub.admin.user.id,
      kind: MediaOperationKind.LibraryScan,
      status: MediaOperationStatus.Preparing,
      snapshot: { libraryId: library.id, trigger: 'manual' },
      result: emptyLibraryScanResult(),
      progress: 0,
      processedUnits: '0',
      totalUnits: '0',
      autoRetries: 0,
      createdAt: new Date('2026-09-23T10:00:00Z'),
      startedAt: null,
      finishedAt: null,
      pauseRequestedAt: null,
      error: null,
      errorCode: null,
      ...overrides,
    }) as unknown as MediaOperation;

  beforeEach(() => {
    mocks = getMocks();
    operations = {
      createUnlessActive: vi.fn(),
      getActiveBySubject: vi.fn().mockResolvedValue(undefined),
      getLatestBySubject: vi.fn().mockResolvedValue([]),
      hasClaimable: vi.fn().mockResolvedValue(false),
      requestCancel: vi.fn(),
      setFinishedResult: vi.fn().mockResolvedValue(true),
      claimNext: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(running),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
      requeue: vi.fn().mockResolvedValue(true),
    };
    sut = new LibraryScanService(
      mocks.logger as never,
      operations as unknown as MediaOperationRepository,
      mocks.library as never,
      mocks.asset as never,
      mocks.assetJob as never,
      mocks.storage as never,
      mocks.job as never,
      mocks.user as never,
      mocks.event as never,
      mocks.crypto as never,
      mocks.adminAudit as never,
    );

    mocks.library.get.mockResolvedValue(library);
    mocks.library.update.mockResolvedValue(library);
    mocks.library.withScanClaim.mockImplementation(async (_claim, mutate) => ({
      value: await mutate(mocks.asset as never, mocks.library as never),
    }));
    mocks.user.get.mockResolvedValue(UserFactory.create({ id: library.ownerId }));
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }) as never);
    mocks.storage.checkFileExists.mockResolvedValue(true);
    mocks.storage.stat.mockImplementation((path: string) =>
      Promise.resolve(path === '/mnt/photos' ? directory : file()),
    );
    mocks.storage.walk.mockImplementation(() => walkOf());
    mocks.asset.getLibraryAssetCount.mockResolvedValue(0);
    mocks.asset.filterNewExternalAssetPaths.mockImplementation((_id: string, paths: string[]) =>
      Promise.resolve(paths),
    );
    mocks.asset.createAll.mockImplementation((rows: unknown[]) => Promise.resolve(rows.map(() => newUuid())));
    mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 0n } as never);
    mocks.library.countOnlineAssetsUnder.mockResolvedValue(0);
    mocks.library.getAssetIdPage.mockResolvedValue([]);
    mocks.crypto.hashSha1.mockReturnValue(Buffer.from('hash'));
  });

  describe('queueManual', () => {
    it('queues one scan, wakes the library queue and records who asked', async () => {
      const operation = operationOf();
      operations.createUnlessActive.mockResolvedValue({ created: operation });

      await sut.queueManual(authStub.admin, library.id);

      expect(operations.createUnlessActive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.admin.user.id,
          kind: MediaOperationKind.LibraryScan,
          label: 'Family archive',
          snapshot: { libraryId: library.id, trigger: 'manual' },
        }),
        expect.objectContaining({ key: 'libraryId', value: library.id }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryScanRun, data: {} });
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LibraryScanQueued, libraryId: library.id }),
      ]);
    });

    it('answers a second request with the scan already waiting (duplicate request)', async () => {
      operations.createUnlessActive.mockResolvedValue({ active: operationOf() });

      await sut.queueManual(authStub.admin, library.id);

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.adminAudit.create).not.toHaveBeenCalled();
    });

    it('refuses a library whose owner account is deleted', async () => {
      mocks.user.get.mockResolvedValue(UserFactory.create({ deletedAt: new Date(), status: UserStatus.Deleted }));

      await expect(sut.queueManual(authStub.admin, library.id)).rejects.toThrow('owner account is deleted');
      expect(operations.createUnlessActive).not.toHaveBeenCalled();
    });

    it('refuses a library without import folders', async () => {
      mocks.library.get.mockResolvedValue({ ...library, importPaths: [] });

      await expect(sut.queueManual(authStub.admin, library.id)).rejects.toThrow('Add at least one import folder');
    });

    it('refuses a library that does not exist', async () => {
      mocks.library.get.mockResolvedValue(undefined);

      await expect(sut.queueManual(authStub.admin, newUuid())).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cancel', () => {
    it("cancels the library's scan whoever started it", async () => {
      const operation = operationOf({ ownerId: 'another-admin' });
      operations.getActiveBySubject.mockResolvedValue(operation);

      await sut.cancel(authStub.admin, library.id);

      expect(operations.requestCancel).toHaveBeenCalledWith(operation.id, 'another-admin');
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LibraryScanCancelled }),
      ]);
    });

    it('says so when there is nothing to cancel', async () => {
      await expect(sut.cancel(authStub.admin, library.id)).rejects.toThrow('No active scan to cancel');
    });
  });

  describe('stop', () => {
    it('records why a waiting scan was stopped', async () => {
      const operation = operationOf({ status: MediaOperationStatus.Queued });
      operations.getActiveBySubject.mockResolvedValue(operation);
      operations.requestCancel.mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelled });

      await sut.onLibraryScanStop({ libraryId: library.id, reason: 'paths_changed' });

      expect(operations.setFinishedResult).toHaveBeenCalledWith(
        operation.id,
        expect.objectContaining({ stopReason: 'paths_changed' }),
      );
    });

    it("stops the scans of a deleted owner's libraries", async () => {
      const operation = operationOf();
      mocks.library.getAll.mockResolvedValue([library, factory.library()]);
      operations.getActiveBySubject.mockResolvedValue(operation);
      operations.requestCancel.mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelling });

      await sut.onUserTrash({ id: library.ownerId } as never);

      expect(operations.getActiveBySubject).toHaveBeenCalledTimes(1);
      expect(operations.requestCancel).toHaveBeenCalledWith(operation.id, operation.ownerId);
    });
  });

  describe('handleQueueScanAll', () => {
    it("queues every library's scan under the server administrator, skipping refusals", async () => {
      const other = factory.library({ importPaths: [] });
      mocks.library.getAll.mockResolvedValue([library, other]);
      operations.createUnlessActive.mockResolvedValue({ created: operationOf() });

      await expect(sut.handleQueueScanAll()).resolves.toBe(JobStatus.Success);

      expect(operations.createUnlessActive).toHaveBeenCalledTimes(1);
      expect(operations.createUnlessActive).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: { libraryId: library.id, trigger: 'automatic' } }),
        expect.anything(),
      );
    });

    it('never runs a legacy item check', async () => {
      await expect(
        sut.handleSyncAssets({
          libraryId: library.id,
          importPaths: [],
          exclusionPatterns: [],
          assetIds: ['a'],
          progressCounter: 1,
          totalAssets: 1,
        }),
      ).resolves.toBe(JobStatus.Skipped);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('imports new files, checks existing items and completes', async () => {
      const existing = { id: 'asset-1', isOffline: false, libraryId: library.id, status: AssetStatus.Active };
      mocks.storage.walk.mockImplementation(() => walkOf(['/mnt/photos/new.jpg', '/mnt/photos/old.jpg']));
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue(['/mnt/photos/new.jpg']);
      mocks.asset.getLibraryAssetCount.mockResolvedValue(2);
      mocks.library.getAssetIdPage.mockResolvedValueOnce([{ id: 'asset-1' }]).mockResolvedValue([]);
      mocks.assetJob.getForSyncAssets.mockResolvedValue([
        { ...existing, originalPath: '/mnt/photos/gone.jpg', fileModifiedAt: new Date('2024-01-01') },
      ] as never);
      mocks.storage.stat.mockImplementation((path: string) =>
        path === '/mnt/photos'
          ? Promise.resolve(directory)
          : path.endsWith('gone.jpg')
            ? enoent()
            : Promise.resolve(file()),
      );

      const operation = operationOf();
      await sut.run(operation, 'token');

      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({ originalPath: '/mnt/photos/new.jpg', libraryId: library.id, isExternal: true }),
      ]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: expect.any(String), source: 'upload' } },
      ]);
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['asset-1'], { isOffline: true, deletedAt: expect.any(Date) });
      expect(mocks.library.update).toHaveBeenCalledWith(library.id, { refreshedAt: expect.any(Date) });
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        operation.id,
        'token',
        expect.objectContaining({
          result: expect.objectContaining({ phase: 'done', added: 1, crawled: 2, checked: 1, offlined: 1 }),
        }),
      );
      expect(operations.complete).toHaveBeenCalledWith(operation.id, 'token', { resultAssetId: null });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('fails, changing nothing, when an import folder does not exist', async () => {
      mocks.storage.stat.mockImplementation(() => enoent());

      await sut.run(operationOf(), 'token');

      expect(operations.fail).toHaveBeenCalledWith(expect.any(String), 'token', {
        error: expect.stringContaining('/mnt/photos: Path does not exist'),
        errorCode: 'library_source_unavailable',
      });
      expect(mocks.storage.walk).not.toHaveBeenCalled();
      expect(mocks.asset.detectOfflineExternalAssets).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('fails, changing nothing, when an import folder is not readable', async () => {
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await sut.run(operationOf(), 'token');

      expect(operations.fail).toHaveBeenCalledWith(expect.any(String), 'token', {
        error: expect.stringContaining('Lacking read permission'),
        errorCode: 'library_source_unavailable',
      });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('fails instead of marking everything missing when a folder comes back empty', async () => {
      mocks.storage.walk.mockImplementation(() => walkOf([]));
      mocks.library.countOnlineAssetsUnder.mockResolvedValue(120);
      mocks.library.getAssetIdPage.mockResolvedValue([{ id: 'asset-1' }]);

      await sut.run(operationOf(), 'token');

      expect(mocks.library.countOnlineAssetsUnder).toHaveBeenCalledWith(library.id, '/mnt/photos');
      expect(operations.fail).toHaveBeenCalledWith(expect.any(String), 'token', {
        error: expect.stringContaining('/mnt/photos has no files but 120 indexed items'),
        errorCode: 'library_source_empty',
      });
      expect(mocks.assetJob.getForSyncAssets).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('stops checking items when the folder disappears mid-scan', async () => {
      const result = { ...emptyLibraryScanResult(), phase: 'check', fingerprint: libraryPathsFingerprint(library) };
      mocks.library.getAssetIdPage.mockResolvedValue([{ id: 'asset-1' }]);
      let calls = 0;
      mocks.storage.stat.mockImplementation((path: string) => {
        if (path === '/mnt/photos') {
          calls += 1;
          return calls === 1 ? Promise.resolve(directory) : enoent();
        }
        return enoent();
      });

      await sut.run(operationOf({ result: result as never }), 'token');

      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ errorCode: 'library_source_unavailable' }),
      );
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('resumes the check from its recorded cursor', async () => {
      const result = {
        ...emptyLibraryScanResult(),
        phase: 'check',
        cursor: 'asset-9',
        checked: 9,
        fingerprint: libraryPathsFingerprint(library),
      };

      await sut.run(operationOf({ result: result as never }), 'token');

      expect(mocks.storage.walk).not.toHaveBeenCalled();
      expect(mocks.library.getAssetIdPage).toHaveBeenCalledWith(library.id, 'asset-9', LIBRARY_SCAN_BATCH);
      expect(operations.complete).toHaveBeenCalled();
    });

    it.each(['resume', 'mid-stat'])('refuses an empty readable root during %s checking', async (when) => {
      const result = { ...emptyLibraryScanResult(), phase: 'check', fingerprint: libraryPathsFingerprint(library) };
      mocks.library.getAssetIdPage.mockResolvedValueOnce([{ id: 'asset-1' }]).mockResolvedValue([]);
      mocks.assetJob.getForSyncAssets.mockResolvedValue([
        { id: 'asset-1', originalPath: '/mnt/photos/gone.jpg', isOffline: false, status: AssetStatus.Active },
      ] as never);
      mocks.library.countOnlineAssetsUnder.mockResolvedValue(12);
      let disconnected = when === 'resume';
      mocks.storage.walk.mockImplementation(() => (disconnected ? walkOf() : walkOf(['/mnt/photos/gone.jpg'])));
      mocks.storage.stat.mockImplementation((path: string) => {
        if (path === '/mnt/photos') return Promise.resolve(directory);
        disconnected = true;
        return enoent();
      });
      await sut.run(operationOf({ result: result as never }), 'token');
      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ errorCode: 'library_source_empty' }),
      );
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it.each(['crawl', 'check'])('fences an old %s runner after a replacement finishes', async (phase) => {
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = 'old';
      mocks.library.withScanClaim.mockImplementation(async (claim, mutate) =>
        claim.claimToken === held ? { value: await mutate(mocks.asset as never, mocks.library as never) } : undefined,
      );
      operations.setBulkResult.mockImplementation((_id, token) => (token === held ? running : undefined));
      const result = { ...emptyLibraryScanResult(), phase, fingerprint: libraryPathsFingerprint(library) };
      const operation = operationOf({ result: result as never });
      if (phase === 'crawl') {
        mocks.storage.walk.mockImplementationOnce(async function* () {
          waiting.resolve();
          await release.promise;
          yield ['/mnt/photos/stale.jpg'];
        });
      } else {
        mocks.library.getAssetIdPage.mockResolvedValueOnce([{ id: 'asset-1' }]).mockResolvedValue([]);
        mocks.assetJob.getForSyncAssets.mockResolvedValue([
          { id: 'asset-1', originalPath: '/mnt/photos/old.jpg', isOffline: false, status: AssetStatus.Active },
        ] as never);
        mocks.storage.stat.mockImplementation(async (path: string) => {
          if (path === '/mnt/photos') return directory;
          waiting.resolve();
          await release.promise;
          return null as never;
        });
      }
      const old = sut.run(operation, 'old');
      await waiting.promise;
      held = 'replacement';
      await sut.run(operation, held);
      release.resolve();
      await old;
      expect(operations.complete).toHaveBeenCalledExactlyOnceWith(operation.id, held, { resultAssetId: null });
      expect(mocks.asset.createAll).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('stops a delayed walk when its heartbeat loses the claim', async () => {
      vi.useFakeTimers();
      try {
        const waiting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        operations.heartbeat.mockResolvedValue(false);
        mocks.storage.walk.mockImplementationOnce(async function* () {
          waiting.resolve();
          await release.promise;
          yield ['/mnt/photos/stale.jpg'];
        });
        const run = sut.run(operationOf(), 'token');
        await waiting.promise;
        await vi.advanceTimersByTimeAsync(LIBRARY_SCAN_LEASE_MS / 4);
        release.resolve();
        await run;
        expect(operations.heartbeat).toHaveBeenCalled();
        expect(mocks.library.withScanClaim).not.toHaveBeenCalled();
        expect(mocks.asset.createAll).not.toHaveBeenCalled();
        expect(operations.complete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops, saying why, when the folders changed while the scan waited', async () => {
      const result = { ...emptyLibraryScanResult(), fingerprint: 'an-older-set-of-folders' };
      const operation = operationOf({ result: result as never });

      await sut.run(operation, 'token');

      expect(operations.requestCancel).toHaveBeenCalledWith(operation.id, operation.ownerId, 'token');
      expect(operations.setFinishedResult).toHaveBeenCalledWith(
        operation.id,
        expect.objectContaining({ stopReason: 'paths_changed' }),
      );
      expect(mocks.storage.walk).not.toHaveBeenCalled();
    });

    it('records the removal as the reason when a removed library cancels its scan', async () => {
      mocks.storage.walk.mockImplementation(() => walkOf(['/mnt/photos/a.jpg']));
      operations.setBulkResult.mockResolvedValue({ ...running, status: MediaOperationStatus.Cancelling });
      mocks.library.get.mockResolvedValueOnce(library).mockResolvedValue({ ...library, deletedAt: new Date() });

      await sut.run(operationOf(), 'token');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(expect.any(String), 'token', { released: false });
      expect(operations.setFinishedResult).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ stopReason: 'library_removed' }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('does not write a cancellation result after losing the scan claim', async () => {
      const result = { ...emptyLibraryScanResult(), fingerprint: 'an-older-set-of-folders' };
      operations.acknowledgeCancel.mockResolvedValue(false);
      const operation = operationOf({ result: result as never });

      await sut.run(operation, 'stale-token');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operation.id, 'stale-token', { released: false });
      expect(operations.setFinishedResult).not.toHaveBeenCalled();
      expect(mocks.storage.walk).not.toHaveBeenCalled();
    });

    it('hands the scan back at a batch boundary when a pause was asked for', async () => {
      mocks.storage.walk.mockImplementation(() => walkOf(['/mnt/photos/a.jpg'], ['/mnt/photos/b.jpg']));
      operations.setBulkResult.mockResolvedValue({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(), 'token');

      expect(operations.settlePause).toHaveBeenCalledTimes(1);
      expect(mocks.asset.createAll).toHaveBeenCalledTimes(1);
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('refuses to scan for a deleted owner', async () => {
      mocks.user.get.mockResolvedValue(UserFactory.create({ deletedAt: new Date(), status: UserStatus.Deleted }));

      await sut.run(operationOf(), 'token');

      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ errorCode: 'library_scan_owner_inactive' }),
      );
      expect(mocks.asset.createAll).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('wakes the library queue only when a scan is waiting', async () => {
      await sut.tick();
      expect(mocks.job.queue).not.toHaveBeenCalled();

      operations.hasClaimable.mockResolvedValue(true);
      await sut.tick();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryScanRun, data: {} });
    });
  });

  describe('withScans', () => {
    it("attaches each library's latest scan", async () => {
      const operation = operationOf({
        status: MediaOperationStatus.Failed,
        error: '/mnt/photos: Path does not exist (ENOENT)',
        errorCode: 'library_source_unavailable',
      });
      operations.getLatestBySubject.mockResolvedValue([operation]);
      const other = { id: newUuid() };

      const [first, second] = await sut.withScans([{ id: library.id } as never, other as never]);

      expect(first.scan).toEqual(
        expect.objectContaining({
          operationId: operation.id,
          status: MediaOperationStatus.Failed,
          errorCode: 'library_source_unavailable',
        }),
      );
      expect(second.scan).toBeNull();
    });
  });
});

describe('checkExistingAsset', () => {
  const asset = {
    isOffline: false,
    originalPath: '/mnt/photos/a.jpg',
    status: AssetStatus.Active,
    fileModifiedAt: new Date('2024-01-01'),
  };

  it('marks a missing file offline', () => {
    expect(checkExistingAsset(asset, null)).toBe(AssetSyncResult.OFFLINE);
  });

  it('leaves an offline item with a still-missing file alone', () => {
    expect(checkExistingAsset({ ...asset, isOffline: true }, null)).toBe(AssetSyncResult.DO_NOTHING);
  });

  it('considers an offline item whose file is back', () => {
    expect(checkExistingAsset({ ...asset, isOffline: true }, { mtime: asset.fileModifiedAt })).toBe(
      AssetSyncResult.CHECK_OFFLINE,
    );
  });

  it('reads a changed file again', () => {
    expect(checkExistingAsset(asset, { mtime: new Date('2025-01-01') })).toBe(AssetSyncResult.UPDATE);
  });

  it('leaves an unchanged file alone', () => {
    expect(checkExistingAsset(asset, { mtime: asset.fileModifiedAt })).toBe(AssetSyncResult.DO_NOTHING);
  });
});

describe('mapLibraryScan', () => {
  it('reports a completed scan at 100 and a pending pause', () => {
    const base = {
      id: newUuid(),
      snapshot: {},
      result: { phase: 'done', added: 3 },
      processedUnits: '5',
      totalUnits: '5',
      createdAt: new Date(),
    };
    expect(mapLibraryScan({ ...base, status: MediaOperationStatus.Completed, progress: 99 } as never)).toEqual(
      expect.objectContaining({ progress: 100, added: 3, processedUnits: 5 }),
    );
    expect(
      mapLibraryScan({
        ...base,
        status: MediaOperationStatus.Rendering,
        progress: 40,
        pauseRequestedAt: new Date(),
      } as never),
    ).toEqual(expect.objectContaining({ progress: 40, pauseRequested: true }));
  });
});
