import { Kysely, sql } from 'kysely';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  AssetFileType,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  PhysicalFileType,
  QueueName,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const consume = async <T>(generator: AsyncIterableIterator<T>) => {
  const values: T[] = await Array.fromAsync(generator);

  return values;
};

let defaultDatabase: Kysely<DB>;

// Tests that assert over whole tables use their own database; destroy its pool when the test ends.
const isolatedDatabase = async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  return db;
};

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetJobRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterAll(async () => {
  await defaultDatabase?.destroy();
});

describe(AssetJobRepository.name, () => {
  it('counts what each reading feature has read and the copies beside the originals (FL-521)', async () => {
    const { ctx, sut } = setup(await isolatedDatabase());
    const { user } = await ctx.newUser();
    const { asset: read } = await ctx.newAsset({ ownerId: user.id });
    const { asset: unread } = await ctx.newAsset({ ownerId: user.id });
    const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 90_000 });
    const { asset: noPreview } = await ctx.newAsset({ ownerId: user.id });
    for (const asset of [read, unread, video, noPreview]) {
      await ctx.newJobStatus({ assetId: asset.id });
    }
    await sql`update "asset_job_status" set
      "facesRecognizedAt" = case when "assetId" = ${read.id} then now() else null end,
      "ocrAt" = case when "assetId" = ${read.id} then now() else null end`.execute(ctx.database);
    for (const asset of [read, unread, video]) {
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/p/${asset.id}.jpg` });
    }
    await ctx.newAssetFile({ assetId: video.id, type: AssetFileType.EncodedVideo, path: `/v/${video.id}.mp4` });
    const embedding = `[${Array.from({ length: 768 }, () => 0.01).join(',')}]`;
    await sql`insert into "smart_search" ("assetId", "embedding") values (${read.id}, ${embedding})`.execute(
      ctx.database,
    );
    await sql`insert into "asset_metadata" ("assetId", "key", "value")
      values (${read.id}, 'ml-enrichment', jsonb_build_object('description', jsonb_build_object('status', 'success')))
      on conflict ("assetId", "key") do update set "value" = excluded."value"`.execute(ctx.database);

    await expect(sut.countFeatureProgress()).resolves.toEqual({
      search: [1, 3],
      faces: [1, 3],
      text: [1, 2],
      captions: [1, 3],
      locked: [0, 2],
    });
    await expect(sut.countMediaCopies()).resolves.toEqual({
      photos: 3,
      withoutPreview: 1,
      videos: 1,
      withCopy: 1,
      // FL-537: how long the videos are, for "about N MB a minute"
      videoMs: 90_000,
      copyMs: 90_000,
      // FL-630: a copy with no recorded file has no size yet
      copyBytes: 0,
      unsizedCopies: 1,
    });

    // FL-630: once the copy's file is recorded, its size is the space copies take, counted once
    // however many copies share the file (here the edited copy of the same video)
    await ctx.newAssetFile({
      assetId: video.id,
      type: AssetFileType.EncodedVideo,
      path: `/v/${video.id}.mp4`,
      isEdited: true,
    });
    await sql`insert into "physical_file" ("type", "checksum", "sizeInBytes", "path", "canonicalAssetId")
      values (${PhysicalFileType.EncodedVideo}, ${Buffer.from('copy')}, 5000, ${`/v/${video.id}.mp4`}, ${video.id})`.execute(
      ctx.database,
    );
    await sql`update "asset_file" f set "physicalFileId" = p.id from "physical_file" p
      where p.path = f.path and f."assetId" = ${video.id}`.execute(ctx.database);
    await expect(sut.countMediaCopies()).resolves.toEqual(
      expect.objectContaining({ withCopy: 1, copyBytes: 5000, unsizedCopies: 0 }),
    );
  });

  it('finds missing outputs while skipping live jobs, offline and trashed originals, and deliberate playback skips', async () => {
    const db = await isolatedDatabase();
    const { ctx, sut } = setup(db);
    const { user } = await ctx.newUser();
    const make = async (options: Parameters<typeof ctx.newAsset>[0] = {}) =>
      (await ctx.newAsset({ ownerId: user.id, ...options })).asset;
    const metadata = await make();
    const pending = await make();
    const offline = await make({ isOffline: true });
    const trashed = await make({ status: AssetStatus.Trashed });
    const thumbnail = await make();
    const ml = await make({ thumbhash: Buffer.from('test') });
    const video = await make({ type: AssetType.Video });
    const playable = await make({ type: AssetType.Video });
    for (const asset of [thumbnail, ml, video, playable]) {
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date(), facesRecognizedAt: null });
    }
    await ctx.get(AssetRepository).upsertJobStatus({
      assetId: playable.id,
      transcodeSkippedFor: `${playable.checksum.toString('hex')}:current-policy`,
    });
    for (const type of [AssetFileType.Thumbnail, AssetFileType.Preview]) {
      await ctx.newAssetFile({ assetId: ml.id, type, path: `/test/${type}.jpg` });
    }

    const store = new SqlQueueStore(db);
    await store.enqueue([
      {
        queue: QueueName.MetadataExtraction,
        name: JobName.AssetExtractMetadata,
        data: { id: pending.id.toUpperCase() },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 30_000,
      },
    ]);
    const queues = {
      [JobName.AssetExtractMetadata]: QueueName.MetadataExtraction,
      [JobName.AssetGenerateThumbnails]: QueueName.ThumbnailGeneration,
      [JobName.AssetEncodeVideo]: QueueName.VideoConversion,
      [JobName.SmartSearch]: QueueName.SmartSearch,
      [JobName.AssetDetectFaces]: QueueName.FaceDetection,
      [JobName.Ocr]: QueueName.Ocr,
    } as const;
    const ids = async (name: keyof typeof queues, videoPolicy = 'current-policy') => {
      const rows = await sut
        .selectionForUnfinished(name, { queue: queues[name], fullsizeEnabled: false, videoPolicy })
        .execute();
      return rows.map(({ id }) => id).sort();
    };

    await expect(ids(JobName.AssetExtractMetadata)).resolves.toEqual([metadata.id]);
    await expect(ids(JobName.AssetGenerateThumbnails)).resolves.toEqual([thumbnail.id, video.id, playable.id].sort());
    for (const name of [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr] as const) {
      await expect(ids(name)).resolves.toEqual([ml.id]);
    }
    await expect(ids(JobName.AssetEncodeVideo)).resolves.toEqual([video.id]);
    await expect(ids(JobName.AssetEncodeVideo, 'changed-policy')).resolves.toEqual([video.id, playable.id].sort());
    // This status is independent of the legacy trash timestamp.
    expect(trashed.status).toBe(AssetStatus.Trashed);
    expect(offline.isOffline).toBe(true);
  });

  it('backfills only uninspected non-RAW images through the existing metadata selection', async () => {
    const { ctx, sut } = setup(await isolatedDatabase());
    const { user } = await ctx.newUser();
    const assets = [];
    for (const options of [
      { originalFileName: 'old.HEIC' },
      { originalFileName: 'old.JPG' },
      { originalFileName: 'capture.CR2' },
      { originalFileName: 'motion.MOV', type: AssetType.Video },
      { originalFileName: 'inspected.heic' },
      { originalFileName: 'failed.heic' },
      { originalFileName: 'trashed.heic', deletedAt: new Date() },
    ]) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, ...options });
      assets.push(asset);
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
    }
    for (const index of [4, 5]) {
      await ctx.newExif({
        assetId: assets[index].id,
        imageEncoding: {
          dynamicRange: 'unknown',
          gainMap: 'none',
          reconstructionAvailable: false,
          inspectionStatus: index === 4 ? 'identified' : 'failed',
        },
      });
    }
    const ids = assets.map(({ id }) => id);
    expect(await sut.selectionForMetadataExtraction(false).where('asset.id', 'in', ids).execute()).toEqual([]);
    expect(await sut.selectionForMetadataExtraction(false, true).where('asset.id', 'in', ids).execute()).toEqual(
      expect.arrayContaining(ids.slice(0, 2).map((id) => ({ id }))),
    );
    expect(
      await sut.selectionForMetadataExtraction(false, true).where('asset.id', 'in', ids.slice(2)).execute(),
    ).toEqual([]);
  });

  it('backfills missing original HDR renditions without selecting edited, hidden, SDR or complete sources', async () => {
    const { ctx, sut } = setup(await isolatedDatabase());
    const { user } = await ctx.newUser();
    const assets = [];
    for (const options of [{}, {}, { isEdited: true }, { visibility: AssetVisibility.Hidden }, {}]) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('hash'), ...options });
      assets.push(asset);
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newExif({
        assetId: asset.id,
        imageEncoding: {
          dynamicRange: assets.length === 5 ? 'sdr' : 'hdr',
          gainMap: 'ultra-hdr',
          reconstructionAvailable: true,
        },
      });
      for (const type of [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize]) {
        await ctx.newAssetFile({ assetId: asset.id, type, path: `${asset.id}-${type}.jpg`, isEdited: asset.isEdited });
      }
    }
    for (const type of [AssetFileType.HdrPreview, AssetFileType.HdrFullSize]) {
      await ctx.newAssetFile({ assetId: assets[1].id, type, path: `${assets[1].id}-${type}.jpg` });
    }
    const ids = assets.map(({ id }) => id);
    expect(
      await sut
        .selectionForThumbnailJob({ force: false, fullsizeEnabled: false })
        .where('asset.id', 'in', ids)
        .execute(),
    ).toEqual([]);
    expect(
      await sut
        .selectionForThumbnailJob({ force: false, fullsizeEnabled: false, hdrBackfill: true })
        .where('asset.id', 'in', ids)
        .execute(),
    ).toEqual([{ id: assets[0].id, isEdited: false }]);
  });

  it('backfills full-size images for upper-case file extensions too', async () => {
    const { ctx, sut } = setup(await isolatedDatabase());
    const { user } = await ctx.newUser();
    const ids: string[] = [];
    for (const originalFileName of ['IMG_0001.HEIC', 'photo.MOS', 'IMG_0002.JPG']) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName, thumbhash: Buffer.from('hash') });
      ids.push(asset.id);
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newExif({ assetId: asset.id, make: 'Camera' });
      for (const type of [AssetFileType.Thumbnail, AssetFileType.Preview]) {
        await ctx.newAssetFile({ assetId: asset.id, type, path: `${asset.id}-${type}.jpg` });
      }
    }
    const selected = await sut
      .selectionForThumbnailJob({ force: false, fullsizeEnabled: true })
      .where('asset.id', 'in', ids)
      .execute();
    expect(selected.map(({ id }) => id).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it('resumes a frozen HDR backfill in bounded pages without changing originals, SDR files or motion links', async () => {
    const db = await getKyselyDB();
    let child: ChildProcess | undefined;
    try {
      const { ctx, sut } = setup(db);
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const addSource = async (isEdited = false) => {
        const { asset } = await ctx.newAsset({
          ownerId: user.id,
          originalFileName: 'original.HEIC',
          thumbhash: Buffer.from('hash'),
          livePhotoVideoId: motion.id,
          isEdited,
        });
        await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
        await ctx.newExif({
          assetId: asset.id,
          imageEncoding: { dynamicRange: 'hdr', gainMap: 'iso-21496', reconstructionAvailable: true },
        });
        for (const type of [AssetFileType.Thumbnail, AssetFileType.Preview]) {
          await ctx.newAssetFile({ assetId: asset.id, type, path: `${asset.id}-${type}.jpg`, isEdited });
        }
        return asset.id;
      };
      const ids: string[] = [];
      for (let i = 0; i < 251; i++) ids.push(await addSource());
      await addSource(true);
      const originalState = () =>
        db.selectFrom('asset').selectAll().where('ownerId', '=', user.id).orderBy('id').execute();
      const originalFiles = () =>
        db.selectFrom('asset_file').selectAll().where('assetId', 'in', ids).orderBy('id').execute();
      const before = await originalState();
      const filesBefore = await originalFiles();
      const queue = `hdr-backfill-${randomUUID()}`;
      const worker = randomUUID();
      const store = new SqlQueueStore(db);

      const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
      repository['handlers'][JobName.AssetGenerateThumbnails] = {
        queueName: queue as QueueName,
        jobName: JobName.AssetGenerateThumbnails,
        label: 'HDR backfill fixture',
        handler: vi.fn(),
      };
      const [{ name }] = (await sql<{ name: string }>`select current_database() as name`.execute(db)).rows;
      const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
      url.pathname = name;
      child = fork(new URL('../../../fixtures/hdr-backfill-worker.ts', import.meta.url), [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--import', 'tsx'],
      });
      const response = new Promise<{ claim: QueueClaim }>((resolve, reject) => {
        child!.once('message', (value: { claim?: QueueClaim; error?: string }) =>
          value.claim ? resolve({ claim: value.claim }) : reject(new Error(value.error)),
        );
        child!.once('error', reject);
        child!.once('exit', () => reject(new Error('HDR backfill fixture exited before freezing')));
      });
      child.send({ url: url.href, queue, worker, ownerId: user.id });
      const { claim: first } = await response;
      const freeze = (claim: QueueClaim) =>
        queueExecution.run(
          {
            claim,
            signal: new AbortController().signal,
            progress: vi.fn(),
            progressUnits: 0,
            adoptions: [],
            followups: [],
            buffering: false,
          },
          () =>
            repository.queueSelection(
              JobName.AssetGenerateThumbnails,
              sut
                .selectionForThumbnailJob({ force: false, fullsizeEnabled: false, hdrBackfill: true })
                .where('asset.ownerId', '=', user.id)
                .where('asset.isEdited', '=', false),
            ),
        );
      // FL-1265: the selection is inserted as jobs at once, its page cursor saved with the producer
      const selected = () =>
        db
          .selectFrom('job')
          .select('data')
          .where('queue', '=', queue)
          .where('name', '=', JobName.AssetGenerateThumbnails)
          .execute();
      expect(await selected()).toHaveLength(ids.length);
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${first.id}::uuid`.execute(db);
      await store.recoverExpired();
      expect(await store.claim(queue, worker)).toEqual([]);
      const closed = once(child, 'close');
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toEqual([null, 'SIGKILL']);
      expect(() => process.kill(child!.pid!, 0)).toThrow();
      // Stop proof is written only after observing the real worker's terminal process state.
      await recordStoppedAttempt(db, first.id, first.token);
      const resumed = new SqlQueueStore(db);
      await resumed.recoverExpired();
      // Ahead of the selected thumbnails, which are already queued (FL-1265)
      await sql`update job set "availableAt" = now() - interval '1 day' where id = ${first.id}::uuid`.execute(db);
      const replacementWorker = randomUUID();
      await resumed.initialize([queue], replacementWorker);
      const [retry] = await resumed.claim(queue, replacementWorker);
      expect(retry.attempt).toBe(2);
      expect(retry.runId).toBe(first.runId);
      const later = await addSource();
      await freeze(retry);
      expect(await resumed.complete(first, [])).toBe(false);
      expect(await resumed.complete(retry, [])).toBe(true);
      // The retried producer's saved cursor says the selection is done: the later asset is not added.
      const jobs = await selected();
      expect(jobs).toHaveLength(ids.length);
      expect(new Set(jobs.map(({ data }) => data.id))).toEqual(new Set(ids));
      expect(await originalFiles()).toEqual(filesBefore);
      expect((await originalState()).filter(({ id }) => id !== later)).toEqual(before);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      await db.destroy();
    }
  }, 60_000);

  describe('streamForThumbnailJob', () => {
    it('should work', async () => {
      const { sut } = setup();
      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('should queue an asset with missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should skip assets without missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should queue assets with a missing full size', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.cr2',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with after they have full size previews', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.FullSize, path: 'fullsize.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with web-compatible originals', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.jpg',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });
  });

  describe('getForOcr', () => {
    it('should not return the edited preview file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getForOcr(asset.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewFile: 'preview_unedited.jpg',
        }),
      );
    });
  });
});
