import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { LivePhotoRepository } from 'src/repositories/live-photo.repository.js';
import { LivePhotoService } from 'src/services/live-photo.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

describe(LivePhotoService.name, () => {
  let sut: LivePhotoService;
  let mocks: ServiceMocks;
  let livePhotoRepository: LivePhotoRepository;

  beforeEach(() => {
    clearConfigCache();
    mocks = getMocks();
    livePhotoRepository = {
      getUnlinkedByContentId: vi.fn().mockResolvedValue([]),
      getUnlinkedByFilename: vi.fn().mockResolvedValue([]),
    } as unknown as LivePhotoRepository;

    sut = new LivePhotoService(
      mocks.logger as never,
      mocks.asset as never,
      mocks.album as never,
      mocks.event as never,
      livePhotoRepository,
      mocks.config as never,
      mocks.systemMetadata as never,
    );
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getCandidates', () => {
    it('suggests no pairs while Library care → Suggest Live Photo relinking is off (FL-69)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ libraryCare: { livePhotoRepair: false } });

      await expect(sut.getCandidates(AuthFactory.create())).resolves.toEqual({
        candidates: [],
        total: 0,
        suggestionsEnabled: false,
      });
      expect(livePhotoRepository.getUnlinkedByContentId).not.toHaveBeenCalled();
    });

    it('returns high-confidence CID pairs and fills gaps with low-confidence filename pairs', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photoA = AssetFactory.from({ id: 'photo-a', ownerId, type: AssetType.Image }).exif().build();
      const videoA = AssetFactory.from({ id: 'video-a', ownerId, type: AssetType.Video }).exif().build();
      const photoB = AssetFactory.from({ id: 'photo-b', ownerId, type: AssetType.Image }).exif().build();
      const videoB = AssetFactory.from({ id: 'video-b', ownerId, type: AssetType.Video }).exif().build();

      vi.mocked(livePhotoRepository.getUnlinkedByContentId).mockResolvedValue([
        { photoId: 'photo-a', videoId: 'video-a' },
      ]);
      // photo-a/video-a is repeated here (already taken by CID) and a fresh low pair is added
      vi.mocked(livePhotoRepository.getUnlinkedByFilename).mockResolvedValue([
        { photoId: 'photo-a', videoId: 'video-a' },
        { photoId: 'photo-b', videoId: 'video-b' },
      ]);
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([photoA, videoA, photoB, videoB] as never);

      const result = await sut.getCandidates(auth);

      expect(result.total).toBe(2);
      expect(result.candidates).toEqual([
        expect.objectContaining({
          confidence: 'high',
          photo: expect.objectContaining({ id: 'photo-a' }),
          video: expect.objectContaining({ id: 'video-a' }),
        }),
        expect.objectContaining({
          confidence: 'low',
          photo: expect.objectContaining({ id: 'photo-b' }),
          video: expect.objectContaining({ id: 'video-b' }),
        }),
      ]);
    });

    it('drops ambiguous low-confidence matches (a photo matching multiple videos)', async () => {
      const auth = AuthFactory.create();
      vi.mocked(livePhotoRepository.getUnlinkedByFilename).mockResolvedValue([
        { photoId: 'photo-x', videoId: 'video-1' },
        { photoId: 'photo-x', videoId: 'video-2' },
      ]);
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([] as never);

      const result = await sut.getCandidates(auth);

      expect(result.total).toBe(0);
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).toHaveBeenCalledWith([]);
    });
  });

  describe('relink', () => {
    it('links the photo, hides the video, removes it from albums, and emits a hide event', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      const result = await sut.relink(auth, { pairs: [{ photoId: 'photo-1', videoId: 'video-1' }] });

      expect(result.results).toEqual([{ photoId: 'photo-1', videoId: 'video-1', success: true }]);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'photo-1', livePhotoVideoId: 'video-1' });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'video-1', visibility: AssetVisibility.Hidden });
      expect(mocks.album.removeAssetsFromAll).toHaveBeenCalledWith(['video-1']);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: 'video-1', userId: ownerId });
    });

    it('rejects a pair whose image is already linked', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: 'already-linked',
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);

      const result = await sut.relink(auth, { pairs: [{ photoId: 'photo-1', videoId: 'video-1' }] });

      expect(result.results[0].success).toBe(false);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('rejects a pair that belongs to another user', async () => {
      const auth = AuthFactory.create();
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId: 'someone-else',
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId: 'someone-else',
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);

      const result = await sut.relink(auth, { pairs: [{ photoId: 'photo-1', videoId: 'video-1' }] });

      expect(result.results[0].success).toBe(false);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('rejects a pair where the still and the video roles are swapped', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      // "photo-1" is a video and "video-1" is an image: a mismatched pair, not merely reversed ids.
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Video,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId,
        type: AssetType.Image,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);

      const result = await sut.relink(auth, { pairs: [{ photoId: 'photo-1', videoId: 'video-1' }] });

      expect(result.results[0]).toEqual({
        photoId: 'photo-1',
        videoId: 'video-1',
        success: false,
        error: 'A live photo must be an image paired with a video',
      });
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('reports partial success across a batch: one relinked pair and one stale, already-claimed pair', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const goodPhoto = AssetFactory.from({
        id: 'photo-good',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const goodVideo = AssetFactory.from({
        id: 'video-good',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      const stalePhoto = AssetFactory.from({
        id: 'photo-stale',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const staleVideo = AssetFactory.from({
        id: 'video-stale',
        ownerId,
        type: AssetType.Video,
        // Already hidden, i.e. already claimed as another live photo's motion part since this
        // candidate was found: the classic "stale existing link" the review page must surface.
        visibility: AssetVisibility.Hidden,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([goodPhoto, goodVideo, stalePhoto, staleVideo] as never);
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      const result = await sut.relink(auth, {
        pairs: [
          { photoId: 'photo-good', videoId: 'video-good' },
          { photoId: 'photo-stale', videoId: 'video-stale' },
        ],
      });

      expect(result.results).toEqual([
        { photoId: 'photo-good', videoId: 'video-good', success: true },
        {
          photoId: 'photo-stale',
          videoId: 'video-stale',
          success: false,
          error: 'Video is already part of a live photo',
        },
      ]);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'photo-good', livePhotoVideoId: 'video-good' });
      expect(mocks.asset.update).not.toHaveBeenCalledWith({ id: 'photo-stale', livePhotoVideoId: 'video-stale' });
    });

    it('does not relink the same photo twice within a single request', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const videoA = AssetFactory.from({
        id: 'video-a',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      const videoB = AssetFactory.from({
        id: 'video-b',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, videoA, videoB] as never);
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      const result = await sut.relink(auth, {
        pairs: [
          { photoId: 'photo-1', videoId: 'video-a' },
          { photoId: 'photo-1', videoId: 'video-b' },
        ],
      });

      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
      // Only the first pair is linked; the stale snapshot must not overwrite it.
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'photo-1', livePhotoVideoId: 'video-a' });
      expect(mocks.asset.update).not.toHaveBeenCalledWith({ id: 'photo-1', livePhotoVideoId: 'video-b' });
    });
  });

  describe('relinkOne', () => {
    it('links a validated pair, the same way relink() does for a single item (FL-70)', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      const result = await sut.relinkOne(auth, 'photo-1', 'video-1');

      expect(result).toEqual({ success: true });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'photo-1', livePhotoVideoId: 'video-1' });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: 'video-1', visibility: AssetVisibility.Hidden });
    });

    it('rejects a pair that has since changed, without touching either asset (FL-70)', async () => {
      const auth = AuthFactory.create();
      const ownerId = auth.user.id;
      const photo = AssetFactory.from({
        id: 'photo-1',
        ownerId,
        type: AssetType.Image,
        livePhotoVideoId: 'already-linked',
        visibility: AssetVisibility.Timeline,
      }).build();
      const video = AssetFactory.from({
        id: 'video-1',
        ownerId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      }).build();
      mocks.asset.getByIds.mockResolvedValue([photo, video] as never);

      const result = await sut.relinkOne(auth, 'photo-1', 'video-1');

      expect(result).toEqual({ success: false, error: 'Image is already linked to a motion video' });
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    describe('Locked media (FL-70)', () => {
      const pairOf = (ownerId: string, locked: { photo: boolean; video: boolean }) => [
        {
          ...AssetFactory.from({ id: 'photo-1', ownerId, type: AssetType.Image, livePhotoVideoId: null }).build(),
          isLocked: locked.photo,
        },
        { ...AssetFactory.from({ id: 'video-1', ownerId, type: AssetType.Video }).build(), isLocked: locked.video },
      ];

      it('answers a Locked video like a missing one to a session that has not unlocked', async () => {
        const auth = AuthFactory.create();
        mocks.asset.getByIds.mockResolvedValue(pairOf(auth.user.id, { photo: false, video: true }) as never);

        const result = await sut.relinkOne(auth, 'photo-1', 'video-1');

        expect(result).toEqual({ success: false, error: 'Asset not found' });
        expect(mocks.asset.update).not.toHaveBeenCalled();
      });

      it('never pairs an unlocked still with a Locked video, even in an unlocked session', async () => {
        const auth = AuthFactory.from().session({ hasElevatedPermission: true }).build();
        mocks.asset.getByIds.mockResolvedValue(pairOf(auth.user.id, { photo: false, video: true }) as never);

        const result = await sut.relinkOne(auth, 'photo-1', 'video-1');

        expect(result).toEqual({ success: false, error: 'A Locked item cannot be paired with one that is not Locked' });
        expect(mocks.asset.update).not.toHaveBeenCalled();
      });
    });
  });
});
