import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetFileType, AssetType, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
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

describe(AssetJobRepository.name, () => {
  it('backfills only uninspected non-RAW images through the existing metadata selection', async () => {
    const { ctx, sut } = setup(await getKyselyDB());
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
    const { ctx, sut } = setup(await getKyselyDB());
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

  it('resumes a frozen HDR backfill in bounded pages without changing originals, SDR files or motion links', async () => {
    const db = await getKyselyDB();
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
      await store.initialize([queue], worker);
      const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
      repository['handlers'][JobName.AssetGenerateThumbnails] = {
        queueName: queue as QueueName,
        jobName: JobName.AssetGenerateThumbnails,
        label: 'HDR backfill fixture',
        handler: vi.fn(),
      };
      await store.enqueue([
        { queue, name: 'enumerate-hdr', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000 },
      ]);
      const [first] = await store.claim(queue, worker);
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
      await freeze(first);
      expect(await store.feedManifest(queue)).toBe(0);
      // Simulate the durable evidence a stopped worker leaves, then recover through a fresh coordinator.
      await recordStoppedAttempt(db, first.id, first.token);
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${first.id}::uuid`.execute(db);
      const resumed = new SqlQueueStore(db);
      await resumed.recoverExpired();
      await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
      const replacementWorker = randomUUID();
      await resumed.initialize([queue], replacementWorker);
      const [retry] = await resumed.claim(queue, replacementWorker);
      expect(retry.attempt).toBe(2);
      expect(retry.runId).toBe(first.runId);
      const later = await addSource();
      await freeze(retry);
      expect(await resumed.complete(first, [])).toBe(false);
      expect(await resumed.complete(retry, [])).toBe(true);
      expect(await resumed.feedManifest(queue)).toBe(250);
      expect(await new SqlQueueStore(db).feedManifest(queue)).toBe(1);
      expect(await resumed.feedManifest(queue)).toBe(0);
      const jobs = await db
        .selectFrom('job')
        .select('data')
        .where('queue', '=', queue)
        .where('name', '=', JobName.AssetGenerateThumbnails)
        .execute();
      expect(jobs).toHaveLength(ids.length);
      expect(new Set(jobs.map(({ data }) => data.id))).toEqual(new Set(ids));
      expect(await originalFiles()).toEqual(filesBefore);
      expect((await originalState()).filter(({ id }) => id !== later)).toEqual(before);
    } finally {
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
