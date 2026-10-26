import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus, QueueName, SystemMetadataKey } from 'src/enum.js';
import { IdenticalFilesService } from 'src/services/identical-files.service.js';

/** FL-413 run control; the stages themselves are proved with real files in the medium spec. */
const setup = (state: Record<string, unknown> | null) => {
  let saved = state;
  const repository = {
    countOriginals: vi.fn().mockResolvedValue(3),
    getOriginals: vi.fn().mockResolvedValue([]),
    getSharedContents: vi.fn().mockResolvedValue([]),
    getLibraryContents: vi.fn().mockResolvedValue([]),
    getExternalImportPaths: vi.fn().mockResolvedValue([]),
    getKnownPaths: vi.fn().mockResolvedValue(new Set()),
    getOwners: vi.fn().mockResolvedValue([]),
    listRecentChanges: vi.fn().mockResolvedValue([]),
  };
  const jobs = {
    queue: vi.fn(),
    isPaused: vi.fn().mockResolvedValue(false),
    hasDedupJob: vi.fn().mockResolvedValue(false),
  };
  const metadata = {
    get: vi.fn((key: SystemMetadataKey) => Promise.resolve(key === SystemMetadataKey.IdenticalFiles ? saved : null)),
    set: vi.fn((_key: SystemMetadataKey, value: Record<string, unknown>) => {
      saved = structuredClone(value);
      return Promise.resolve();
    }),
  };
  const storage = {
    // eslint-disable-next-line require-yield
    walkWithCursor: vi.fn(function* (cursor: unknown[]) {
      cursor.length = 0;
    }),
  };
  const sut = new IdenticalFilesService(
    { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() } as never,
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { withLock: (_: unknown, callback: () => Promise<unknown>) => callback() } as never,
    {} as never,
    jobs as never,
    {} as never,
    {} as never,
    storage as never,
    metadata as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { sut, jobs, metadata, repository, saved: () => saved };
};

const auth = { user: { id: 'admin' } } as never;

beforeAll(() => {
  StorageCore.setMediaLocation('/data');
});

describe(IdenticalFilesService.name, () => {
  it('lists the newest links for the "Merged for you" history (FL-416)', async () => {
    const { sut, repository } = setup(null);
    repository.listRecentChanges.mockResolvedValue([
      {
        id: 'change-1',
        assetId: 'asset-1',
        originalFileName: 'VID_0311.MOV',
        ownerId: 'morgan',
        ownerName: 'Morgan',
        keptAssetId: 'asset-0',
        keptOwnerName: 'Taylor',
        sizeInBytes: 412,
        createdAt: new Date('2026-10-22T03:40:00.000Z'),
        undoneAt: null,
        restorable: true,
      },
      {
        id: 'change-2',
        assetId: 'asset-2',
        originalFileName: 'IMG_2040.HEIC',
        ownerId: 'emma',
        ownerName: 'Emma',
        keptAssetId: null,
        keptOwnerName: null,
        sizeInBytes: 8,
        createdAt: new Date('2026-10-21T03:40:00.000Z'),
        undoneAt: new Date('2026-10-22T09:00:00.000Z'),
        restorable: true,
      },
    ]);
    const changes = await sut.getRecentChanges(20);
    expect(repository.listRecentChanges).toHaveBeenCalledWith(20);
    expect(changes).toEqual([
      expect.objectContaining({ id: 'change-1', ownerName: 'Morgan', keptOwnerName: 'Taylor', restorable: true }),
      // an undone link is never restorable again
      expect.objectContaining({ id: 'change-2', undoneAt: '2026-10-22T09:00:00.000Z', restorable: false }),
    ]);
    expect(changes[0].createdAt).toBe('2026-10-22T03:40:00.000Z');
  });

  it('reports a server that was never checked', async () => {
    const { sut } = setup(null);
    await expect(sut.getStatus()).resolves.toMatchObject({ status: 'never-run', stage: null, problems: [] });
  });

  it('starts a fresh run on "Check again", keeping the Recovered Media albums', async () => {
    const { sut, jobs, saved } = setup({ status: 'completed', recoveredAlbums: { owner: 'album' } });
    await sut.check(auth);
    expect(saved()).toMatchObject({
      status: 'running',
      stage: 'scan',
      cursor: null,
      trigger: 'manual',
      requestedBy: 'admin',
      totalOriginals: 3,
      recoveredAlbums: { owner: 'album' },
    });
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
  });

  it('lets a run in progress carry on instead of starting again', async () => {
    const { sut, jobs, saved } = setup({ status: 'running', stage: 'link', cursor: 'abc', runId: 'run' });
    jobs.hasDedupJob.mockResolvedValue(true);
    await sut.check(auth);
    expect(saved()).toMatchObject({ runId: 'run', stage: 'link', cursor: 'abc' });
    expect(jobs.hasDedupJob).toHaveBeenCalledWith(QueueName.StorageTemplateMigration, JobName.IdenticalFilesCheck);
    expect(jobs.queue).not.toHaveBeenCalled();
  });

  it('queues a run in progress again when its job stopped with the worker', async () => {
    const { sut, jobs } = setup({ status: 'running', stage: 'link', cursor: 'abc', runId: 'run' });
    await sut.check(auth);
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
  });

  it('never starts a run from a resume job whose run has finished', async () => {
    const { sut, metadata } = setup({ status: 'completed' });
    await expect(sut.handleCheck({ resume: true })).resolves.toBe(JobStatus.Skipped);
    expect(metadata.set).not.toHaveBeenCalled();
  });

  it('works through every stage to the report', async () => {
    const { sut, saved } = setup(null);
    await expect(sut.handleCheck()).resolves.toBe(JobStatus.Success);
    expect(saved()).toMatchObject({ status: 'completed', stage: 'done', finishedAt: expect.any(String) });
  });

  it('stops between batches while a library move pauses the storage queue', async () => {
    const { sut, jobs, saved, repository } = setup({
      status: 'running',
      stage: 'scan',
      cursor: null,
      walk: null,
      counts: {},
      problems: [],
    });
    jobs.isPaused.mockResolvedValue(true);
    await expect(sut.handleCheck({ resume: true })).resolves.toBe(JobStatus.Success);
    expect(repository.getOriginals).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ status: 'running', stage: 'scan' });
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
  });

  it('records a failure and keeps the cursor for the retry', async () => {
    const { sut, saved, repository } = setup({
      status: 'running',
      stage: 'scan',
      cursor: 'last-done',
      walk: null,
      counts: { problems: 0 },
      problems: [],
    });
    repository.getOriginals.mockRejectedValue(new Error('database went away'));
    await expect(sut.handleCheck({ resume: true })).rejects.toThrow('database went away');
    expect(saved()).toMatchObject({
      status: 'running',
      cursor: 'last-done',
      problems: [{ kind: 'failed', detail: 'database went away' }],
    });
  });

  it('starts an Immich import its own run, whatever ran before (FL-414)', async () => {
    const { sut, saved } = setup({
      status: 'running',
      stage: 'link',
      cursor: 'abc',
      runId: 'manual',
      recoveredAlbums: {},
    });
    await expect(sut.handleCheck({ importRunId: 'import-run' })).resolves.toBe(JobStatus.Success);
    expect(saved()).toMatchObject({ trigger: 'immich-import', importRunId: 'import-run', status: 'completed' });
    expect(saved()?.runId).not.toBe('manual');
  });

  it('changes nothing when the import item is retried after its run finished (FL-414)', async () => {
    const { sut, metadata } = setup({ status: 'completed', importRunId: 'import-run' });
    await expect(sut.handleCheck({ importRunId: 'import-run' })).resolves.toBe(JobStatus.Skipped);
    expect(metadata.set).not.toHaveBeenCalled();
  });

  it('skips the retired per-account jobs', async () => {
    const { sut } = setup(null);
    await expect(sut.handleRetiredDryRun()).resolves.toBe(JobStatus.Skipped);
    await expect(sut.handleRetiredApply()).resolves.toBe(JobStatus.Skipped);
  });
});
