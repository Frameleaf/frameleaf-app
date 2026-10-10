import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import { AssetType, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueExecution } from 'src/queue/types.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('motion metadata publication owns its encode follow-up', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const prepare = async () => {
    const user = await seedCanonicalUser(db);
    const asset = await seedCanonicalAsset(db, {
      ownerId: user.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
    });
    const { sut, ctx } = newMediumService(MetadataService, {
      database: db,
      real: [AssetRepository, AssetJobRepository, ConfigRepository, SystemMetadataRepository, TagRepository],
      mock: [
        EventRepository,
        JobRepository,
        LoggingRepository,
        MapRepository,
        MediaRepository,
        MetadataRepository,
        StorageRepository,
      ],
    });
    ctx.getMock(MetadataRepository).readTags.mockResolvedValue({});
    ctx.getMock(MediaRepository).probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
    ctx.getMock(MediaRepository).probePackets.mockResolvedValue({
      totalDuration: 0,
      packetCount: 0,
      outputFrames: 0,
      keyframePts: [],
      keyframeAccDuration: [],
      keyframeOwnDuration: [],
    });
    ctx.getMock(StorageRepository).stat.mockResolvedValue({ size: 100, mtime: new Date(0) } as Stats);
    const store = new SqlQueueStore(db);
    const metadataQueue = `motion-metadata-${randomUUID()}`;
    const encodeQueue = `motion-encode-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([metadataQueue, encodeQueue], worker);
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    for (const name of [JobName.AssetExtractMetadata, JobName.AssetMetadataPostprocess, JobName.AssetEncodeVideo]) {
      jobs['handlers'][name] = {
        queueName: (name === JobName.AssetEncodeVideo ? encodeQueue : metadataQueue) as QueueName,
      } as never;
    }
    ctx.getMock(JobRepository).queue.mockImplementation((item) => jobs.queue(item));
    const data = { id: asset.id, source: 'motion-photo' as const };
    const runId = await jobs.createRun('motion', {}, () => jobs.queue({ name: JobName.AssetExtractMetadata, data }));
    const [claim] = await store.claim(metadataQueue, worker);
    expect(claim.data).toEqual(data);
    const stage = async () => {
      const context: QueueExecution = {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        buffering: false,
        adoptions: [],
        followups: [],
      };
      await queueExecution.run(context, () => sut.handleMetadataExtraction(data));
      return () =>
        store.complete(claim, context.followups, (tx) =>
          publicationTransaction.run(tx, () =>
            queueExecution.run(context, async () => {
              context.buffering = true;
              for (const adopt of context.adoptions) await adopt(tx);
            }),
          ),
        );
    };
    const claimEncode = () => store.claim(encodeQueue, worker);
    const video = () => ctx.get(AssetJobRepository).getForVideoConversion(asset.id);
    const metadata = () => db.selectFrom('asset_exif').select('assetId').where('assetId', '=', asset.id).execute();
    return { asset, store, claim, stage, claimEncode, video, metadata, runId };
  };

  it('publishes one encode with accepted metadata and preserves the same run through completion replay', async () => {
    const f = await prepare();
    const commit = await f.stage();
    expect(await f.metadata()).toEqual([]);
    expect(await f.video()).toBeUndefined();
    expect(await f.claimEncode()).toEqual([]);
    expect(await commit()).toBe(true);
    expect(await f.video()).toMatchObject({ id: f.asset.id });
    expect(await commit()).toBe(false);
    const encodes = await f.claimEncode();
    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toMatchObject({
      name: JobName.AssetEncodeVideo,
      runId: f.runId,
      itemKey: f.asset.id,
      attempt: 1,
    });
    expect(
      await db.selectFrom('job').select('parentId').where('id', '=', encodes[0].id).executeTakeFirstOrThrow(),
    ).toEqual({ parentId: f.claim.id });
    const rows = await db.selectFrom('job_run_item').select(['stage', 'state']).where('runId', '=', f.runId).execute();
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { stage: JobName.AssetExtractMetadata, state: 'completed' },
        { stage: JobName.AssetEncodeVideo, state: 'active' },
        { stage: JobName.AssetMetadataPostprocess, state: 'pending' },
      ]),
    );
  });

  it('rolls metadata and child admission back together, then reuses the same parent on re-preparation', async () => {
    const f = await prepare();
    const commit = await f.stage();
    const enqueue = f.store.enqueue.bind(f.store);
    const fault = vi.spyOn(f.store, 'enqueue').mockImplementationOnce(async (intents, tx) => {
      await enqueue(intents, tx);
      await sql`select 1 / 0`.execute(tx!);
    });
    try {
      await expect(commit()).rejects.toThrow(/division by zero/);
    } finally {
      fault.mockRestore();
    }
    expect(await f.metadata()).toEqual([]);
    expect(await f.video()).toBeUndefined();
    expect(await f.claimEncode()).toEqual([]);
    const retryPublication = await f.stage();
    expect(await retryPublication()).toBe(true);
    expect(await retryPublication()).toBe(false);
    const encodes = await f.claimEncode();
    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toMatchObject({ runId: f.runId, itemKey: f.asset.id, attempt: 1 });
  });

  it('publishes neither metadata nor encoding after the parent lease expires', async () => {
    const f = await prepare();
    const commit = await f.stage();
    await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${f.claim.id}::uuid`.execute(db);
    expect(await commit()).toBe(false);
    expect(await f.metadata()).toEqual([]);
    expect(await f.claimEncode()).toEqual([]);
  });
});
