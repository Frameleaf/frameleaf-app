import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetType, ChecksumAlgorithm, JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueExecution } from 'src/queue/types.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { getKyselyDB, getMocks } from 'test/utils.js';

/**
 * FL-1337 Task 11b: a fix that runs as a job of a run (an import, an administrator's Generate thumbnails) changes
 * the photo's file, so its previews must be made again. The run already holds the photo's finished thumbnail job
 * (`job_run_stage`), and would drop the request as done: Library care queues it outside the run.
 */
describe('Library care inside a run', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let jobs: JobRepository;
  let queue: string;
  let workerId: string;
  let root: string;
  let nestedPath: { mockRestore: () => void };
  const assetId = randomUUID();
  const thumbnails = { name: JobName.AssetGenerateThumbnails, data: { id: assetId, source: 'upload' } } as const;

  /** The jobs of this photo still to run, by name, and whether a run holds them. */
  const live = (name: JobName) =>
    db
      .selectFrom('job')
      .select(['runId', 'data'])
      .where('queue', '=', queue)
      .where('name', '=', name)
      .where('state', 'in', ['pending', 'waiting', 'active'])
      .execute();

  /** A job of `runId`, enqueued as the run's own producer would. */
  const asJobOfRun = (runId: string, item: Parameters<JobRepository['queue']>[0]) =>
    store.enqueue([
      queueExecution.run({ claim: { runId, rootItemKey: null }, buffering: false } as unknown as QueueExecution, () =>
        jobs['intent'](item),
      ),
    ]);

  /**
   * An administrator's Generate thumbnails run made this photo's thumbnails, and the job handed the photo to Library
   * care: the run holds the finished thumbnail job, and the fix runs as a job of the same run, claimed for real.
   */
  const fixInRun = async (fix: Record<string, unknown>) => {
    const runId = await store.createRun(queue, {});
    await asJobOfRun(runId, thumbnails);
    await db
      .updateTable('job')
      .set({ state: 'completed', finishedAt: new Date() })
      .where('queue', '=', queue)
      .where('name', '=', JobName.AssetGenerateThumbnails)
      .execute();
    await asJobOfRun(runId, { name: JobName.MediaHealthFixAsset, data: { id: assetId, ...fix } } as never);
    const [claim] = await store.claim(queue, workerId, 1);
    expect(claim).toMatchObject({ name: JobName.MediaHealthFixAsset, runId });
    const execution: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: () => {},
      followups: [],
      adoptions: [],
      buffering: false,
      progressUnits: 0,
    };
    return { runId, claim, execution };
  };

  const setup = () => {
    const mocks = getMocks();
    const asset = {
      id: assetId,
      ownerId: 'user-id',
      updateId: 'update-1',
      checksum: Buffer.alloc(20, 1),
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      originalPath: join(root, 'IMG_2041.jpg'),
      originalFileName: 'IMG_2041.jpg',
      type: AssetType.Image,
      isExternal: false,
      libraryId: null,
      deletedAt: null,
      previewPath: join(root, 'preview.jpg'),
      thumbnailPath: join(root, 'thumbnail.webp'),
    };
    const repository = {
      clearProcessingFailures: vi.fn().mockResolvedValue(undefined),
      getAssets: vi.fn().mockResolvedValue([asset]),
      getAssetChecksums: vi.fn().mockResolvedValue([]),
      getFindingsForAsset: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([]),
      getCandidatesByHealthIds: vi.fn().mockResolvedValue([]),
      createRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      upsertFinding: vi.fn().mockImplementation((input) => Promise.resolve({ ...input, id: 'health-1' })),
      replaceRepairedOriginal: vi.fn().mockResolvedValue(true),
      setRetainedPath: vi.fn().mockResolvedValue(undefined),
      isOriginalPathInUse: vi.fn().mockResolvedValue(false),
      appendSteps: vi.fn().mockResolvedValue(undefined),
      settleFinding: vi.fn().mockResolvedValue(true),
      listSteps: vi.fn().mockResolvedValue([]),
    };
    const integrity = { validate: vi.fn() };
    const operations = new SharpOperations();
    const crypto = new CryptoRepository();
    vi.mocked(mocks.media.repairJpeg).mockImplementation((input, output, preview, metadataSource) =>
      operations.repairJpeg(input, output, preview, metadataSource),
    );
    vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((file) => crypto.hashFileDigests(file));
    vi.mocked(mocks.crypto.hashFileMatching).mockImplementation((file, reference) =>
      crypto.hashFileMatching(file, reference),
    );
    vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
    vi.mocked(mocks.storage.stat).mockImplementation((file) => stat(file) as never);
    vi.mocked(mocks.storage.mkdtemp).mockImplementation((prefix) => mkdtemp(join(root, prefix)));
    vi.mocked(mocks.storage.unlinkDir).mockImplementation((folder, options) => rm(folder, options));
    vi.mocked(mocks.library.getAll).mockResolvedValue([]);
    vi.mocked(mocks.session.getByUserId).mockResolvedValue([]);
    const sut = new MediaHealthService(
      mocks.logger as never,
      mocks.asset as never,
      mocks.crypto as never,
      mocks.event as never,
      mocks.forkSchema as never,
      jobs,
      mocks.library as never,
      repository as unknown as MediaHealthRepository,
      mocks.media as never,
      mocks.physicalFile as never,
      mocks.storage as never,
      mocks.user as never,
      integrity as never,
      { getEnv: () => ({ storage: { ignoreMountCheckErrors: false, recoveryRoots: [] } }) } as never,
      {} as never,
      {} as never,
      mocks.cron as never,
      mocks.database as never,
      mocks.systemMetadata as never,
      { restoreLostOriginal: vi.fn().mockResolvedValue({ outcome: 'not-in-backup' }) } as never,
      mocks.session as never,
    );
    return { sut, asset, repository, integrity };
  };

  /** A JPEG whose end was cut off: it won't open, and a repair keeps most of its rows. */
  const cutShort = async (file: string) => {
    const values = Buffer.alloc(320 * 240 * 3);
    let seed = 7;
    for (let index = 0; index < values.length; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      values[index] = seed >>> 24;
    }
    const good = await sharp(values, { raw: { width: 320, height: 240, channels: 3 } })
      .jpeg()
      .toBuffer();
    const bytes = good.subarray(0, Math.floor(good.length * 0.7));
    await writeFile(file, bytes);
    return createHash('sha1').update(bytes).digest();
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    clearConfigCache();
    queue = `library-care-${randomUUID()}`;
    workerId = randomUUID();
    await store.initialize([queue], workerId);
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    for (const name of [
      JobName.AssetGenerateThumbnails,
      JobName.SidecarCheck,
      JobName.MediaHealthFixAsset,
      JobName.MediaHealthLocateMissing,
    ]) {
      jobs['handlers'][name] = { queueName: queue as QueueName } as never;
    }
    root = await mkdtemp(join(tmpdir(), 'library-care-run-'));
    nestedPath = vi
      .spyOn(StorageCore, 'getNestedPath')
      .mockReturnValue(join(root, 'upload', 'user-id', 'as', 'se', assetId));
  });

  afterEach(async () => {
    nestedPath.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it('gets a photo it repaired its previews made again, which the run itself would drop', async () => {
    const { sut, asset, repository, integrity } = setup();
    asset.checksum = await cutShort(asset.originalPath);
    integrity.validate.mockResolvedValue({
      status: 'corrupt',
      reason: 'decode_failed',
      message: 'VipsJpeg: Premature end of JPEG file',
    });
    const { execution, claim } = await fixInRun({ from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' });

    // as a job of the run, a request for this photo's thumbnails is dropped: the run already made them
    await queueExecution.run(execution, () => jobs.queue(thumbnails));
    await expect(live(JobName.AssetGenerateThumbnails)).resolves.toEqual([]);

    await expect(queueExecution.run(execution, () => sut.handleFixAsset(claim.data as never))).resolves.toBe(
      JobStatus.Success,
    );

    // the photo was repaired: its file changed
    expect(repository.replaceRepairedOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ assetId, expectedOriginalPath: asset.originalPath }),
    );
    // so its previews are made again from the repaired file, as work of their own outside the run
    await expect(live(JobName.AssetGenerateThumbnails)).resolves.toEqual([
      { runId: null, data: { id: assetId, source: 'upload' } },
    ]);
    // while its details are read again as work of the run, so an import's metadata rules still apply to it
    await expect(live(JobName.SidecarCheck)).resolves.toEqual([
      { runId: claim.runId, data: { id: assetId, source: 'upload' } },
    ]);
  });

  it('gets a photo whose preview failed but whose file opens its previews made again (F1)', async () => {
    const { sut, asset, repository, integrity } = setup();
    await writeFile(asset.originalPath, 'a photo that opens');
    asset.checksum = createHash('sha1').update('a photo that opens').digest();
    integrity.validate.mockResolvedValue({ status: 'healthy' });
    const { execution, claim } = await fixInRun({ from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' });

    await expect(queueExecution.run(execution, () => sut.handleFixAsset(claim.data as never))).resolves.toBe(
      JobStatus.Skipped,
    );

    // nothing was wrong with it: no problem is recorded, and its previews are made as a job of their own
    expect(repository.upsertFinding).not.toHaveBeenCalled();
    await expect(live(JobName.AssetGenerateThumbnails)).resolves.toEqual([
      { runId: null, data: { id: assetId, source: 'upload', afterCare: true } },
    ]);
  });
});
