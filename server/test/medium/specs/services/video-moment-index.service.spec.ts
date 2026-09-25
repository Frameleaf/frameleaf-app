import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { defaults } from 'src/config.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetType,
  AssetVisibility,
  EnrichmentItemState,
  JobName,
  VideoMomentIndexState,
  VideoMomentMatch,
  VideoMomentSource,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
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
  const jobs = automock(JobRepository, { args: [undefined, undefined, undefined, { setContext: () => {} }] });
  jobs.queue.mockResolvedValue();
  jobs.queueAll.mockResolvedValue();
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
    jobs,
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
    jobs,
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
      const { sut, machineLearning, newOwner, newVideo, replaceOriginal, framesOf, embeddingsOf, momentsOf } = setup();
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
      const {
        sut,
        storage,
        jobs,
        newOwner,
        newVideo,
        replaceOriginal,
        fingerprintOf,
        framesOf,
        embeddingsOf,
        momentsOf,
      } = setup();
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
      // the video's own thumbnail follows the chosen cover
      expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.AssetGenerateThumbnails, data: { id: video.id } });

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

  describe('searchSimilar (frame-to-moment search)', () => {
    /** A 512-dimension vector along `axis`, leaning `lean` towards axis 1. */
    const vector = (axis: number, lean = 0) => {
      const values = Array.from({ length: 512 }, () => 0);
      values[axis] = 1;
      values[1] += lean;
      return `[${values}]`;
    };

    /**
     * Indexes a video with one vector per frame: `byFrame[frameIndex]`, or a vector of its own far
     * from every other for frames not named.
     */
    const indexWith = async (
      { sut, machineLearning }: ReturnType<typeof setup>,
      assetId: string,
      byFrame: Record<number, string>,
    ) => {
      machineLearning.encodeImage.mockImplementation((_selection, path) => {
        const match = /([\da-f-]{36})_moment_[^_]+_(\d+)\.jpeg$/.exec(path as string);
        const frameIndex = Number(match?.[2]);
        if (match?.[1] !== assetId) {
          throw new Error(`unexpected frame ${path as string}`);
        }
        return Promise.resolve(byFrame[frameIndex] ?? vector(100 + Math.floor(Math.random() * 400)));
      });
      await expect(sut.runIndexStage(assetId)).resolves.toMatchObject({ state: EnrichmentItemState.Completed });
    };

    const frameAt = async (context: ReturnType<typeof setup>, assetId: string, frameIndex: number) => {
      const frames = await context.framesOf(assetId);
      return frames.find((frame) => frame.frameIndex === frameIndex)!;
    };

    it('ranks the most similar frame first, across videos and other times in the same video, never the frame itself', async () => {
      const context = setup();
      const { sut, newOwner, newVideo } = context;
      const { user, auth } = await newOwner();
      const source = await newVideo(user.id);
      const other = await newVideo(user.id);
      await indexWith(context, source.id, { 0: vector(0), 3: vector(0, 0.5) });
      await indexWith(context, other.id, { 2: vector(0, 0.1) });
      const query = await frameAt(context, source.id, 0);
      const sameVideo = await frameAt(context, source.id, 3);
      const closest = await frameAt(context, other.id, 2);

      const { hits } = await sut.searchSimilar(auth, query.id, { limit: 5 });

      expect(hits.map(({ frameId }) => frameId)).not.toContain(query.id);
      expect(hits[0]).toMatchObject({
        assetId: other.id,
        frameId: closest.id,
        timestampMs: closest.timestampMs,
        match: VideoMomentMatch.Visual,
        momentId: expect.any(String),
      });
      expect(hits[1]).toMatchObject({ assetId: source.id, frameId: sameVideo.id, timestampMs: sameVideo.timestampMs });
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(hits).toHaveLength(5);
    });

    it('leaves out Locked videos unless the owner’s session is unlocked', async () => {
      const context = setup();
      const { sut, newOwner, newVideo } = context;
      const { user } = await newOwner();
      const source = await newVideo(user.id);
      const locked = await newVideo(user.id, AssetVisibility.Locked);
      await indexWith(context, source.id, { 0: vector(0) });
      await indexWith(context, locked.id, { 1: vector(0, 0.05) });
      const query = await frameAt(context, source.id, 0);

      const notUnlocked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });
      const ordinary = await sut.searchSimilar(notUnlocked, query.id, { limit: 100 });
      expect(ordinary.hits.length).toBeGreaterThan(0);
      expect(ordinary.hits.map(({ assetId }) => assetId)).not.toContain(locked.id);

      const unlocked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const elevated = await sut.searchSimilar(unlocked, query.id, { limit: 100 });
      expect(elevated.hits[0]).toMatchObject({ assetId: locked.id });

      // A frame of a Locked video is not a starting point for an ordinary session either.
      const lockedFrame = await frameAt(context, locked.id, 1);
      await expect(sut.searchSimilar(notUnlocked, lockedFrame.id, {})).rejects.toThrow();
    });

    it('never returns another person’s moments, and refuses their frames', async () => {
      const context = setup();
      const { sut, newOwner, newVideo } = context;
      const alice = await newOwner();
      const bob = await newOwner();
      const mine = await newVideo(alice.user.id);
      const theirs = await newVideo(bob.user.id);
      await indexWith(context, mine.id, { 0: vector(0) });
      await indexWith(context, theirs.id, { 0: vector(0), 1: vector(0), 2: vector(0) });
      const query = await frameAt(context, mine.id, 0);

      const { hits } = await sut.searchSimilar(alice.auth, query.id, { limit: 100 });
      expect(hits.map(({ assetId }) => assetId)).not.toContain(theirs.id);
      expect(new Set(hits.map(({ assetId }) => assetId))).toEqual(new Set([mine.id]));

      await expect(sut.searchSimilar(bob.auth, query.id, {})).rejects.toThrow();
    });
  });

  describe('hidden content (suppressed people and tags)', () => {
    it('leaves suppressed videos out of text and frame-to-moment search while the session is locked', async () => {
      const context = setup();
      const { ctx, sut, machineLearning, newOwner, newVideo, framesOf } = context;
      const { user } = await newOwner();
      const clean = await newVideo(user.id);
      const tagged = await newVideo(user.id);
      const withPerson = await newVideo(user.id);

      const { tag } = await ctx.newTag({ userId: user.id, value: `private-${factory.uuid()}` });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: withPerson.id, personGroupId: person.personGroupId });

      // Every frame of every video, and the search text, encode to the same vector.
      const embedding = newEmbedding();
      machineLearning.encodeImage.mockResolvedValue(embedding);
      machineLearning.encodeText.mockResolvedValue(embedding);
      const owner = factory.auth({ user: { id: user.id } });
      for (const video of [clean, tagged, withPerson]) {
        await expect(sut.runIndexStage(video.id)).resolves.toMatchObject({ state: EnrichmentItemState.Completed });
        await sut.createMoment(owner, video.id, { timestampMs: 30_000, transcript: 'the birthday song' });
      }

      const hiddenContent = {
        userId: user.id,
        includeNsfw: false,
        tagIds: [tag.id],
        personIds: [person.personGroupId],
        petIds: [],
        scope: 'owned' as const,
      };
      const locked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });
      const lockedAuth = { ...locked, hiddenContent };
      const [query] = await framesOf(clean.id);

      const text = await sut.search(lockedAuth, { query: 'birthday', limit: 100 });
      expect(text.hits.length).toBeGreaterThan(0);
      expect(new Set(text.hits.map(({ assetId }) => assetId))).toEqual(new Set([clean.id]));

      const similar = await sut.searchSimilar(lockedAuth, query.id, { limit: 100 });
      expect(similar.hits.length).toBeGreaterThan(0);
      expect(new Set(similar.hits.map(({ assetId }) => assetId))).toEqual(new Set([clean.id]));

      // A frame of a suppressed video is not a starting point either.
      const [taggedFrame] = await framesOf(tagged.id);
      await expect(sut.searchSimilar(lockedAuth, taggedFrame.id, {})).rejects.toThrow(
        'Not found or no asset.read access',
      );

      // Without the filter (an unlocked session) all three are found again.
      const unfiltered = await sut.searchSimilar(owner, query.id, { limit: 100 });
      expect(new Set(unfiltered.hits.map(({ assetId }) => assetId))).toEqual(
        new Set([clean.id, tagged.id, withPerson.id]),
      );
    });

    it('tells the reader of a frame that has no embedding yet to index the video', async () => {
      const context = setup();
      const { sut, newOwner, newVideo, framesOf } = context;
      const { user, auth } = await newOwner();
      const video = await newVideo(user.id);
      await sut.runFramesStage(video.id);
      const [frame] = await framesOf(video.id);

      await expect(sut.searchSimilar(auth, frame.id, {})).rejects.toThrow('no search embedding yet');
    });
  });
});
