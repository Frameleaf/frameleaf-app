import {
  DatabaseLock,
  JobName,
  JobStatus,
  MediaHealthCategory,
  MediaHealthStatus,
  SystemMetadataKey,
} from 'src/enum.js';
import { StorageMigrationService } from 'src/services/storage-migration.service.js';
import {
  StorageMigrationState,
  createStorageMigrationState,
  storageMigrationStatus,
} from 'src/utils/storage-migration.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checksum = Buffer.from('aa'.repeat(20), 'hex');

type Row = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName: string;
  checksum: Buffer;
  sizeInBytes: number;
  isExternal: boolean;
  libraryId: string | null;
  isOffline: boolean;
  deletedAt: null;
  status: string;
  physicalOriginalFileId: string | null;
};

const asset = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  ownerId: 'owner-1',
  originalPath: `/data/upload/owner-1/${id}.jpg`,
  originalFileName: `${id}.jpg`,
  checksum,
  sizeInBytes: 10,
  isExternal: false,
  libraryId: null,
  isOffline: false,
  deletedAt: null,
  status: 'active',
  physicalOriginalFileId: null,
  ...overrides,
});

const at = new Date('2026-10-03T12:00:00.000Z');

const setup = () => {
  let stored: StorageMigrationState | null = null;
  const mocks = {
    logger: { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    databaseRepository: { withLock: vi.fn((_lock: DatabaseLock, work: () => Promise<unknown>) => work()) },
    jobRepository: { queue: vi.fn() },
    mediaHealthRepository: {
      createRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      finishRun: vi.fn(),
      upsertFinding: vi.fn().mockResolvedValue({}),
      getRunFindingPage: vi.fn().mockResolvedValue([]),
    },
    physicalFileRepository: { getPlanEvidence: vi.fn().mockResolvedValue([]) },
    storageMigrationRepository: {
      countAssets: vi.fn().mockResolvedValue(0),
      getAssetPage: vi.fn().mockResolvedValue([]),
      getGroupSources: vi.fn().mockResolvedValue([]),
      countDuplicateGroups: vi.fn().mockResolvedValue(0),
      getDuplicateGroupPage: vi.fn().mockResolvedValue([]),
      countUnreferencedOriginals: vi.fn().mockResolvedValue(0),
      getUnreferencedOriginalPage: vi.fn().mockResolvedValue([]),
    },
    storageRepository: {
      checkFileExists: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue({ size: 10 }),
    },
    systemMetadataRepository: {
      get: vi.fn((key: SystemMetadataKey) => {
        expect(key).toBe(SystemMetadataKey.UniversalStorageMigration);
        return Promise.resolve(stored ? structuredClone(stored) : null);
      }),
      set: vi.fn((_key: SystemMetadataKey, value: StorageMigrationState) => {
        stored = structuredClone(value);
        return Promise.resolve();
      }),
    },
    mediaHealthService: {
      locateForStorageMigration: vi.fn().mockResolvedValue({ checkedAssets: 0, foundAssets: 0 }),
      relinkForStorageMigration: vi.fn().mockResolvedValue('review'),
    },
    deduplication: { linkToPrimary: vi.fn().mockResolvedValue({ state: 'linked', copyMissing: false }) },
    fileTrash: { trashOriginal: vi.fn() },
    eventRepository: { emit: vi.fn() },
  };
  const service = new StorageMigrationService(
    mocks.logger as never,
    mocks.databaseRepository as never,
    mocks.jobRepository as never,
    mocks.mediaHealthRepository as never,
    mocks.physicalFileRepository as never,
    mocks.storageMigrationRepository as never,
    mocks.storageRepository as never,
    mocks.systemMetadataRepository as never,
    mocks.mediaHealthService as never,
    mocks.deduplication as never,
    mocks.fileTrash as never,
    mocks.eventRepository as never,
  );
  return {
    service,
    mocks,
    state: () => stored,
    setState: (value: Partial<StorageMigrationState>) => {
      stored = { ...createStorageMigrationState({ total: 10, now: at }), ...value };
    },
  };
};

describe(StorageMigrationService.name, () => {
  let sut: ReturnType<typeof setup>;

  beforeEach(() => {
    sut = setup();
  });

  describe('onBootstrap', () => {
    it('marks a library without assets done and queues nothing (fresh install)', async () => {
      await sut.service.onBootstrap();
      expect(sut.state()).toMatchObject({ stage: 'done', required: false });
      expect(sut.mocks.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('starts a library with assets and queues the first batch', async () => {
      sut.mocks.storageMigrationRepository.countAssets.mockResolvedValue(3);
      await sut.service.onBootstrap();
      expect(sut.state()).toMatchObject({ stage: 'checking', total: 3, required: true });
      expect(sut.mocks.jobRepository.queue).toHaveBeenCalledWith({ name: JobName.UniversalStorageMigration, data: {} });
    });

    it('resumes an unfinished migration without starting it again', async () => {
      sut.setState({ stage: 'linking', cursor: 'aa:10', groupsLinked: 5, groupsTotal: 9 });
      await sut.service.onBootstrap();
      expect(sut.state()).toMatchObject({ stage: 'linking', cursor: 'aa:10', groupsLinked: 5 });
      expect(sut.mocks.jobRepository.queue).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleBatch', () => {
    it('runs a batch under the migration lock and queues the next one', async () => {
      sut.setState({});
      await expect(sut.service.handleBatch()).resolves.toBe(JobStatus.Success);
      expect(sut.mocks.databaseRepository.withLock).toHaveBeenCalledWith(
        DatabaseLock.UniversalStorageMigration,
        expect.any(Function),
      );
      expect(sut.mocks.jobRepository.queue).toHaveBeenCalledWith({ name: JobName.UniversalStorageMigration, data: {} });
      expect(sut.mocks.eventRepository.emit).not.toHaveBeenCalled();
    });

    it('announces the finished migration so existing partnerships are copied', async () => {
      sut.setState({ stage: 'done' });
      await expect(sut.service.handleBatch()).resolves.toBe(JobStatus.Success);
      expect(sut.mocks.eventRepository.emit).toHaveBeenCalledWith('StorageMigrationDone');
      expect(sut.mocks.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('keeps the checkpoint when a batch fails, records the error and retries later', async () => {
      sut.setState({ checked: 500, cursor: 'asset-500' });
      sut.mocks.storageMigrationRepository.getAssetPage.mockRejectedValue(new Error('disk went away'));
      await expect(sut.service.handleBatch()).resolves.toBe(JobStatus.Failed);
      expect(sut.state()).toMatchObject({ checked: 500, cursor: 'asset-500', error: 'disk went away' });
      expect(sut.mocks.jobRepository.queue).toHaveBeenCalledWith({
        name: JobName.UniversalStorageMigration,
        data: { delay: 300_000 },
      });
    });
  });

  describe('checking files', () => {
    it('records a missing original as a Missing finding of the migration run', async () => {
      sut.setState({});
      sut.mocks.storageMigrationRepository.getAssetPage.mockResolvedValue([asset('a1'), asset('a2')]);
      sut.mocks.storageRepository.checkFileExists.mockImplementation((path: string) =>
        Promise.resolve(!path.includes('a2')),
      );
      await sut.service.runBatch(() => at);
      expect(sut.mocks.mediaHealthRepository.upsertFinding).toHaveBeenCalledTimes(1);
      expect(sut.mocks.mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          assetId: 'a2',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
        }),
      );
      expect(sut.state()).toMatchObject({ runId: 'run-1', cursor: 'a2', checked: 2, relinkTotal: 1 });
    });

    it('records an external original that is missing too, for review', async () => {
      sut.setState({});
      sut.mocks.storageMigrationRepository.getAssetPage.mockResolvedValue([
        asset('ext', { isExternal: true, libraryId: 'library-1' }),
      ]);
      sut.mocks.storageRepository.checkFileExists.mockResolvedValue(false);
      await sut.service.runBatch(() => at);
      expect(sut.mocks.mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'ext', status: MediaHealthStatus.Missing }),
      );
    });

    it('skips and lists a file that cannot be verified', async () => {
      sut.setState({});
      sut.mocks.storageMigrationRepository.getAssetPage.mockResolvedValue([asset('a1'), asset('a2')]);
      sut.mocks.storageRepository.stat.mockImplementation((path: string) =>
        path.includes('a1') ? Promise.resolve({ size: 9 }) : Promise.reject(new Error('EACCES')),
      );
      await sut.service.runBatch(() => at);
      expect(sut.state()).toMatchObject({ skipped: 2, skippedAssetIds: ['a1', 'a2'] });
    });

    it('moves on to relinking once every asset was checked', async () => {
      sut.setState({ checked: 10, runId: 'run-1', cursor: 'a10' });
      await sut.service.runBatch(() => at);
      expect(sut.state()).toMatchObject({ stage: 'relinking', relinkPhase: 'in-group', cursor: null });
    });
  });

  describe('relinking missing files', () => {
    const relinking = { stage: 'relinking' as const, runId: 'run-1', relinkTotal: 2 };

    it('relinks a missing original to a verified copy in its own group', async () => {
      sut.setState(relinking);
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        { id: 'f1', assetId: 'missing', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      sut.mocks.physicalFileRepository.getPlanEvidence
        .mockResolvedValueOnce([asset('missing')])
        .mockResolvedValueOnce([asset('missing', { originalPath: '/data/upload/owner-2/source.jpg' })]);
      sut.mocks.storageMigrationRepository.getGroupSources.mockResolvedValue([asset('source')]);

      await sut.service.runBatch(() => at);

      expect(sut.mocks.mediaHealthRepository.getRunFindingPage).toHaveBeenCalledWith(
        expect.objectContaining({ managedOnly: true, statuses: [MediaHealthStatus.Missing] }),
      );
      expect(sut.mocks.deduplication.linkToPrimary).toHaveBeenCalledWith('missing', 'source', expect.any(Map));
      expect(sut.mocks.mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'missing',
          status: MediaHealthStatus.Relinked,
          originalPath: '/data/upload/owner-2/source.jpg',
          resolution: expect.objectContaining({ automatic: true, sourceAssetId: 'source' }),
        }),
      );
      expect(sut.state()).toMatchObject({ relinked: 1, relinkDone: 1, cursor: 'f1' });
    });

    it('tries the next copy when the first is not on disk either', async () => {
      sut.setState(relinking);
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        { id: 'f1', assetId: 'missing', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      sut.mocks.physicalFileRepository.getPlanEvidence.mockResolvedValue([asset('missing')]);
      sut.mocks.storageMigrationRepository.getGroupSources.mockResolvedValue([asset('gone'), asset('there')]);
      sut.mocks.deduplication.linkToPrimary
        .mockResolvedValueOnce({ state: 'skipped', reason: 'primary-missing' })
        .mockResolvedValueOnce({ state: 'linked', copyMissing: true });

      await sut.service.runBatch(() => at);

      expect(sut.mocks.deduplication.linkToPrimary).toHaveBeenLastCalledWith('missing', 'there', expect.any(Map));
      expect(sut.state()).toMatchObject({ relinked: 1 });
    });

    it('leaves a missing original without a verified copy for the search', async () => {
      sut.setState(relinking);
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        { id: 'f1', assetId: 'missing', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      sut.mocks.physicalFileRepository.getPlanEvidence.mockResolvedValue([asset('missing')]);
      sut.mocks.storageMigrationRepository.getGroupSources.mockResolvedValue([asset('bad')]);
      sut.mocks.deduplication.linkToPrimary.mockResolvedValue({ state: 'skipped', reason: 'primary-mismatch' });

      await sut.service.runBatch(() => at);

      expect(sut.mocks.mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(sut.state()).toMatchObject({ relinked: 0, relinkDone: 0, cursor: 'f1' });
    });

    it('never relinks an external original from library storage', async () => {
      sut.setState(relinking);
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        { id: 'f1', assetId: 'ext', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      sut.mocks.physicalFileRepository.getPlanEvidence.mockResolvedValue([
        asset('ext', { isExternal: true, libraryId: 'library-1' }),
      ]);
      await sut.service.runBatch(() => at);
      expect(sut.mocks.storageMigrationRepository.getGroupSources).not.toHaveBeenCalled();
      expect(sut.mocks.deduplication.linkToPrimary).not.toHaveBeenCalled();
    });

    it('searches library storage for every finding still missing and keeps an unfinished walk', async () => {
      sut.setState({ ...relinking, relinkPhase: 'search' });
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        { id: 'f1', assetId: 'm1', status: MediaHealthStatus.Missing, resolution: null },
        { id: 'f2', assetId: 'm2', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      const continuation = { cursor: [{ path: '/data/upload' }], matches: {} };
      sut.mocks.mediaHealthService.locateForStorageMigration.mockResolvedValue({
        checkedAssets: 2,
        foundAssets: 0,
        continuation,
      });

      await sut.service.runBatch(() => at);
      expect(sut.mocks.mediaHealthService.locateForStorageMigration).toHaveBeenCalledWith({
        runId: 'run-1',
        findingIds: ['f1', 'f2'],
        managedSearch: null,
      });
      expect(sut.state()).toMatchObject({ relinkPhase: 'search', managedSearch: continuation });

      sut.mocks.mediaHealthService.locateForStorageMigration.mockResolvedValue({ checkedAssets: 2, foundAssets: 1 });
      await sut.service.runBatch(() => at);
      expect(sut.mocks.mediaHealthService.locateForStorageMigration).toHaveBeenLastCalledWith(
        expect.objectContaining({ managedSearch: continuation }),
      );
      expect(sut.state()).toMatchObject({ relinkPhase: 'apply', managedSearch: null, cursor: null });
    });

    it('relinks a single verified match and leaves the rest for review', async () => {
      sut.setState({ ...relinking, relinkTotal: 4, relinked: 1, relinkDone: 1, relinkPhase: 'apply' });
      sut.mocks.mediaHealthRepository.getRunFindingPage.mockResolvedValue([
        {
          id: 'in-group',
          assetId: 'a0',
          status: MediaHealthStatus.Relinked,
          resolution: { method: 'universal-storage-group-copy' },
        },
        { id: 'one-match', assetId: 'a1', status: MediaHealthStatus.Found, resolution: { autoRelinkable: true } },
        { id: 'two-matches', assetId: 'a2', status: MediaHealthStatus.Found, resolution: { autoRelinkable: false } },
        { id: 'external', assetId: 'a3', status: MediaHealthStatus.Missing, resolution: null },
      ]);
      sut.mocks.mediaHealthService.relinkForStorageMigration.mockImplementation((id: string) =>
        Promise.resolve(id === 'one-match' ? 'relinked' : 'review'),
      );

      await sut.service.runBatch(() => at);

      expect(sut.mocks.mediaHealthService.relinkForStorageMigration).not.toHaveBeenCalledWith('in-group');
      expect(sut.state()).toMatchObject({ relinked: 2, toReview: 2, relinkDone: 4 });
    });

    it('finishes the run and moves on to linking with the group count', async () => {
      sut.setState({ ...relinking, relinkPhase: 'apply', relinkDone: 2 });
      sut.mocks.storageMigrationRepository.countDuplicateGroups.mockResolvedValue(7);
      await sut.service.runBatch(() => at);
      expect(sut.mocks.mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed' }),
      );
      expect(sut.state()).toMatchObject({ stage: 'linking', groupsTotal: 7, cursor: null });
      expect(storageMigrationStatus(sut.state()!).stages.relinking).toEqual({ done: 2, total: 2 });
    });
  });

  describe('linking duplicate groups', () => {
    const group = (key: string, assetIds: string[]) => ({ key, checksum, sizeInBytes: 10, assetIds });

    it('links every copy to the oldest asset, one primary per group', async () => {
      sut.setState({ stage: 'linking', groupsTotal: 1 });
      sut.mocks.storageMigrationRepository.getDuplicateGroupPage.mockResolvedValue([
        group('aa:10', ['oldest', 'copy-1', 'copy-2']),
      ]);
      await sut.service.runBatch(() => at);
      expect(sut.mocks.deduplication.linkToPrimary.mock.calls.map(([copy, primary]) => [copy, primary])).toEqual([
        ['copy-1', 'oldest'],
        ['copy-2', 'oldest'],
      ]);
      expect(sut.state()).toMatchObject({ groupsLinked: 1, cursor: 'aa:10' });
    });

    it('uses the next asset when the oldest does not verify, and lists the unverifiable ones', async () => {
      sut.setState({ stage: 'linking', groupsTotal: 1 });
      sut.mocks.storageMigrationRepository.getDuplicateGroupPage.mockResolvedValue([
        group('aa:10', ['damaged', 'good', 'other', 'changed-copy']),
      ]);
      sut.mocks.deduplication.linkToPrimary.mockImplementation((copy: string, primary: string) => {
        if (primary === 'damaged') {
          return Promise.resolve({ state: 'skipped', reason: 'primary-mismatch' });
        }
        if (copy === 'changed-copy') {
          return Promise.resolve({ state: 'skipped', reason: 'copy-mismatch' });
        }
        return Promise.resolve({ state: 'linked', copyMissing: false });
      });

      await sut.service.runBatch(() => at);

      expect(sut.mocks.deduplication.linkToPrimary.mock.calls.map(([copy, primary]) => [copy, primary])).toEqual([
        ['good', 'damaged'],
        ['other', 'good'],
        ['changed-copy', 'good'],
      ]);
      expect(sut.state()!.skippedAssetIds).toEqual(['damaged', 'changed-copy']);
    });

    it('moves on to the file trash with the count of unreferenced originals', async () => {
      sut.setState({ stage: 'linking', groupsTotal: 1, groupsLinked: 1, cursor: 'aa:10' });
      sut.mocks.storageMigrationRepository.countUnreferencedOriginals.mockResolvedValue(3);
      await sut.service.runBatch(() => at);
      expect(sut.state()).toMatchObject({ stage: 'trashing', trashTotal: 3, cursor: null });
    });
  });

  describe('moving extra copies to the file trash', () => {
    const file = (id: string, sizeInBytes = 100) => ({
      id,
      path: `/data/upload/owner-2/${id}.jpg`,
      checksum,
      sizeInBytes,
      lastOwnerId: 'owner-2',
      lastAssetId: `asset-${id}`,
      originalFileName: null,
    });

    it('trashes each unreferenced original, never unlinks, and counts only what moved', async () => {
      sut.setState({ stage: 'trashing', trashTotal: 3 });
      sut.mocks.storageMigrationRepository.getUnreferencedOriginalPage.mockResolvedValue([
        file('p1'),
        file('p2'),
        file('p3'),
      ]);
      sut.mocks.fileTrash.trashOriginal
        .mockResolvedValueOnce({ status: 'trashed' })
        .mockResolvedValueOnce({ status: 'referenced', references: 1 })
        .mockResolvedValueOnce({ status: 'missing' });

      await sut.service.runBatch(() => at);

      expect(sut.mocks.fileTrash.trashOriginal).toHaveBeenCalledWith({
        physicalFileId: 'p1',
        path: '/data/upload/owner-2/p1.jpg',
        checksum,
        sizeInBytes: 100,
        lastOwnerId: 'owner-2',
        lastAssetId: `asset-p1`,
        originalFileName: 'p1.jpg',
      });
      expect(sut.state()).toMatchObject({ trashed: 3, bytesFreed: 100, cursor: 'p3' });
    });

    it('finishes once nothing is left', async () => {
      sut.setState({ stage: 'trashing', trashTotal: 3, trashed: 3, cursor: 'p3' });
      await sut.service.runBatch(() => at);
      expect(sut.state()).toMatchObject({ stage: 'done', finishedAt: at.toISOString() });
      expect(storageMigrationStatus(sut.state()!).showInGettingReady).toBe(false);
    });
  });

  describe('Review Focus 5: interrupted mid-batch, then resumed', () => {
    it('neither links nor trashes twice, and the totals never go back', async () => {
      sut.setState({ stage: 'linking', groupsTotal: 2, groupsLinked: 0 });
      const groups = [
        { key: 'aa:10', checksum, sizeInBytes: 10, assetIds: ['p1', 'c1'] },
        { key: 'bb:10', checksum, sizeInBytes: 10, assetIds: ['p2', 'c2'] },
      ];
      sut.mocks.storageMigrationRepository.getDuplicateGroupPage.mockResolvedValue(groups);
      const linked = new Set<string>();
      let crash = true;
      sut.mocks.deduplication.linkToPrimary.mockImplementation((copy: string) => {
        if (copy === 'c2' && crash) {
          crash = false;
          return Promise.reject(new Error('server restarted'));
        }
        if (linked.has(copy)) {
          return Promise.resolve({ state: 'already-linked' });
        }
        linked.add(copy);
        return Promise.resolve({ state: 'linked', copyMissing: false });
      });

      await expect(sut.service.runBatch(() => at)).rejects.toThrow('server restarted');
      // nothing was checkpointed: the batch is done again from its start
      expect(sut.state()).toMatchObject({ groupsLinked: 0, cursor: null });

      await sut.service.runBatch(() => at);
      expect([...linked]).toEqual(['c1', 'c2']);
      expect(sut.state()).toMatchObject({ groupsLinked: 2, groupsTotal: 2, cursor: 'bb:10' });

      // the trash stage: a file moved before the interruption is no longer listed, so it is not moved again
      sut.setState({ ...sut.state()!, stage: 'trashing', cursor: null, trashTotal: 2, trashed: 0 });
      sut.mocks.storageMigrationRepository.getUnreferencedOriginalPage.mockResolvedValue([
        {
          id: 'f2',
          path: '/x/f2.jpg',
          sizeInBytes: 5,
          lastOwnerId: null,
          lastAssetId: null,
          originalFileName: 'f2.jpg',
        },
      ]);
      sut.mocks.fileTrash.trashOriginal.mockResolvedValue({ status: 'trashed' });
      await sut.service.runBatch(() => at);
      expect(sut.mocks.fileTrash.trashOriginal).toHaveBeenCalledTimes(1);
      sut.mocks.storageMigrationRepository.getUnreferencedOriginalPage.mockResolvedValue([]);
      await sut.service.runBatch(() => at);
      expect(sut.state()).toMatchObject({ stage: 'done', groupsLinked: 2 });
      const status = storageMigrationStatus(sut.state()!);
      expect(status.stages.trashing.done).toBe(status.stages.trashing.total);
    });
  });

  describe('runInBackground', () => {
    it('stops Getting Ready waiting while the migration carries on', async () => {
      sut.setState({ stage: 'linking' });
      const status = await sut.service.runInBackground();
      expect(status).toMatchObject({ background: true, showInGettingReady: false, stage: 'linking' });
      expect(sut.state()).toMatchObject({ background: true });
    });
  });
});
