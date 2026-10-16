import { StorageCore } from 'src/cores/storage.core.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetVisibility, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { TakeoutFile, TakeoutImport, TakeoutItem, TakeoutSource } from 'src/repositories/takeout.repository.js';
import { TakeoutWorkerService } from 'src/services/takeout-worker.service.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { TAKEOUT_DEFAULT_OPTIONS, TakeoutPhase, takeoutStableId } from 'src/utils/takeout.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const ownerId = authStub.user1.user.id;
const importId = '0195e2a0-0000-7000-8000-000000000001';
const operationId = '0195e2a0-0000-7000-8000-0000000000aa';
const claimToken = 'claim-token';
const assetId = '6f1c1a0e-4444-4444-8444-444444444444';

const operationOf = (action: 'scan' | 'import', result: Record<string, unknown> | null = null): MediaOperation =>
  ({
    id: operationId,
    ownerId,
    kind: MediaOperationKind.TakeoutImport,
    status: MediaOperationStatus.Preparing,
    snapshot: { importId, action },
    result,
    processedUnits: '0',
    totalUnits: null,
  }) as unknown as MediaOperation;

const rowOf = (phase: TakeoutPhase, options: Record<string, unknown> = {}): TakeoutImport => ({
  id: importId,
  ownerId,
  name: 'Google Photos import',
  phase,
  options: { ...TAKEOUT_DEFAULT_OPTIONS, ...options },
  runOperationId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const itemOf = (overrides: Partial<TakeoutItem> = {}): TakeoutItem => ({
  id: '6f1c1a0e-1111-4111-8111-111111111111',
  importId,
  state: 'ready',
  metadata: {
    title: 'IMG_1.jpg',
    description: 'From Google',
    takenAt: '2020-01-01T00:00:00.000Z',
    latitude: 1,
    longitude: 2,
    favorite: true,
  },
  sidecarId: null,
  candidates: [],
  albums: ['Trip'],
  warnings: [],
  locked: false,
  assetId: null,
  resultKind: null,
  createPath: null,
  withheld: false,
  error: null,
  relativePath: 'Trip/IMG_1.jpg',
  folder: 'Trip',
  name: 'IMG_1.jpg',
  kind: 'image',
  path: '/data/takeout/staged/1',
  size: 10,
  checksum: Buffer.alloc(32, 1),
  legacyChecksum: Buffer.alloc(20, 1),
  modifiedAt: new Date(0),
  sourceName: 'takeout-001.zip',
  ...overrides,
});

const assetState = (overrides: Record<string, unknown> = {}) => ({
  id: assetId,
  ownerId,
  deletedAt: null,
  description: null,
  latitude: null,
  longitude: null,
  isFavorite: false,
  visibility: AssetVisibility.Timeline,
  livePhotoVideoId: null,
  originalPath: '/data/upload/user-id/6f/1c/6f1c1a0e.jpg',
  locked: false,
  ...overrides,
});

describe(TakeoutWorkerService.name, () => {
  let sut: TakeoutWorkerService;
  let operations: Record<string, any>;
  let repository: Record<string, any>;
  let staging: Record<string, any>;
  let assetMedia: Record<string, any>;
  let assets: Record<string, any>;
  let albums: Record<string, any>;
  let livePhoto: Record<string, any>;
  let users: Record<string, any>;
  let importRoots: string[];
  let pending: TakeoutItem[][];

  const working = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    pending = [];
    importRoots = ['/imports'];
    operations = {
      claimNext: vi.fn().mockResolvedValue(undefined),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(working),
      heartbeat: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    };
    repository = {
      getById: vi.fn().mockResolvedValue(rowOf('importing')),
      claimRun: vi.fn().mockResolvedValue(true),
      advancePhase: vi.fn().mockResolvedValue(true),
      sources: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ files: 0 }),
      isOriginalPath: vi.fn().mockResolvedValue(false),
      hasFile: vi.fn().mockResolvedValue(false),
      recordFile: vi.fn(),
      markSourceScanned: vi.fn(),
      folders: vi.fn().mockResolvedValue([]),
      folderFiles: vi.fn().mockResolvedValue([]),
      stagedSidecarPaths: vi.fn().mockResolvedValue([]),
      recordItem: vi.fn(),
      recordPair: vi.fn(),
      countPending: vi.fn().mockResolvedValue(1),
      countApprovedPairs: vi.fn().mockResolvedValue(0),
      pendingItems: vi.fn(() => Promise.resolve(pending.shift() ?? [])),
      approvedPairs: vi.fn().mockResolvedValue([]),
      pairDone: vi.fn(),
      itemCreating: vi.fn(),
      itemAsset: vi.fn(),
      itemDone: vi.fn(),
      retryFailed: vi.fn().mockResolvedValue(0),
      retryFailedPairs: vi.fn().mockResolvedValue(0),
      getAssetState: vi.fn().mockResolvedValue(assetState()),
      getAlbumFor: vi.fn().mockResolvedValue(undefined),
      setAlbumFor: vi.fn((_owner: string, _folder: string, id: string) => Promise.resolve(id)),
    };
    staging = {
      prepare: vi.fn().mockResolvedValue('/data/takeout/owner/import'),
      freeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 4),
      openArchive: vi.fn(),
      readArchiveDirectory: vi.fn(),
      stageArchiveEntry: vi.fn(),
      readSidecar: vi.fn(),
      remove: vi.fn(),
      walk: vi.fn(),
      stageFile: vi.fn(),
      isInsideRoots: vi.fn((folder: string, roots: string[]) =>
        Promise.resolve(roots.some((root) => folder.startsWith(root))),
      ),
      copyToLibrary: vi.fn(
        async (
          _staged: string,
          _size: number,
          _destination: string,
          _signal: AbortSignal,
          onCreated: () => Promise<void>,
        ) => {
          await onCreated();
          return { size: 10, checksum: Buffer.alloc(32, 1), legacyChecksum: Buffer.alloc(20, 1) };
        },
      ),
    };
    assetMedia = {
      bulkUploadCheck: vi.fn().mockResolvedValue({ results: [{ id: 'sha256' }, { id: 'sha1' }] }),
      uploadAsset: vi.fn().mockResolvedValue({ id: assetId, status: AssetMediaStatus.CREATED }),
    };
    assets = { lock: vi.fn(), update: vi.fn(), fillMissingMetadata: vi.fn().mockResolvedValue(true) };
    albums = {
      create: vi.fn().mockResolvedValue({ id: 'album-1' }),
      addAssets: vi.fn().mockResolvedValue([{ id: assetId, success: true }]),
      delete: vi.fn(),
    };
    livePhoto = { relinkOne: vi.fn().mockResolvedValue({ success: true }) };
    users = { get: vi.fn().mockResolvedValue({ ...authStub.user1.user }) };
    const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    sut = new TakeoutWorkerService(
      logger as never,
      operations as never,
      repository as never,
      staging as never,
      users as never,
      assetMedia as never,
      assets as never,
      albums as never,
      livePhoto as never,
      { getEnv: () => ({ storage: { importRoots } }) } as never,
    );
  });

  describe('authFor', () => {
    it('acts for the owner as an elevated system actor, so Locked media is reachable', async () => {
      const auth = await sut.authFor(ownerId);
      expect(auth?.user.id).toBe(ownerId);
      expect(auth?.session?.hasElevatedPermission).toBe(true);
      expect(auth?.sharedLink).toBeUndefined();
    });
  });

  describe('worker lifetime', () => {
    let heartbeat: () => void;
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const digest = { size: 10, checksum: Buffer.alloc(32, 1), legacyChecksum: Buffer.alloc(20, 1) };

    beforeEach(() => {
      vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
        heartbeat = callback;
        return 0 as never;
      }) as never);
    });
    afterEach(async () => {
      await sut.onShutdown();
      vi.restoreAllMocks();
    });

    it('returns a claim delivered after shutdown without starting the import', async () => {
      const claimed = Promise.withResolvers<{ operation: MediaOperation; claimToken: string } | undefined>();
      operations.claimNext.mockReturnValueOnce(claimed.promise);
      sut.tick();
      sut.tick();
      expect(operations.claimNext).toHaveBeenCalledOnce();
      const stop = sut.onShutdown();
      try {
        claimed.resolve({ operation: operationOf('import'), claimToken });
        await stop;
        expect(repository.getById).not.toHaveBeenCalled();
        expect(operations.requeue).toHaveBeenCalledWith(operationId, claimToken, { delayMs: 0, returnAttempt: true });
        expect(operations.complete).not.toHaveBeenCalled();
      } finally {
        claimed.resolve(undefined);
        await stop;
      }
    });

    it('returns prepared work when shutdown starts during the owner read', async () => {
      const owner = Promise.withResolvers<typeof authStub.user1.user>();
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      users.get.mockReturnValueOnce(owner.promise);
      sut.tick();
      await vi.waitFor(() => expect(users.get).toHaveBeenCalledOnce());
      const stop = sut.onShutdown();
      try {
        owner.resolve({ ...authStub.user1.user });
        await stop;
        expect(repository.pendingItems).not.toHaveBeenCalled();
        expect(operations.requeue).toHaveBeenCalledWith(operationId, claimToken, { delayMs: 0, returnAttempt: true });
        expect(operations.complete).not.toHaveBeenCalled();
      } finally {
        owner.resolve({ ...authStub.user1.user });
        await stop;
      }
    });

    it('does not upload a file whose noncooperative copy finishes after shutdown', async () => {
      const copied = Promise.withResolvers<typeof digest>();
      pending = [[itemOf()]];
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      staging.copyToLibrary.mockReturnValueOnce(copied.promise);
      sut.tick();
      await vi.waitFor(() => expect(staging.copyToLibrary).toHaveBeenCalledOnce());
      const stop = sut.onShutdown();
      try {
        copied.resolve(digest);
        await stop;
        expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
        expect(operations.requeue).toHaveBeenCalledWith(operationId, claimToken, { delayMs: 0, returnAttempt: true });
      } finally {
        copied.resolve(digest);
        await stop;
      }
    });

    it('never overlaps heartbeat writes', async () => {
      const items = Promise.withResolvers<TakeoutItem[]>(),
        written = Promise.withResolvers<typeof working>();
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      repository.pendingItems.mockReturnValueOnce(items.promise);
      sut.tick();
      await vi.waitFor(() => expect(repository.pendingItems).toHaveBeenCalledOnce());
      try {
        operations.setBulkResult.mockReturnValueOnce(written.promise);
        heartbeat();
        heartbeat();
        expect(operations.setBulkResult).toHaveBeenCalledTimes(2);
      } finally {
        written.resolve(working);
        items.resolve([]);
        await sut.onShutdown();
      }
    });

    it('waits for its outstanding heartbeat before shutdown returns', async () => {
      const items = Promise.withResolvers<TakeoutItem[]>(),
        written = Promise.withResolvers<typeof working>();
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      repository.pendingItems.mockReturnValueOnce(items.promise);
      sut.tick();
      await vi.waitFor(() => expect(repository.pendingItems).toHaveBeenCalledOnce());
      operations.setBulkResult.mockReturnValueOnce(written.promise);
      heartbeat();
      let stopped = false;
      const stop = sut.onShutdown().then(() => {
        stopped = true;
      });
      try {
        items.resolve([]);
        await vi.waitFor(() => expect(operations.requeue).toHaveBeenCalled());
        await turn();
        expect(stopped).toBe(false);
      } finally {
        written.resolve(working);
        items.resolve([]);
        await stop;
      }
    });

    it('orders the retry checkpoint after an earlier heartbeat snapshot', async () => {
      const items = Promise.withResolvers<TakeoutItem[]>(),
        written = Promise.withResolvers<typeof working>();
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      repository.pendingItems.mockReturnValueOnce(items.promise);
      repository.retryFailed.mockResolvedValue(1);
      sut.tick();
      await vi.waitFor(() => expect(repository.pendingItems).toHaveBeenCalledOnce());
      try {
        operations.setBulkResult.mockReturnValueOnce(written.promise);
        heartbeat();
        items.resolve([]);
        await vi.waitFor(() => expect(repository.retryFailed).toHaveBeenCalled());
        await turn();
        expect(operations.setBulkResult).toHaveBeenCalledTimes(2);
        expect(operations.requeue).not.toHaveBeenCalled();
        written.resolve(working);
        await vi.waitFor(() => expect(operations.requeue).toHaveBeenCalled());
        expect(operations.setBulkResult).toHaveBeenLastCalledWith(
          operationId,
          claimToken,
          expect.objectContaining({ result: { itemRetryUsed: true } }),
        );
      } finally {
        written.resolve(working);
        items.resolve([]);
        await sut.onShutdown();
      }
    });

    it('aborts an active copy when its heartbeat cannot renew the claim', async () => {
      pending = [[itemOf()]];
      operations.claimNext.mockResolvedValueOnce({ operation: operationOf('import'), claimToken });
      let signal!: AbortSignal;
      staging.copyToLibrary.mockImplementationOnce(
        (_path: string, _size: number, _destination: string, copySignal: AbortSignal) => {
          signal = copySignal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        },
      );
      sut.tick();
      await vi.waitFor(() => expect(staging.copyToLibrary).toHaveBeenCalledOnce());
      try {
        operations.setBulkResult.mockRejectedValueOnce(new Error('database unavailable'));
        heartbeat();
        await turn();
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() => expect(operations.fail).toHaveBeenCalled());
        expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      } finally {
        await sut.onShutdown();
      }
    });

    it('refuses new ticks once shutdown has completed', async () => {
      await sut.onShutdown();
      sut.tick();
      expect(operations.claimNext).not.toHaveBeenCalled();
    });

    it.each(['pause', 'cancel', 'claim loss'] as const)(
      'closes scan input before settling %s and retains the unfinished archive',
      async (request) => {
        const cleaned = Promise.withResolvers<void>();
        const close = vi.fn();
        repository.getById.mockResolvedValue(rowOf('scanning'));
        repository.sources.mockResolvedValue([
          { id: 'source', name: 'takeout.zip', kind: 'zip', path: '/staged/archive', scanned: false },
        ]);
        staging.openArchive.mockResolvedValue({ source: {}, close });
        staging.readArchiveDirectory.mockResolvedValue([
          { name: 'Takeout/Google Photos/Trip/photo.jpg', uncompressedSize: 10, modifiedAt: new Date(0) },
        ]);
        staging.stageArchiveEntry.mockImplementationOnce(
          (_path: string, _source: unknown, _entry: unknown, _destination: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  void cleaned.promise.then(() => reject(signal.reason));
                },
                { once: true },
              ),
            ),
        );
        operations.claimNext.mockResolvedValueOnce({ operation: operationOf('scan'), claimToken });
        sut.tick();
        await vi.waitFor(() => expect(staging.stageArchiveEntry).toHaveBeenCalledOnce());
        try {
          operations.setBulkResult.mockResolvedValueOnce(
            request === 'claim loss'
              ? undefined
              : {
                  ...working,
                  pauseRequestedAt: request === 'pause' ? new Date() : null,
                  cancelRequestedAt: request === 'cancel' ? new Date() : null,
                },
          );
          heartbeat();
          await turn();
          expect(close).not.toHaveBeenCalled();
          expect(operations.settlePause).not.toHaveBeenCalled();
          expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
          cleaned.resolve();
          if (request !== 'claim loss') {
            const settle = request === 'pause' ? operations.settlePause : operations.acknowledgeCancel;
            await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
            expect(close.mock.invocationCallOrder[0]).toBeLessThan(settle.mock.invocationCallOrder[0]);
          }
          await sut.onShutdown();
          expect(close).toHaveBeenCalledOnce();
          if (request === 'claim loss') expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
          expect(operations.requeue).not.toHaveBeenCalled();
          expect(operations.fail).not.toHaveBeenCalled();
          expect(operations.complete).not.toHaveBeenCalled();
          expect(repository.markSourceScanned).not.toHaveBeenCalled();
          expect(staging.remove).not.toHaveBeenCalledWith('/staged/archive');
        } finally {
          cleaned.resolve();
          await sut.onShutdown();
        }
      },
    );
  });

  describe('run', () => {
    it.each([true, false])(
      'settles cancellation when an interrupted pause cannot requeue (requeued: %s)',
      async (requeued) => {
        operations.settlePause.mockResolvedValue(false);
        operations.requeue.mockResolvedValue(requeued);
        const worker = sut as unknown as {
          settleInterrupt(
            run: { operation: MediaOperation; claimToken: string },
            interrupt: { request: 'pause' },
          ): Promise<void>;
        };

        await worker.settleInterrupt({ operation: operationOf('import'), claimToken }, { request: 'pause' });

        expect(operations.requeue).toHaveBeenCalledWith(operationId, claimToken, { delayMs: 0, returnAttempt: true });
        if (requeued) {
          expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
        } else {
          expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: false });
        }
      },
    );

    it('fails a job that does not name an import step', async () => {
      await sut.run({ ...operationOf('scan'), snapshot: {} } as MediaOperation, claimToken);
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'takeout_snapshot_invalid' }),
      );
    });

    it('fails when the import was deleted or belongs to someone else', async () => {
      repository.getById.mockResolvedValue({ ...rowOf('importing'), ownerId: 'someone-else' });
      await sut.run(operationOf('import'), claimToken);
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'takeout_missing' }),
      );
    });

    it('never runs two jobs on one import', async () => {
      repository.claimRun.mockResolvedValue(false);
      await sut.run(operationOf('import'), claimToken);
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'takeout_busy' }),
      );
      expect(repository.pendingItems).not.toHaveBeenCalled();
    });

    it('finishes at once when the step already completed before the job last stopped', async () => {
      repository.getById.mockResolvedValue(rowOf('completed'));
      await sut.run(operationOf('import'), claimToken);
      expect(operations.complete).toHaveBeenCalled();
      expect(repository.pendingItems).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    it('never records or cleans up a destination whose exclusive creation failed', async () => {
      pending = [[itemOf()]];
      staging.copyToLibrary.mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
      await sut.run(operationOf('import'), claimToken);
      expect(repository.itemCreating).not.toHaveBeenCalled();
      expect(staging.remove).not.toHaveBeenCalled();
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
    });

    it('copies a new photo into the library, applies its metadata and restores its album', async () => {
      pending = [[itemOf()]];

      await sut.run(operationOf('import'), claimToken);

      // The intent is recorded before the upload, so an interrupted upload is finished as this import's.
      expect(repository.itemCreating.mock.invocationCallOrder[0]).toBeLessThan(
        assetMedia.uploadAsset.mock.invocationCallOrder[0],
      );
      expect(staging.copyToLibrary).toHaveBeenCalledWith(
        '/data/takeout/staged/1',
        10,
        expect.stringMatching(/^\/data\/upload\/user-id\/.+\.jpg$/),
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(assetMedia.uploadAsset).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: ownerId }) }),
        expect.objectContaining({ filename: 'IMG_1.jpg', isFavorite: true, visibility: undefined }),
        expect.objectContaining({ originalName: 'IMG_1.jpg', size: 10 }),
      );
      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'created');
      expect(assets.update).toHaveBeenCalledWith(expect.anything(), assetId, {
        description: 'From Google',
        dateTimeOriginal: '2020-01-01T00:00:00.000Z',
        latitude: 1,
        longitude: 2,
        isFavorite: true,
      });
      expect(albums.create).toHaveBeenCalledWith(expect.anything(), { albumName: 'Trip' });
      expect(albums.addAssets).toHaveBeenCalledWith(expect.anything(), 'album-1', { ids: [assetId] });
      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'imported');
      expect(staging.remove).toHaveBeenCalledWith('/data/takeout/staged/1');
      expect(repository.advancePhase).toHaveBeenCalledWith(importId, 'importing', 'completed');
      expect(operations.complete).toHaveBeenCalled();
    });

    it('creates a Locked Folder photo locked, never as a stored locked visibility', async () => {
      pending = [[itemOf({ locked: true, albums: ['Locked Folder'] })]];

      await sut.run(operationOf('import'), claimToken);

      expect(assetMedia.uploadAsset).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ visibility: AssetVisibility.Locked }),
        expect.anything(),
      );
      expect(assets.lock).toHaveBeenCalledWith(expect.anything(), { ids: [assetId] });
      // The Locked Folder is not an album.
      expect(albums.create).not.toHaveBeenCalled();
    });

    it('reuses a photo already in the library, keeps its metadata and still restores its album', async () => {
      pending = [[itemOf()]];
      assetMedia.bulkUploadCheck.mockResolvedValue({
        results: [{ id: 'sha256', assetId, isTrashed: false }, { id: 'sha1' }],
      });
      repository.getAlbumFor.mockResolvedValue('existing-album');

      await sut.run(operationOf('import'), claimToken);

      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'matched');
      expect(assets.update).not.toHaveBeenCalled();
      expect(albums.addAssets).toHaveBeenCalledWith(expect.anything(), 'existing-album', { ids: [assetId] });
      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'matched');
    });

    it('only fills what a matched photo is missing when asked to update matched metadata', async () => {
      repository.getById.mockResolvedValue(rowOf('importing', { updateMatchedMetadata: true }));
      pending = [[itemOf()]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });
      repository.getAssetState.mockResolvedValue(
        assetState({ description: 'Edited by hand', latitude: 5, longitude: 6 }),
      );

      await sut.run(operationOf('import'), claimToken);

      expect(assets.fillMissingMetadata).toHaveBeenCalledWith(expect.anything(), assetId, { isFavorite: true });
      expect(assets.update).not.toHaveBeenCalled();
    });

    it('withholds albums when the guarded metadata read finds the matched photo newly Locked', async () => {
      repository.getById.mockResolvedValue(rowOf('importing', { updateMatchedMetadata: true }));
      pending = [[itemOf()]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });
      assets.fillMissingMetadata.mockResolvedValue(false);

      await sut.run(operationOf('import'), claimToken);

      expect(assets.fillMissingMetadata).toHaveBeenCalledWith(expect.anything(), assetId, {
        description: 'From Google',
        latitude: 1,
        longitude: 2,
        isFavorite: true,
      });
      expect(assets.update).not.toHaveBeenCalled();
      expect(albums.addAssets).not.toHaveBeenCalled();
      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'matched');
    });

    it('finishes an interrupted creation as the import’s own, without a second copy', async () => {
      pending = [[itemOf({ state: 'importing', createPath: assetState().originalPath })]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });

      await sut.run(operationOf('import'), claimToken);

      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'created');
      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'imported');
    });

    it('treats a photo the owner uploaded meanwhile as matched, never as its own creation', async () => {
      pending = [[itemOf({ state: 'importing', createPath: '/data/upload/user-id/aa/bb/abandoned.jpg' })]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });
      repository.getAssetState.mockResolvedValue(assetState({ description: 'Mine' }));

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'matched');
      expect(assets.update).not.toHaveBeenCalled();
    });

    it('removes an earlier run’s abandoned copy before copying again', async () => {
      pending = [[itemOf({ state: 'importing', createPath: '/data/upload/user-id/aa/bb/abandoned.jpg' })]];

      await sut.run(operationOf('import'), claimToken);

      expect(staging.remove).toHaveBeenCalledWith('/data/upload/user-id/aa/bb/abandoned.jpg');
      expect(repository.itemCreating).toHaveBeenCalledWith(itemOf().id, expect.stringMatching(/^\/data\/upload\//));
    });

    it('never removes an earlier copy that an asset uses as its original', async () => {
      pending = [[itemOf({ state: 'importing', createPath: '/data/upload/user-id/aa/bb/kept.jpg' })]];
      repository.isOriginalPath.mockResolvedValue(true);

      await sut.run(operationOf('import'), claimToken);

      expect(staging.remove).not.toHaveBeenCalledWith('/data/upload/user-id/aa/bb/kept.jpg');
    });

    it('removes the orphaned earlier copy when the photo turns out to be elsewhere in the library', async () => {
      pending = [[itemOf({ state: 'importing', createPath: '/data/upload/user-id/aa/bb/abandoned.jpg' })]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'matched');
      expect(staging.remove).toHaveBeenCalledWith('/data/upload/user-id/aa/bb/abandoned.jpg');
    });

    it('counts a photo that arrived between the check and the upload as matched', async () => {
      pending = [[itemOf()]];
      assetMedia.uploadAsset.mockResolvedValue({ id: assetId, status: AssetMediaStatus.DUPLICATE });

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemAsset).toHaveBeenCalledWith(itemOf().id, assetId, 'matched');
      expect(assets.update).not.toHaveBeenCalled();
    });

    it('keeps a Locked Folder photo out of every album, whatever folder it sits in', async () => {
      pending = [[itemOf({ locked: true, albums: ['Trip'] })]];

      await sut.run(operationOf('import'), claimToken);

      expect(assets.lock).toHaveBeenCalledWith(expect.anything(), { ids: [assetId] });
      expect(albums.addAssets).not.toHaveBeenCalled();
    });

    it('leaves a photo that is Locked in the library alone when it is matched', async () => {
      repository.getById.mockResolvedValue(rowOf('importing', { updateMatchedMetadata: true }));
      pending = [[itemOf()]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId }] });
      repository.getAssetState.mockResolvedValue(assetState({ locked: true }));

      await sut.run(operationOf('import'), claimToken);

      expect(assets.update).not.toHaveBeenCalled();
      expect(albums.addAssets).not.toHaveBeenCalled();
      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'matched');
    });

    it('reports a photo that is in the library’s trash instead of importing it again', async () => {
      pending = [[itemOf()]];
      assetMedia.bulkUploadCheck.mockResolvedValue({ results: [{ id: 'sha256', assetId, isTrashed: true }] });

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'failed', expect.stringContaining('trash'));
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
    });

    it('gives failed items one automatic retry before reporting them', async () => {
      pending = [[itemOf()]];
      albums.addAssets.mockResolvedValue([{ id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION }]);
      repository.retryFailed.mockResolvedValue(1);

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'failed', expect.stringContaining('Trip'));
      expect(operations.requeue).toHaveBeenCalledWith(operationId, claimToken, {
        delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
        returnAttempt: true,
      });
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ result: { itemRetryUsed: true } }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('reports what still fails after the automatic retry and finishes', async () => {
      pending = [[itemOf()]];
      albums.addAssets.mockResolvedValue([{ id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION }]);
      repository.retryFailed.mockResolvedValue(1);

      await sut.run(operationOf('import', { itemRetryUsed: true }), claimToken);

      expect(repository.retryFailed).not.toHaveBeenCalled();
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalled();
    });

    it('treats an album membership that already exists as done', async () => {
      pending = [[itemOf()]];
      albums.addAssets.mockResolvedValue([{ id: assetId, success: false, error: BulkIdErrorReason.DUPLICATE }]);

      await sut.run(operationOf('import'), claimToken);

      expect(repository.itemDone).toHaveBeenCalledWith(itemOf().id, 'imported');
    });

    it('stops at a pause and leaves the rest for the resumed job', async () => {
      pending = [[itemOf()]];
      operations.setBulkResult.mockResolvedValue({ ...working, pauseRequestedAt: new Date() });

      await sut.run(operationOf('import'), claimToken);

      expect(operations.settlePause).toHaveBeenCalledWith(operationId, claimToken);
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'rechecks active authority after a failed pause before importing (renewed: %s)',
      async (renewed) => {
        pending = [[itemOf()]];
        operations.setBulkResult.mockResolvedValueOnce({ ...working, pauseRequestedAt: new Date() });
        operations.settlePause.mockResolvedValueOnce(false);
        operations.heartbeat.mockResolvedValue(renewed);

        await sut.run(operationOf('import'), claimToken);

        expect(operations.heartbeat).toHaveBeenCalledWith(operationId, claimToken, expect.any(Number), {
          requireActiveClaim: true,
        });
        if (renewed) {
          expect(assetMedia.uploadAsset).toHaveBeenCalledOnce();
          expect(operations.complete).toHaveBeenCalled();
        } else {
          expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
          expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: false });
          expect(operations.complete).not.toHaveBeenCalled();
          expect(operations.fail).not.toHaveBeenCalled();
        }
      },
    );

    it('acknowledges a cancel at the next progress write', async () => {
      pending = [[itemOf()]];
      operations.setBulkResult.mockResolvedValue({ ...working, cancelRequestedAt: new Date() });

      await sut.run(operationOf('import'), claimToken);

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('links an approved Live Photo once both parts are in the library', async () => {
      repository.countPending.mockResolvedValue(0);
      repository.approvedPairs
        .mockResolvedValueOnce([
          { photoItemId: 'p', videoItemId: 'v', photoAssetId: assetId, videoAssetId: 'video-asset' },
        ])
        .mockResolvedValue([]);

      await sut.run(operationOf('import'), claimToken);

      expect(livePhoto.relinkOne).toHaveBeenCalledWith(expect.anything(), assetId, 'video-asset');
      expect(repository.pairDone).toHaveBeenCalledWith('p', 'v', null);
    });
  });

  describe('scan', () => {
    const source: TakeoutSource = {
      id: '0195e2a0-0000-7000-8000-0000000000c1',
      importId,
      name: 'takeout-001.zip',
      kind: 'zip',
      path: '/data/takeout/owner/import/a.zip',
      size: 100,
      received: 100,
      rejected: 0,
      scanned: false,
    };

    beforeEach(() => {
      repository.getById.mockResolvedValue(rowOf('scanning'));
      repository.sources.mockResolvedValue([source]);
      staging.openArchive.mockResolvedValue({ source: { size: 100, read: vi.fn() }, close: vi.fn() });
      staging.stageArchiveEntry.mockResolvedValue({
        size: 10,
        checksum: Buffer.alloc(32, 2),
        legacyChecksum: Buffer.alloc(20, 2),
      });
    });

    it('stages Google Photos entries under stable ids, refuses unsafe ones and skips the rest', async () => {
      staging.readArchiveDirectory.mockResolvedValue([
        { name: 'Takeout/Google Photos/Trip/IMG_1.jpg', uncompressedSize: 10, modifiedAt: new Date(0) },
        { name: 'Takeout/Google Photos/../../etc/passwd', uncompressedSize: 10, modifiedAt: new Date(0) },
        { name: 'Takeout/Mail/inbox.mbox', uncompressedSize: 10, modifiedAt: new Date(0) },
        {
          name: 'Takeout/Google Photos/Trip/secret.jpg',
          uncompressedSize: 10,
          modifiedAt: new Date(0),
          refused: 'encrypted',
        },
      ]);

      await sut.run(operationOf('scan'), claimToken);

      expect(staging.stageArchiveEntry).toHaveBeenCalledTimes(1);
      expect(repository.recordFile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: takeoutStableId(`${source.id}:Takeout/Google Photos/Trip/IMG_1.jpg`),
          relativePath: 'Trip/IMG_1.jpg',
          folder: 'Trip',
          kind: 'image',
          path: `/data/takeout/owner/import/${takeoutStableId(`${source.id}:Takeout/Google Photos/Trip/IMG_1.jpg`)}`,
        }),
      );
      expect(repository.markSourceScanned).toHaveBeenCalledWith(source.id, 2);
      expect(staging.remove).toHaveBeenCalledWith(source.path);
      expect(repository.advancePhase).toHaveBeenCalledWith(importId, 'scanning', 'review');
      expect(operations.complete).toHaveBeenCalled();
    });

    it('does not stage an entry a previous run already staged', async () => {
      staging.readArchiveDirectory.mockResolvedValue([
        { name: 'Takeout/Google Photos/Trip/IMG_1.jpg', uncompressedSize: 10, modifiedAt: new Date(0) },
      ]);
      repository.hasFile.mockResolvedValue(true);

      await sut.run(operationOf('scan'), claimToken);

      expect(staging.stageArchiveEntry).not.toHaveBeenCalled();
    });

    it('refuses a server folder that is no longer inside a permitted location', async () => {
      repository.sources.mockResolvedValue([
        { ...source, kind: 'directory', path: '/elsewhere/Takeout', size: 0, received: 0 },
      ]);

      await sut.run(operationOf('scan'), claimToken);

      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'takeout_folder_not_permitted' }),
      );
      expect(staging.walk).not.toHaveBeenCalled();
    });

    it('fails the job when the staging volume is full, so the retry resumes once there is space', async () => {
      staging.readArchiveDirectory.mockResolvedValue([
        { name: 'Takeout/Google Photos/Trip/IMG_1.jpg', uncompressedSize: 10, modifiedAt: new Date(0) },
      ]);
      staging.freeBytes.mockResolvedValue(0);

      await sut.run(operationOf('scan'), claimToken);

      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'takeout_no_space' }),
      );
      expect(repository.markSourceScanned).not.toHaveBeenCalled();
    });

    it('matches sidecars across split archives and offers Live Photo pairs', async () => {
      staging.readArchiveDirectory.mockResolvedValue([]);
      repository.folders.mockResolvedValue(['Trip']);
      const file = (id: string, name: string, kind: TakeoutFile['kind'], metadata: TakeoutFile['metadata'] = null) =>
        ({ id, name, kind, metadata, folder: 'Trip', relativePath: `Trip/${name}` }) as TakeoutFile;
      repository.folderFiles.mockResolvedValue([
        file('p', 'IMG_1.HEIC', 'image'),
        file('v', 'IMG_1.MP4', 'video'),
        file('s', 'IMG_1.HEIC.supplemental-metadata.json', 'sidecar', { title: 'IMG_1.HEIC', favorite: true }),
      ]);

      await sut.run(operationOf('scan'), claimToken);

      expect(repository.recordItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'p',
          state: 'ready',
          sidecarId: 's',
          metadata: { title: 'IMG_1.HEIC', favorite: true },
          albums: ['Trip'],
        }),
      );
      // The only photo and video sharing the name: linked without asking.
      expect(repository.recordPair).toHaveBeenCalledWith(importId, 'p', 'v', true);
    });

    it('preserves every ambiguous photo/video combination in a shared scan group', async () => {
      staging.readArchiveDirectory.mockResolvedValue([]);
      repository.folders.mockResolvedValue(['Trip']);
      repository.folderFiles.mockResolvedValue([
        { id: 'p1', name: 'IMG_1.jpg', kind: 'image', metadata: null },
        { id: 'p2', name: 'img_1.heic', kind: 'image', metadata: null },
        { id: 'v1', name: 'IMG_1.mp4', kind: 'video', metadata: null },
        { id: 'v2', name: 'img_1.mov', kind: 'video', metadata: null },
      ]);
      await sut.run(operationOf('scan'), claimToken);
      expect(repository.recordPair.mock.calls).toEqual([
        [importId, 'p1', 'v1', false],
        [importId, 'p1', 'v2', false],
        [importId, 'p2', 'v1', false],
        [importId, 'p2', 'v2', false],
      ]);
    });

    it('keeps invalid sidecar matching case-insensitive and limited to the media filename prefix', async () => {
      staging.readArchiveDirectory.mockResolvedValue([]);
      repository.folders.mockResolvedValue(['Trip']);
      repository.folderFiles.mockResolvedValue([
        { id: 'p', name: 'IMG_1.jpg', kind: 'image', metadata: null },
        { id: 's', name: 'img_1.JPG.json', kind: 'sidecar', metadata: null },
        { id: 'other', name: 'IMG_10.jpg', kind: 'image', metadata: null },
      ]);
      await sut.run(operationOf('scan'), claimToken);
      expect(repository.recordItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'p',
          warnings: expect.arrayContaining(['invalid_sidecar']),
        }),
      );
      expect(repository.recordItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'other',
          warnings: ['no_sidecar'],
        }),
      );
    });
  });
});
