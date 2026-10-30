import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import { MediumTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('removed items’ queued work (FL-683)', () => {
  let db: Kysely<any>;
  let jobs: JobRepository;
  let store: SqlQueueStore;
  let workerId: string;
  const queues = [
    QueueName.SmartSearch,
    QueueName.FaceDetection,
    QueueName.FacialRecognition,
    QueueName.Ocr,
    QueueName.BackgroundTask,
  ];

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    workerId = randomUUID();
    await store.initialize(queues, workerId);
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    jobs['handlers'][JobName.SmartSearch] = { queueName: QueueName.SmartSearch } as never;
    jobs['handlers'][JobName.AssetDetectFaces] = { queueName: QueueName.FaceDetection } as never;
    jobs['handlers'][JobName.Ocr] = { queueName: QueueName.Ocr } as never;
    jobs['handlers'][JobName.FacialRecognition] = { queueName: QueueName.FacialRecognition } as never;
    jobs['handlers'][JobName.AssetDelete] = { queueName: QueueName.BackgroundTask } as never;
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('cancels the waiting smart search, face and text jobs of removed items, and only theirs', async () => {
    const ctx = new MediumTestContext(AssetService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    const [gone, kept] = [asset.id, randomUUID()];
    await jobs.queueAll([
      { name: JobName.FacialRecognition, data: { id: assetFace.id } },
      { name: JobName.SmartSearch, data: { id: gone } },
      { name: JobName.AssetDetectFaces, data: { id: gone } },
      { name: JobName.Ocr, data: { id: gone } },
      { name: JobName.SmartSearch, data: { id: kept } },
      { name: JobName.AssetDelete, data: { id: gone, deleteOnDisk: false } },
    ]);
    const before = await db.selectFrom('job').select(['id', 'queue', 'data']).where('queue', 'in', queues).execute();
    const idOf = (queue: string, assetId: string) =>
      before.find((row) => row.queue === queue && row.data.id === assetId)!.id;

    await jobs.cancelAssetJobs([gone]);

    const after = await db.selectFrom('job').select(['id', 'state']).where('queue', 'in', queues).execute();
    const stateOf = (id: string) => after.find((row) => row.id === id)!.state;
    expect(stateOf(idOf(QueueName.SmartSearch, gone))).toBe('cancelled');
    expect(stateOf(idOf(QueueName.FaceDetection, gone))).toBe('cancelled');
    expect(stateOf(idOf(QueueName.Ocr, gone))).toBe('cancelled');
    expect(stateOf(idOf(QueueName.FacialRecognition, assetFace.id!))).toBe('cancelled');
    // another item's work, and the removal itself, still run
    expect(stateOf(idOf(QueueName.SmartSearch, kept))).not.toBe('cancelled');
    expect(stateOf(idOf(QueueName.BackgroundTask, gone))).not.toBe('cancelled');
  });

  it('knows which staging claims are proven stopped', async () => {
    await jobs.queue({ name: JobName.Ocr, data: { id: randomUUID() } });
    const [claim] = await store.claim(QueueName.Ocr, workerId, 1);
    const claims = [
      { jobId: claim.id, token: claim.token },
      { jobId: randomUUID(), token: randomUUID() },
    ];

    // a running attempt, and one with no record, may still be writing
    expect([...(await jobs.getStoppedClaims(claims))]).toEqual([]);

    await store.complete(claim, []);
    expect([...(await jobs.getStoppedClaims(claims))]).toEqual([`${claim.id}/${claim.token}`]);
  });
});
