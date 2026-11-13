import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueExecution } from 'src/queue/types.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Recognition as the worker runs it: inside a queue claim, published in the claim's completion
 * transaction with the real job repository. The other face tests call the handler outside a claim.
 */
describe('face recognition inside a queue claim', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const setup = async (embedded: boolean) => {
    const { sut, ctx } = newMediumService(PersonService, {
      database: db,
      real: [
        AccessRepository,
        AssetJobRepository,
        AssetRepository,
        ConfigRepository,
        CryptoRepository,
        DatabaseRepository,
        PartnerOriginRepository,
        PersonRepository,
        SearchRepository,
        SystemMetadataRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository, StorageRepository],
    });
    ctx.getMock(EventRepository).emit.mockResolvedValue();

    const { user } = await ctx.newUser();
    const embedding = newEmbedding();
    const faces: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
      if (embedded) {
        await db.insertInto('face_search').values({ faceId: assetFace.id, embedding }).execute();
      }
      faces.push(assetFace.id);
    }

    // Each run has its own queues, and follow-up work has a queue of its own, so the claims below are this run's faces.
    const queue = `face-recognition-${randomUUID()}` as QueueName;
    const followups = `face-followups-${randomUUID()}` as QueueName;
    const store = new SqlQueueStore(db);
    const worker = randomUUID();
    await store.initialize([queue, followups], worker);
    await store.setConcurrency(queue, 10);
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    for (const name of [JobName.FacialRecognition, JobName.PersonGenerateThumbnail, JobName.PartnerPropagate]) {
      jobs['handlers'][name] = { queueName: name === JobName.FacialRecognition ? queue : followups } as never;
    }
    const mock = ctx.getMock(JobRepository);
    mock.queue.mockImplementation((item) => jobs.queue(item));
    mock.queueAll.mockImplementation((items) => jobs.queueAll(items));
    mock.queueOutsideRun.mockImplementation((items) => jobs.queueOutsideRun(items));

    /** Claims and runs one face's job; the returned `complete` publishes it in the claim's completion transaction. */
    const start = async (faceId: string) => {
      const data = { id: faceId, deferred: false };
      // A run of its own, so completions never wait on a shared run row and the race below is real.
      await jobs.createRun('faces', {}, () => jobs.queue({ name: JobName.FacialRecognition, data }));
      const [claim] = await store.claim(queue, worker, 1);
      expect(claim).toMatchObject({ name: JobName.FacialRecognition, data });
      const context: QueueExecution = {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        buffering: false,
        adoptions: [],
        followups: [],
      };
      await queueExecution.run(context, () => sut.handleRecognizeFaces(data));
      return () =>
        queueExecution.run(context, () =>
          store.complete(claim, context.followups, (tx) =>
            publicationTransaction.run(tx, async () => {
              context.buffering = true;
              for (const adopt of context.adoptions) await adopt(tx);
            }),
          ),
        );
    };
    const personOf = async (faceId: string) => {
      const face = await db
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faceId)
        .executeTakeFirstOrThrow();
      return face.personGroupId;
    };
    return { start, personOf, faces, user };
  };

  const recognise = async (embedded: boolean) => {
    const { start, personOf, faces } = await setup(embedded);
    const settled = await (await start(faces[0]))();
    return { settled, personGroupId: await personOf(faces[0]) };
  };

  it('gives a face its person when the claim completes', async () => {
    const { settled, personGroupId } = await recognise(true);
    expect(settled).toBe(true);
    expect(personGroupId).not.toBeNull();
  });

  // An imported face has no embedding until detection finds it again; that is nothing to recognise yet, not a failure.
  it('completes without a person for a face that has no embedding yet', async () => {
    const { settled, personGroupId } = await recognise(false);
    expect(settled).toBe(true);
    expect(personGroupId).toBeNull();
  });

  // Recognising people runs several faces at once; two faces of one new person must not each start a person of their own.
  it('gives two faces of one new person the same person when they are recognised at the same time', async () => {
    const { start, personOf, faces, user } = await setup(true);
    const [first, second] = [await start(faces[0]), await start(faces[1])];
    expect(await Promise.all([first(), second()])).toEqual([true, true]);

    const [a, b] = [await personOf(faces[0]), await personOf(faces[1])];
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    const people = await db.selectFrom('person').select('personGroupId').where('ownerId', '=', user.id).execute();
    expect(people).toEqual([{ personGroupId: a }]);
  });
});
