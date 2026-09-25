import { BadRequestException } from '@nestjs/common';
import { defaults } from 'src/config.js';
import { AssetStatus, AssetType, AssetVisibility, EnrichmentItemState, JobName, VideoMomentSource } from 'src/enum.js';
import { VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import {
  VIDEO_MOMENT_EXTRACTOR_VERSION,
  enrichmentConfigHash,
  identityHash,
  sourceFingerprint,
} from 'src/utils/enrichment-plan.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { probeStub } from 'test/fixtures/media.stub.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const ownerId = authStub.user1.user.id;
const assetId = newUuid();

const source = {
  id: assetId,
  ownerId,
  type: AssetType.Video,
  status: AssetStatus.Active,
  deletedAt: null,
  visibility: AssetVisibility.Timeline,
  originalPath: '/library/clip.mp4',
  checksum: Buffer.from('aabb', 'hex'),
  fileModifiedAt: new Date('2026-01-01T00:00:00Z'),
  duration: 70_000,
  videoStream: probeStub.videoStream2160p.videoStream!,
  format: { ...probeStub.videoStream2160p.format, duration: 70_000 },
};
const fingerprint = sourceFingerprint(source);

const frame = (frameIndex: number, rank: number) => ({
  id: newUuid(),
  assetId,
  frameIndex,
  timestampMs: (frameIndex + 1) * 10_000,
  path: `/thumbs/${assetId}_moment_x_${frameIndex}.jpeg`,
  width: 1280,
  height: 720,
  score: 100 - rank,
  rank,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe(VideoMomentIndexService.name, () => {
  let sut: VideoMomentIndexService;
  let mocks: ServiceMocks;
  let moments: Record<string, ReturnType<typeof vi.fn>>;
  const frames = [frame(0, 2), frame(1, 1), frame(2, 3)];

  beforeEach(() => {
    mocks = getMocks();
    moments = {
      withFrameLock: vi.fn((_assetId: string, callback: () => Promise<unknown>) => callback()),
      getVideoSource: vi.fn().mockResolvedValue(source),
      getFingerprints: vi.fn().mockResolvedValue(new Map([[assetId, fingerprint]])),
      getAssetKinds: vi.fn().mockResolvedValue(new Map([[assetId, { type: AssetType.Video, ownerId }]])),
      getIndex: vi.fn().mockResolvedValue({
        assetId,
        sourceFingerprint: fingerprint,
        extractorVersion: VIDEO_MOMENT_EXTRACTOR_VERSION,
        frameCount: frames.length,
        coverTimestampMs: null,
      }),
      getFrames: vi.fn().mockResolvedValue(frames),
      getIndexedFrameIds: vi.fn().mockResolvedValue(new Set()),
      replaceFrames: vi.fn(),
      publishIndex: vi.fn().mockResolvedValue(frames.length),
      publishCaptions: vi.fn().mockResolvedValue(frames.length),
      listMoments: vi.fn().mockResolvedValue([]),
      getMoment: vi.fn(),
      createManualMoment: vi.fn(),
      updateManualMoment: vi.fn(),
      deleteManualMoment: vi.fn(),
      setCover: vi.fn(),
      invalidateGenerated: vi.fn().mockResolvedValue(['/thumbs/a.jpeg']),
      searchFrames: vi.fn().mockResolvedValue([]),
      searchMomentText: vi.fn().mockResolvedValue([]),
    };
    mocks.person.getFaces.mockResolvedValue([]);

    sut = new VideoMomentIndexService(
      mocks.logger as never,
      mocks.access as never,
      moments as never,
      mocks.media as never,
      mocks.storage as never,
      mocks.machineLearning as never,
      mocks.mlDestination as never,
      mocks.person as never,
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.job as never,
    );
  });

  describe('runFramesStage', () => {
    it('reuses current frames instead of cutting them again', async () => {
      await expect(sut.runFramesStage(assetId)).resolves.toEqual({
        state: EnrichmentItemState.Completed,
        reasonKey: 'current',
      });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
      expect(moments.replaceFrames).not.toHaveBeenCalled();
    });

    it('cuts six ranked frames when the original changed, published against the fingerprint read first', async () => {
      moments.getIndex.mockResolvedValue({
        sourceFingerprint: 'old',
        extractorVersion: VIDEO_MOMENT_EXTRACTOR_VERSION,
      });
      mocks.media.scoreThumbnailCandidate.mockResolvedValue(50);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 1280, height: 720, isTransparent: false });
      moments.replaceFrames.mockResolvedValue({ status: 'replaced', stalePaths: ['/thumbs/old.jpeg'], frames });

      await expect(sut.runFramesStage(assetId)).resolves.toEqual({ state: EnrichmentItemState.Completed });

      expect(mocks.media.transcode).toHaveBeenCalledTimes(6);
      expect(moments.replaceFrames).toHaveBeenCalledWith(assetId, fingerprint, expect.any(Array), {
        extractorVersion: VIDEO_MOMENT_EXTRACTOR_VERSION,
      });
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/thumbs/old.jpeg');
    });

    it('discards what it cut when the original was replaced meanwhile', async () => {
      moments.getIndex.mockResolvedValue(undefined);
      mocks.media.scoreThumbnailCandidate.mockResolvedValue(50);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 1280, height: 720, isTransparent: false });
      moments.replaceFrames.mockResolvedValue({ status: 'source-changed' });

      await expect(sut.runFramesStage(assetId)).resolves.toEqual({
        state: EnrichmentItemState.Failed,
        reasonKey: 'source-changed',
      });
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(6);
    });

    it('skips a photo', async () => {
      moments.getVideoSource.mockResolvedValue(undefined);

      await expect(sut.runFramesStage(assetId)).resolves.toEqual({
        state: EnrichmentItemState.Skipped,
        reasonKey: 'not-a-video',
      });
    });
  });

  describe('runIndexStage', () => {
    it('embeds only the frames not yet indexed, on the named destination', async () => {
      moments.getIndexedFrameIds.mockResolvedValue(new Set([frames[0].id]));
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.1,0.2]');

      await expect(
        sut.runIndexStage(assetId, { destinationId: mlDestinationStub.local.id, modelName: 'ViT-B-32__openai' }),
      ).resolves.toEqual({ state: EnrichmentItemState.Completed });

      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledTimes(2);
      expect(moments.publishIndex).toHaveBeenCalledWith(
        assetId,
        [
          { frameId: frames[1].id, embedding: '[0.1,0.2]' },
          { frameId: frames[2].id, embedding: '[0.1,0.2]' },
        ],
        { embeddingModel: 'ViT-B-32__openai', embeddingDestinationId: mlDestinationStub.local.id },
      );
    });

    it('stops before the next frame when the plan has lost its claim', async () => {
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.1]');
      const heartbeat = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

      const outcome = await sut.runIndexStage(assetId, { destinationId: mlDestinationStub.local.id, heartbeat });

      expect(outcome).toEqual(expect.objectContaining({ state: EnrichmentItemState.Failed, reasonKey: 'stage-error' }));
      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledTimes(1);
      expect(moments.publishIndex).not.toHaveBeenCalled();
    });

    it('fails in place when the destination refuses, without trying another', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);

      const outcome = await sut.runIndexStage(assetId, { destinationId: newUuid() });

      expect(outcome).toEqual(expect.objectContaining({ state: EnrichmentItemState.Failed, reasonKey: 'model-error' }));
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(moments.publishIndex).not.toHaveBeenCalled();
    });
  });

  describe('runCaptionStage', () => {
    const imageDescription = defaults.machineLearning.imageDescription;
    const captionHash = enrichmentConfigHash({
      modelName: imageDescription.modelName,
      prompt: { ...imageDescription.prompt, style: 'terse', sentenceCountTarget: 1 },
    });

    it('captions only frames whose caption is missing or was made with other names', async () => {
      moments.listMoments.mockResolvedValue([
        {
          id: newUuid(),
          source: VideoMomentSource.Generated,
          frameId: frames[0].id,
          caption: 'A beach.',
          provenance: { identityHash: identityHash([]), configHash: captionHash },
        },
        {
          id: newUuid(),
          source: VideoMomentSource.Generated,
          frameId: frames[1].id,
          caption: 'A dog.',
          provenance: { identityHash: identityHash(['Alex']), configHash: captionHash },
        },
        { id: newUuid(), source: VideoMomentSource.Manual, frameId: null, caption: 'Cake!', provenance: null },
      ]);
      mocks.machineLearning.describeImage.mockResolvedValue({ description: 'Waves at dusk.' } as never);

      await expect(sut.runCaptionStage(assetId, { imageDescription })).resolves.toEqual({
        state: EnrichmentItemState.Completed,
      });

      expect(mocks.machineLearning.describeImage).toHaveBeenCalledTimes(2);
      const config = mocks.machineLearning.describeImage.mock.calls[0][2];
      expect(config).toEqual(
        expect.objectContaining({ prompt: expect.objectContaining({ style: 'terse', sentenceCountTarget: 1 }) }),
      );
      expect(moments.publishCaptions).toHaveBeenCalledWith(
        assetId,
        [
          { frameId: frames[1].id, caption: 'Waves at dusk.' },
          { frameId: frames[2].id, caption: 'Waves at dusk.' },
        ],
        expect.objectContaining({ identityHash: identityHash([]), configHash: captionHash }),
        expect.objectContaining({ captionIdentityHash: identityHash([]) }),
        expect.any(Function),
      );
    });

    it('keeps the captions it made and reports the frame that failed', async () => {
      mocks.machineLearning.describeImage
        .mockResolvedValueOnce({ description: 'One.' } as never)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ description: 'Three.' } as never);

      const outcome = await sut.runCaptionStage(assetId, { imageDescription });

      expect(outcome).toEqual({ state: EnrichmentItemState.Failed, reasonKey: 'model-error', message: 'timeout' });
      expect(moments.publishCaptions).toHaveBeenCalledWith(
        assetId,
        [
          { frameId: frames[0].id, caption: 'One.' },
          { frameId: frames[2].id, caption: 'Three.' },
        ],
        expect.anything(),
        expect.anything(),
        expect.any(Function),
      );
    });

    it('publishes nothing when the names change while the frames are captioned (FL-57)', async () => {
      const namedFace = (name: string) => ({
        personGroupId: '00000000-0000-4000-8000-00000000000a',
        person: { name, isHidden: false },
        imageWidth: 100,
        imageHeight: 100,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 40,
        boundingBoxY2: 40,
      });
      mocks.machineLearning.describeImage.mockResolvedValue({ description: 'Ada at the beach.' } as never);
      mocks.person.getFaces
        .mockResolvedValueOnce([namedFace('Ada')] as never)
        .mockResolvedValueOnce([namedFace('Grace')] as never);
      moments.publishCaptions = vi.fn(async (...args: unknown[]) => {
        const namesStillCurrent = args[4] as () => Promise<boolean>;
        return (await namesStillCurrent()) ? 3 : ('identity-changed' as const);
      });

      await expect(sut.runCaptionStage(assetId, { imageDescription })).resolves.toEqual({
        state: EnrichmentItemState.Failed,
        reasonKey: 'identity-changed',
      });
    });
  });

  describe('no automatic speech recognition (FL-59)', () => {
    it('indexes and captions a video without transcribing it or writing a transcript', async () => {
      const imageDescription = defaults.machineLearning.imageDescription;
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.1,0.2]');
      mocks.machineLearning.describeImage.mockResolvedValue({ description: 'Waves at dusk.' } as never);

      await sut.runIndexStage(assetId, { destinationId: mlDestinationStub.local.id });
      await sut.runCaptionStage(assetId, { imageDescription });

      const called = Object.entries(mocks.machineLearning)
        .filter(([, fn]) => vi.isMockFunction(fn) && fn.mock.calls.length > 0)
        .map(([name]) => name);
      expect(called).toEqual(expect.arrayContaining(['describeImage', 'encodeImage']));
      expect(called.filter((name) => /transcri|speech|audio|asr/i.test(name))).toEqual([]);
      const published = [...moments.publishIndex.mock.calls, ...moments.publishCaptions.mock.calls];
      expect(JSON.stringify(published)).not.toMatch(/transcript/i);
    });
  });

  describe('getMoments', () => {
    it('answers a missing frame exactly like a frame of a video the caller cannot read', async () => {
      moments.getFrame = vi.fn().mockResolvedValue(undefined);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.getFrameFile(authStub.user1, newUuid())).rejects.toThrow(BadRequestException);
    });

    it('needs read access to the video', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.getMoments(authStub.user1, assetId)).rejects.toThrow(BadRequestException);
      expect(moments.getFrames).not.toHaveBeenCalled();
    });

    it('ranks frames, marks the cover and flags frames cut from a replaced original', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      moments.getFingerprints.mockResolvedValue(new Map([[assetId, 'replaced']]));

      const response = await sut.getMoments(authStub.user1, assetId);

      expect(response.state).toBe('stale');
      expect(response.staleReason).toBe('source-changed');
      expect(response.coverFrameId).toBe(frames[1].id);
      expect(response.frames.find(({ isCover }) => isCover)?.rank).toBe(1);
    });
  });

  describe('setCover', () => {
    it("records the owner's cover and regenerates the video's thumbnail from it", async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.setCover(authStub.user1, assetId, { timestampMs: 2000 });

      expect(moments.setCover).toHaveBeenCalledWith(assetId, 2000, authStub.user1.user.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetGenerateThumbnails, data: { id: assetId } });
    });

    it('refuses a video without frames and queues nothing', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      moments.getIndex.mockResolvedValue(undefined);

      await expect(sut.setCover(authStub.user1, assetId, { timestampMs: 2000 })).rejects.toThrow(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('manual moments', () => {
    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    });

    it('refuses to edit a generated moment', async () => {
      moments.getMoment.mockResolvedValue({ id: 'm', assetId, source: VideoMomentSource.Generated });

      await expect(sut.updateMoment(authStub.user1, assetId, 'm', { caption: 'mine' })).rejects.toThrow(
        BadRequestException,
      );
      expect(moments.updateManualMoment).not.toHaveBeenCalled();
    });

    it('refuses a moment after the end of the video', async () => {
      await expect(sut.createMoment(authStub.user1, assetId, { timestampMs: 80_000 })).rejects.toThrow(
        BadRequestException,
      );
      expect(moments.createManualMoment).not.toHaveBeenCalled();
    });
  });

  describe('onAssetMetadataExtracted', () => {
    it('drops generated results and their files when the original changed', async () => {
      moments.getFingerprints.mockResolvedValue(new Map([[assetId, 'replaced']]));

      await sut.onAssetMetadataExtracted({ assetId, userId: ownerId });

      expect(moments.invalidateGenerated).toHaveBeenCalledWith(assetId, 'replaced');
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/thumbs/a.jpeg');
    });

    it('leaves everything alone when the original is unchanged', async () => {
      await sut.onAssetMetadataExtracted({ assetId, userId: ownerId });

      expect(moments.invalidateGenerated).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('searches only the caller library and leaves Locked videos out of an ordinary session', async () => {
      mocks.machineLearning.encodeText.mockResolvedValue('[0.3]');
      moments.searchFrames.mockResolvedValue([
        { assetId, frameId: frames[1].id, timestampMs: 20_000, distance: 0.2, caption: null },
      ]);

      const { hits } = await sut.search(authStub.user1, { query: 'waves' });

      expect(moments.searchFrames).toHaveBeenCalledWith('[0.3]', defaults.machineLearning.clip.modelName, {
        ownerId,
        lockedOwnerId: undefined,
        privacy: {},
        limit: 24,
      });
      expect(hits).toEqual([expect.objectContaining({ assetId, timestampMs: 20_000, match: 'visual' })]);
    });

    it('passes the session hidden-content filter to both text and visual search', async () => {
      mocks.machineLearning.encodeText.mockResolvedValue('[0.3]');
      const hiddenContent = {
        userId: ownerId,
        includeNsfw: true,
        tagIds: [newUuid()],
        personIds: [newUuid()],
        petIds: [],
        scope: 'owned' as const,
      };

      await sut.search({ ...authStub.user1, hiddenContent }, { query: 'waves' });

      expect(moments.searchMomentText).toHaveBeenCalledWith(
        'waves',
        expect.objectContaining({ privacy: { hiddenContent } }),
      );
      expect(moments.searchFrames).toHaveBeenCalledWith(
        '[0.3]',
        expect.any(String),
        expect.objectContaining({ privacy: { hiddenContent } }),
      );
    });

    it('hides a visual hit’s caption made with names that changed since, keeping the hit', async () => {
      mocks.machineLearning.encodeText.mockResolvedValue('[0.3]');
      const momentId = newUuid();
      moments.searchFrames.mockResolvedValue([
        { assetId, frameId: frames[1].id, momentId, timestampMs: 20_000, distance: 0.2, caption: 'Anna laughs' },
      ]);
      moments.getMoment.mockResolvedValue({
        id: momentId,
        assetId,
        source: VideoMomentSource.Generated,
        provenance: { identityHash: 'names-before' },
      });

      const { hits } = await sut.search(authStub.user1, { query: 'laughing' });

      expect(hits).toEqual([expect.objectContaining({ frameId: frames[1].id, caption: null, match: 'visual' })]);
    });

    it('still answers from captions and transcripts when the search destination refuses', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);
      moments.searchMomentText.mockResolvedValue([
        {
          assetId,
          momentId: newUuid(),
          timestampMs: 5000,
          source: VideoMomentSource.Manual,
          caption: 'Birthday cake',
          transcript: null,
        },
      ]);

      const { hits } = await sut.search(authStub.user1, { query: 'cake' });

      expect(hits).toEqual([expect.objectContaining({ match: 'caption', timestampMs: 5000 })]);
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    });
  });

  describe('searchSimilar', () => {
    const frameId = frames[0].id;
    const otherAsset = newUuid();

    beforeEach(() => {
      moments.getFrame = vi.fn().mockResolvedValue({ id: frameId, assetId, timestampMs: 2000, path: '/f', ownerId });
      moments.getFrameEmbedding = vi.fn().mockResolvedValue({ assetId, embedding: '[0.5]', modelName: 'frame-model' });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    });

    it("searches the caller's library with the frame's own embedding and model, never returning the frame", async () => {
      const momentId = newUuid();
      moments.searchFrames.mockResolvedValue([
        { assetId: otherAsset, frameId: newUuid(), momentId, timestampMs: 4000, distance: 0.1, caption: 'Surf' },
        { assetId, frameId: frames[2].id, momentId: null, timestampMs: 30_000, distance: 0.4, caption: null },
      ]);

      const { hits } = await sut.searchSimilar(authStub.user1, frameId, { limit: 10 });

      expect(moments.searchFrames).toHaveBeenCalledWith('[0.5]', 'frame-model', {
        ownerId,
        lockedOwnerId: undefined,
        privacy: {},
        limit: 10,
        excludeFrameId: frameId,
      });
      expect(hits).toEqual([
        expect.objectContaining({ assetId: otherAsset, timestampMs: 4000, momentId, match: 'visual', score: 0.9 }),
        expect.objectContaining({ assetId, timestampMs: 30_000, frameId: frames[2].id, score: 0.6 }),
      ]);
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
    });

    it('includes Locked videos only for the owner in an unlocked session', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.searchSimilar(authStub.adminWithElevatedPermission, frameId, {});

      expect(moments.searchFrames).toHaveBeenCalledWith(
        '[0.5]',
        'frame-model',
        expect.objectContaining({
          ownerId: authStub.adminWithElevatedPermission.user.id,
          lockedOwnerId: authStub.adminWithElevatedPermission.user.id,
          limit: 24,
        }),
      );
    });

    it('needs read access to the video of the frame', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.searchSimilar(authStub.user1, frameId, {})).rejects.toThrow(BadRequestException);
      expect(moments.searchFrames).not.toHaveBeenCalled();
    });

    it('answers an unknown frame exactly like a frame of a video the caller cannot read', async () => {
      moments.getFrame.mockResolvedValue(undefined);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.searchSimilar(authStub.user1, frameId, {})).rejects.toThrow('Not found or no asset.read access');
      expect(moments.getFrameEmbedding).not.toHaveBeenCalled();
      expect(moments.searchFrames).not.toHaveBeenCalled();
    });

    it('tells the reader of an unindexed frame to index the video', async () => {
      moments.getFrameEmbedding.mockResolvedValue(undefined);

      await expect(sut.searchSimilar(authStub.user1, frameId, {})).rejects.toThrow('no search embedding yet');
      expect(moments.searchFrames).not.toHaveBeenCalled();
    });

    it('passes the session hidden-content filter, and hides stale generated captions', async () => {
      const hiddenContent = {
        userId: ownerId,
        includeNsfw: false,
        tagIds: [newUuid()],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };
      const momentId = newUuid();
      moments.searchFrames.mockResolvedValue([
        { assetId, frameId: frames[2].id, momentId, timestampMs: 30_000, distance: 0.3, caption: 'Anna laughs' },
      ]);
      moments.getMoment.mockResolvedValue({
        id: momentId,
        assetId,
        source: VideoMomentSource.Generated,
        provenance: { identityHash: 'names-before' },
      });

      const { hits } = await sut.searchSimilar({ ...authStub.user1, hiddenContent }, frameId, {});

      expect(moments.searchFrames).toHaveBeenCalledWith(
        '[0.5]',
        'frame-model',
        expect.objectContaining({ privacy: { hiddenContent } }),
      );
      expect(hits).toEqual([expect.objectContaining({ momentId, caption: null })]);
    });

    it('keeps one hit per second of each video', async () => {
      moments.searchFrames.mockResolvedValue([
        { assetId: otherAsset, frameId: newUuid(), momentId: null, timestampMs: 4000, distance: 0.1, caption: null },
        { assetId: otherAsset, frameId: newUuid(), momentId: null, timestampMs: 4200, distance: 0.2, caption: null },
      ]);

      const { hits } = await sut.searchSimilar(authStub.user1, frameId, {});

      expect(hits).toHaveLength(1);
      expect(hits[0].score).toBe(0.9);
    });
  });
});
