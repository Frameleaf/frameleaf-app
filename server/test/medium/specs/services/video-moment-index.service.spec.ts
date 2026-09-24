import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { defaults } from 'src/config.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetType,
  AssetVisibility,
  EnrichmentItemState,
  VideoMomentIndexState,
  VideoMomentMatch,
  VideoMomentSource,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import { VIDEO_MOMENT_FRAME_COUNT, sourceFingerprint } from 'src/utils/enrichment-plan.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

/**
 * FL-59: the moment index against a real database. ffmpeg, the model and the file system are
 * mocked; the fingerprint guards, the generated/manual split and the Locked scope are real SQL.
 */
let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});
afterAll(async () => database?.destroy());

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });

  const media = automock(MediaRepository, { args: [{ setContext: () => {} }] });
  media.transcode.mockResolvedValue();
  media.scoreThumbnailCandidate.mockResolvedValue(50);
  media.getImageMetadata.mockResolvedValue({ width: 1280, height: 720 } as never);
  const storage = automock(StorageRepository, { args: [{ setContext: () => {} }] });
  storage.mkdirSync.mockReturnValue();
  storage.unlink.mockResolvedValue();

  const machineLearning = automock(MachineLearningRepository, { args: [{ setContext: () => {} }] });
  machineLearning.probe.mockResolvedValue(mlProbeStub.healthy);
  machineLearning.getRunPodEndpoint.mockReturnValue(null);
  machineLearning.encodeImage.mockImplementation(() => Promise.resolve(newEmbedding()));

  // Library workloads are routed to a healthy local destination, as in the unit tests (FL-110). The
  // index records the destination's id in a uuid column, so this one has a real id.
  const destination = { ...mlDestinationStub.local, id: factory.uuid() };
  const mlDestinations = automock(MlDestinationRepository);
  mlDestinations.getRoute.mockImplementation((workload) =>
    Promise.resolve({ workload, destinationId: destination.id, updatedAt: new Date() }),
  );
  mlDestinations.getById.mockResolvedValue(destination);
  mlDestinations.getSpend.mockResolvedValue(0);
  mlDestinations.recordProbe.mockResolvedValue();
  mlDestinations.recordAccounting.mockResolvedValue();

  const moments = ctx.get(VideoMomentRepository);
  const sut = new VideoMomentIndexService(
    ctx.getMock(LoggingRepository),
    ctx.get(AccessRepository),
    moments,
    media,
    storage,
    machineLearning,
    mlDestinations,
    ctx.get(PersonRepository),
    ctx.get(ConfigRepository),
    ctx.get(SystemMetadataRepository),
  );

  const newOwner = async () => {
    const { user } = await ctx.newUser();
    return { user, auth: factory.auth({ user: { id: user.id } }) };
  };

  /** A 70-second video with the stream and format rows the frame cutter reads. */
  const newVideo = async (ownerId: string, visibility = AssetVisibility.Timeline) => {
    const { asset } = await ctx.newAsset({
      ownerId,
      type: AssetType.Video,
      originalPath: `/library/${factory.uuid()}.mp4`,
      duration: 70_000,
      visibility,
    });
    await ctx.newExif({ assetId: asset.id, exifImageWidth: 1920, exifImageHeight: 1080, fps: 30 });
    await database
      .insertInto('asset_video')
      .values({
        assetId: asset.id,
        bitrate: 8_000_000,
        frameCount: 2100,
        timeBase: 15_360,
        index: 0,
        profile: 100,
        level: 40,
        colorPrimaries: 1,
        colorTransfer: 1,
        colorMatrix: 1,
        codecName: 'h264',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        formatLongName: 'QuickTime / MOV',
        pixelFormat: 'yuv420p',
      })
      .execute();
    return asset;
  };

  /** The original is replaced on disk: a new checksum and modification time, so a new fingerprint. */
  const replaceOriginal = async (assetId: string) => {
    await database
      .updateTable('asset')
      .set({ checksum: randomBytes(32), fileModifiedAt: new Date(Date.now() + 60_000) })
      .where('id', '=', assetId)
      .execute();
  };

  const fingerprintOf = async (assetId: string) => {
    const row = await database
      .selectFrom('asset')
      .select(['checksum', 'fileModifiedAt'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    return sourceFingerprint(row as Parameters<typeof sourceFingerprint>[0]);
  };

  const framesOf = (assetId: string) =>
    database.selectFrom('video_moment_frame').selectAll().where('assetId', '=', assetId).execute();
  const embeddingsOf = (assetId: string) =>
    database
      .selectFrom('video_moment_frame_embedding')
      .innerJoin('video_moment_frame', 'video_moment_frame.id', 'video_moment_frame_embedding.frameId')
      .select('video_moment_frame_embedding.frameId')
      .where('video_moment_frame.assetId', '=', assetId)
      .execute();
  const momentsOf = (assetId: string) =>
    database.selectFrom('video_moment').selectAll().where('assetId', '=', assetId).orderBy('timestampMs').execute();
  const indexOf = (assetId: string) =>
    database.selectFrom('video_moment_index').selectAll().where('assetId', '=', assetId).executeTakeFirst();

  return {
    ctx,
    sut,
    moments,
    media,
    storage,
    machineLearning,
    newOwner,
    newVideo,
    replaceOriginal,
    fingerprintOf,
    framesOf,
    embeddingsOf,
    momentsOf,
    indexOf,
  };
};

describe(VideoMomentIndexService.name, () => {
  describe('frame publication and the source fingerprint', () => {
    it('publishes the frames it cut, recording the fingerprint they were cut from', async () => {
      const { sut, newOwner, newVideo, fingerprintOf, framesOf, indexOf } = setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);

      await expect(sut.runFramesStage(video.id)).resolves.toEqual({ state: EnrichmentItemState.Completed });

      const frames = await framesOf(video.id);
      expect(frames).toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
      await expect(indexOf(video.id)).resolves.toMatchObject({
        sourceFingerprint: await fingerprintOf(video.id),
        frameCount: VIDEO_MOMENT_FRAME_COUNT,
      });

      // A second run finds them current and cuts nothing.
      const again = setup();
      await expect(again.sut.runFramesStage(video.id)).resolves.toEqual({
        state: EnrichmentItemState.Completed,
        reasonKey: 'current',
      });
      expect(again.media.transcode).not.toHaveBeenCalled();
    });

    it('publishes no frames when the original is replaced while they are being cut', async () => {
      const { sut, media, storage, newOwner, newVideo, replaceOriginal, framesOf, indexOf } = setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);

      const cut: string[] = [];
      media.transcode.mockImplementation(async (_input, output) => {
        if (cut.length === 0) {
          await replaceOriginal(video.id);
        }
        cut.push(output as string);
      });

      await expect(sut.runFramesStage(video.id)).resolves.toEqual({
        state: EnrichmentItemState.Failed,
        reasonKey: 'source-changed',
      });

      await expect(framesOf(video.id)).resolves.toEqual([]);
      await expect(indexOf(video.id)).resolves.toBeUndefined();
      // The files cut from the old original are removed rather than left behind.
      expect(cut).toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
      for (const path of cut) {
        expect(storage.unlink).toHaveBeenCalledWith(path);
      }
    });

    it('publishes no embeddings or moments when the original is replaced and invalidated during indexing', async () => {
      const { sut, machineLearning, newOwner, newVideo, replaceOriginal, framesOf, embeddingsOf, momentsOf } =
        setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);
      await sut.runFramesStage(video.id);

      let replaced = false;
      machineLearning.encodeImage.mockImplementation(async () => {
        if (!replaced) {
          replaced = true;
          await replaceOriginal(video.id);
          await sut.onAssetMetadataExtracted({ assetId: video.id, userId: user.id });
        }
        return newEmbedding();
      });

      await expect(sut.runIndexStage(video.id)).resolves.toEqual({
        state: EnrichmentItemState.Failed,
        reasonKey: 'source-changed',
      });
      await expect(framesOf(video.id)).resolves.toEqual([]);
      await expect(embeddingsOf(video.id)).resolves.toEqual([]);
      await expect(momentsOf(video.id)).resolves.toEqual([]);
    });

    it('publishes no embeddings when the original is replaced during indexing, before it is invalidated', async () => {
      const { sut, machineLearning, newOwner, newVideo, replaceOriginal, embeddingsOf, momentsOf, indexOf } = setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);
      await sut.runFramesStage(video.id);

      let replaced = false;
      machineLearning.encodeImage.mockImplementation(async () => {
        if (!replaced) {
          replaced = true;
          await replaceOriginal(video.id);
        }
        return newEmbedding();
      });

      await expect(sut.runIndexStage(video.id)).resolves.toEqual({
        state: EnrichmentItemState.Failed,
        reasonKey: 'source-changed',
      });
      await expect(embeddingsOf(video.id)).resolves.toEqual([]);
      await expect(momentsOf(video.id)).resolves.toEqual([]);
      await expect(indexOf(video.id)).resolves.toMatchObject({ embeddingModel: null, indexedAt: null });
    });

    it('publishes no captions when the original is replaced while they are being written', async () => {
      const { ctx, sut, machineLearning, newOwner, newVideo, replaceOriginal, momentsOf } = setup();
      await ctx.updateConfig({
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          imageDescription: { ...defaults.machineLearning.imageDescription, enabled: true },
        },
      });
      try {
        const { user } = await newOwner();
        const video = await newVideo(user.id);
        await sut.runFramesStage(video.id);

        let replaced = false;
        machineLearning.describeImage.mockImplementation(async () => {
          if (!replaced) {
            replaced = true;
            await replaceOriginal(video.id);
          }
          return { description: 'A child blows out the candles' } as never;
        });

        const config = await ctx.getConfig({ withCache: false });
        await expect(
          sut.runCaptionStage(video.id, { imageDescription: config.machineLearning.imageDescription }),
        ).resolves.toEqual({ state: EnrichmentItemState.Failed, reasonKey: 'source-changed' });
        await expect(momentsOf(video.id)).resolves.toEqual([]);
      } finally {
        await ctx.updateConfig(defaults);
      }
    });

    it('publishes an embedding and a generated moment per frame while the original is unchanged', async () => {
      const { sut, newOwner, newVideo, framesOf, embeddingsOf, momentsOf, indexOf } = setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);

      await expect(sut.runIndexStage(video.id)).resolves.toEqual({ state: EnrichmentItemState.Completed });

      const frames = await framesOf(video.id);
      expect(frames).toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
      await expect(embeddingsOf(video.id)).resolves.toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
      const generated = await momentsOf(video.id);
      expect(generated.map(({ source }) => source)).toEqual(
        Array.from({ length: VIDEO_MOMENT_FRAME_COUNT }, () => VideoMomentSource.Generated),
      );
      expect(new Set(generated.map(({ frameId }) => frameId))).toEqual(new Set(frames.map(({ id }) => id)));
      await expect(indexOf(video.id)).resolves.toMatchObject({
        embeddingModel: defaults.machineLearning.clip.modelName,
        indexedAt: expect.any(Date),
      });

      // A retry sends nothing already indexed.
      const again = setup();
      await expect(again.sut.runIndexStage(video.id)).resolves.toEqual({
        state: EnrichmentItemState.Completed,
        reasonKey: 'current',
      });
      expect(again.machineLearning.encodeImage).not.toHaveBeenCalled();
    });
  });

  describe('invalidateGenerated', () => {
    it('drops generated results of a changed original and keeps manual moments, transcripts and the cover', async () => {
      const { sut, storage, newOwner, newVideo, replaceOriginal, fingerprintOf, framesOf, embeddingsOf, momentsOf } =
        setup();
      const { user, auth } = await newOwner();
      const video = await newVideo(user.id);
      await sut.runIndexStage(video.id);
      const oldFrames = await framesOf(video.id);

      const manual = await sut.createMoment(auth, video.id, {
        timestampMs: 12_000,
        endMs: 15_000,
        caption: 'Blowing out the candles',
        transcript: 'Happy birthday to you',
      });
      await sut.setCover(auth, video.id, { timestampMs: oldFrames[2].timestampMs });

      await replaceOriginal(video.id);
      await sut.onAssetMetadataExtracted({ assetId: video.id, userId: user.id });

      await expect(framesOf(video.id)).resolves.toEqual([]);
      await expect(embeddingsOf(video.id)).resolves.toEqual([]);
      await expect(momentsOf(video.id)).resolves.toEqual([
        expect.objectContaining({
          id: manual.id,
          source: VideoMomentSource.Manual,
          caption: 'Blowing out the candles',
          transcript: 'Happy birthday to you',
          timestampMs: 12_000,
          endMs: 15_000,
        }),
      ]);
      for (const { path } of oldFrames) {
        expect(storage.unlink).toHaveBeenCalledWith(path);
      }

      const view = await sut.getMoments(auth, video.id);
      expect(view).toMatchObject({
        state: VideoMomentIndexState.None,
        staleReason: null,
        frames: [],
        coverTimestampMs: oldFrames[2].timestampMs,
        embeddingModel: null,
        moments: [{ id: manual.id, source: VideoMomentSource.Manual, transcript: 'Happy birthday to you' }],
      });
      await expect(
        database
          .selectFrom('video_moment_index')
          .select('sourceFingerprint')
          .where('assetId', '=', video.id)
          .executeTakeFirst(),
      ).resolves.toEqual({ sourceFingerprint: await fingerprintOf(video.id) });

      // The next run cuts frames from the new original; the manual moment is still there.
      await expect(sut.runIndexStage(video.id)).resolves.toEqual({ state: EnrichmentItemState.Completed });
      const refreshed = await momentsOf(video.id);
      expect(refreshed.filter(({ source }) => source === VideoMomentSource.Manual)).toEqual([
        expect.objectContaining({ id: manual.id, transcript: 'Happy birthday to you' }),
      ]);
      expect(refreshed.filter(({ source }) => source === VideoMomentSource.Generated)).toHaveLength(
        VIDEO_MOMENT_FRAME_COUNT,
      );
    });

    it('leaves an unchanged original alone', async () => {
      const { sut, newOwner, newVideo, framesOf, momentsOf } = setup();
      const { user } = await newOwner();
      const video = await newVideo(user.id);
      await sut.runIndexStage(video.id);

      await sut.onAssetMetadataExtracted({ assetId: video.id, userId: user.id });

      await expect(framesOf(video.id)).resolves.toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
      await expect(momentsOf(video.id)).resolves.toHaveLength(VIDEO_MOMENT_FRAME_COUNT);
    });
  });

  describe('search', () => {
    it('leaves out Locked videos unless the owner’s session is unlocked', async () => {
      const { sut, machineLearning, newOwner, newVideo } = setup();
      const { user } = await newOwner();
      const visible = await newVideo(user.id);
      const locked = await newVideo(user.id, AssetVisibility.Locked);

      // Every frame of both videos, and the search text, encode to the same vector.
      const embedding = newEmbedding();
      machineLearning.encodeImage.mockResolvedValue(embedding);
      machineLearning.encodeText.mockResolvedValue(embedding);
      await expect(sut.runIndexStage(visible.id)).resolves.toMatchObject({ state: EnrichmentItemState.Completed });
      await expect(sut.runIndexStage(locked.id)).resolves.toMatchObject({ state: EnrichmentItemState.Completed });

      const elevated = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      for (const assetId of [visible.id, locked.id]) {
        await sut.createMoment(elevated, assetId, { timestampMs: 30_000, transcript: 'the birthday song' });
      }

      const notUnlocked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });
      const { hits } = await sut.search(notUnlocked, { query: 'birthday', limit: 100 });
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits.map(({ assetId }) => assetId))).toEqual(new Set([visible.id]));
      expect(hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assetId: visible.id, match: VideoMomentMatch.Transcript }),
          expect.objectContaining({ assetId: visible.id, match: VideoMomentMatch.Visual }),
        ]),
      );

      const unlocked = await sut.search(elevated, { query: 'birthday', limit: 100 });
      expect(new Set(unlocked.hits.map(({ assetId }) => assetId))).toEqual(new Set([visible.id, locked.id]));
    });

    it('only searches the caller’s own library', async () => {
      const { sut, newOwner, newVideo } = setup();
      const alice = await newOwner();
      const bob = await newOwner();
      const video = await newVideo(alice.user.id);
      await sut.createMoment(alice.auth, video.id, { timestampMs: 1000, transcript: 'a private toast' });

      await expect(sut.search(bob.auth, { query: 'private toast' })).resolves.toMatchObject({ hits: [] });
      await expect(sut.search(alice.auth, { query: 'private toast' })).resolves.toMatchObject({
        hits: [{ assetId: video.id, match: VideoMomentMatch.Transcript }],
      });
    });
  });
});
