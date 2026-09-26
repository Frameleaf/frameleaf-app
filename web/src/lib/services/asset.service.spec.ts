import { AssetTypeEnum, getAssetInfo } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { mdiTune } from '@mdi/js';
import { get } from 'svelte/store';
import { vitest } from 'vitest';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getAssetActions, handleDownloadAsset } from '$lib/services/asset.service';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import * as utils from '$lib/utils';
import { setSharedLink } from '$lib/utils';
import { downloadAssetFile } from '$lib/utils/asset-utils';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vitest.mock('@immich/ui', () => ({
  toastManager: {
    primary: vitest.fn(),
  },
}));

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn(),
  getPreferredLocale: vitest.fn(),
}));

vitest.mock('@immich/sdk');

vitest.mock('$lib/utils/asset-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/asset-utils')>()),
  downloadAssetFile: vitest.fn(),
}));

vitest.mock('$lib/utils', async () => {
  const originalModule = await vitest.importActual('$lib/utils');
  return {
    ...originalModule,
    sleep: vitest.fn(),
  };
});

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

describe('AssetService', () => {
  describe('getAssetActions', () => {
    beforeEach(() => {
      authManager.reset();
      authManager.setPreferences(preferencesFactory.build());
      setSharedLink(undefined);
    });

    const ownerId = 'owner';

    const setOwnerUser = () => {
      authManager.setUser(userAdminFactory.build({ id: ownerId }));
    };

    const buildEditableVideo = (overrides = {}) =>
      assetFactory.build({
        ownerId,
        type: AssetTypeEnum.Video,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        width: 1920,
        height: 1080,
        duration: 10_000,
        ...overrides,
      });

    it('should allow shared link downloads if the user owns the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    it('should not allow shared link downloads if the user does not own the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: 'non-owner' });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(false);
    });

    it('should allow shared link downloads if shared link downloads are enabled regardless of user', () => {
      const asset = assetFactory.build();
      setSharedLink(sharedLinkFactory.build({ allowDownload: true }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    it('should pause a running slideshow when T opens the tag box (MediaViewer.jsx:803-807)', () => {
      setOwnerUser();
      const asset = assetFactory.build({ ownerId, isTrashed: false });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      getAssetActions(() => '', asset).Tag.onAction?.({} as never);
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow);
      expect(assetViewerManager.focusRequest).toBe('tags');
      slideshowStore.slideshowState.set(SlideshowState.None);
      getAssetActions(() => '', asset).Tag.onAction?.({} as never);
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None);
      assetViewerManager.focusRequest = null;
    });

    it('should allow editing owned videos with dimensions and duration', () => {
      setOwnerUser();
      const asset = buildEditableVideo();
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Edit.$if?.()).toStrictEqual(true);
    });

    it.each([{ width: null }, { height: null }, { duration: null }, { width: 0 }, { height: 0 }, { duration: 0 }])(
      'should still show the video editor action when client metadata is missing: %o',
      (overrides) => {
        setOwnerUser();
        const asset = buildEditableVideo(overrides);
        const assetActions = getAssetActions(() => '', asset);
        expect(assetActions.Edit.$if?.()).toStrictEqual(true);
      },
    );

    it('should use the tuning icon for image and video editing', () => {
      setOwnerUser();
      const video = buildEditableVideo();
      const image = assetFactory.build({
        ownerId,
        type: AssetTypeEnum.Image,
        originalPath: '/upload/photo.jpg',
        originalFileName: 'photo.jpg',
      });

      expect(getAssetActions(() => '', video).Edit.icon).toBe(mdiTune);
      expect(getAssetActions(() => '', image).Edit.icon).toBe(mdiTune);
    });

    it('should build actions for shared link assets with hidden metadata', () => {
      setSharedLink(sharedLinkFactory.build({ allowDownload: true, showMetadata: false }));
      const asset = assetFactory.build({
        type: AssetTypeEnum.Image,
        originalPath: undefined as never,
        hasMetadata: false,
      });

      const assetActions = getAssetActions(() => '', asset);

      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
      expect(assetActions.Info.$if?.()).toStrictEqual(false);
    });

    it('should not allow editing videos from shared links', () => {
      setOwnerUser();
      setSharedLink(sharedLinkFactory.build({ allowDownload: true }));
      const asset = buildEditableVideo();
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Edit.$if?.()).toStrictEqual(false);
    });

    it('should not allow editing trashed videos', () => {
      setOwnerUser();
      const asset = buildEditableVideo({ isTrashed: true });
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Edit.$if?.()).toStrictEqual(false);
    });

    it('should not allow editing live-photo companion videos', () => {
      setOwnerUser();
      const asset = buildEditableVideo({ livePhotoVideoId: 'live-photo-video-id' });
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Edit.$if?.()).toStrictEqual(false);
    });
  });

  describe('handleDownloadAsset', () => {
    beforeEach(() => {
      vitest.clearAllMocks();
    });

    // FL-45 D-3: a single download goes through the download panel, one row per file.
    it('adds the asset to the download panel under its originalFileName', async () => {
      const asset = assetFactory.build({ originalFileName: 'asset.heic', livePhotoVideoId: null });
      await handleDownloadAsset(asset, { edited: false });
      expect(downloadAssetFile).toHaveBeenCalledTimes(1);
      expect(downloadAssetFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: asset.id, filename: 'asset.heic', edited: false }),
      );
      expect(toastManager.primary).not.toHaveBeenCalled();
    });

    it('saves the file directly on a public share, as its lightbox does (PublicViewer.jsx:508-517)', async () => {
      const downloadUrl = vitest.spyOn(utils, 'downloadUrl').mockImplementation(() => {});
      const isSharedLink = vitest.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
      try {
        const asset = assetFactory.build({ originalFileName: 'shared.heic', livePhotoVideoId: null });
        await handleDownloadAsset(asset, { edited: false });
        expect(downloadAssetFile).not.toHaveBeenCalled();
        // `@immich/sdk` is mocked here, so only the file name is meaningful.
        expect(downloadUrl).toHaveBeenCalledWith(expect.any(String), 'shared.heic');
      } finally {
        isSharedLink.mockRestore();
        downloadUrl.mockRestore();
      }
    });

    it('adds the motion part as its own row with a -motion name', async () => {
      const motionAsset = assetFactory.build({ originalFileName: 'asset.mov' });
      vitest.mocked(getAssetInfo).mockResolvedValue(motionAsset);
      const asset = assetFactory.build({ originalFileName: 'asset.heic', livePhotoVideoId: '1' });
      await handleDownloadAsset(asset, { edited: true });
      expect(downloadAssetFile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: asset.id, filename: 'asset.heic', edited: true }),
      );
      expect(downloadAssetFile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: '1', filename: 'asset-motion.mov', edited: true }),
      );
    });
  });
});
