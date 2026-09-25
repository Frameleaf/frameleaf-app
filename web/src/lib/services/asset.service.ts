import {
  AssetJobName,
  AssetMediaSize,
  AssetTypeEnum,
  AssetVisibility,
  getAssetInfo,
  removeAssetFromAlbum,
  runAssetJobs,
  updateAsset,
  type AlbumResponseDto,
  type AssetJobsDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiAccountCircleOutline,
  mdiAlertOutline,
  mdiCogRefreshOutline,
  mdiCompare,
  mdiContentCopy,
  mdiDatabaseRefreshOutline,
  mdiDownload,
  mdiDownloadBox,
  mdiExportVariant,
  mdiFaceRecognition,
  mdiFilmstrip,
  mdiFolderOpenOutline,
  mdiHeadSyncOutline,
  mdiHeart,
  mdiHeartOutline,
  mdiImageRefreshOutline,
  mdiImageRemoveOutline,
  mdiImageSearch,
  mdiInformationOutline,
  mdiMagnifyMinusOutline,
  mdiMagnifyPlusOutline,
  mdiMapMarkerOutline,
  mdiMotionPauseOutline,
  mdiMotionPlayOutline,
  mdiPanorama,
  mdiPanoramaVariantOutline,
  mdiPlus,
  mdiPresentationPlay,
  mdiShareVariantOutline,
  mdiTagPlusOutline,
  mdiTune,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import ShareSheetModal from '$lib/components/frameleaf/ShareSheetModal.svelte';
import { ProjectionType } from '$lib/constants';
import { canSendCopies, isSendable, sendCopiesWithFeedback, sendCopyPermitted } from '$lib/frameleaf/send-copy';
import { folderOf } from '$lib/frameleaf/viewer-headline';
import { isPanorama } from '$lib/frameleaf/viewer-media';
import { showFilmstrip } from '$lib/frameleaf/viewer-preferences';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
import AssetTagModal from '$lib/modals/AssetTagModal.svelte';
import ProfileImageCropperModal from '$lib/modals/ProfileImageCropperModal.svelte';
import { Route } from '$lib/route';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { downloadUrl, getAssetMediaUrl, getSharedLink, sleep } from '$lib/utils';
import { downloadAssetFile } from '$lib/utils/asset-utils';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Whether a slideshow may play from this item: never from a Locked item. The More menu, the shared
 * link's bar and the viewer footer (V-13) all read this one rule. FL-56 (AL-37): a slideshow shows
 * only the previews a shared link already shows, so it no longer depends on the link allowing
 * downloads (FL-56 acceptance: the public viewer keeps its slideshow).
 */
export const canPlaySlideshow = (asset: Pick<AssetResponseDto, 'visibility'>): boolean =>
  asset.visibility !== AssetVisibility.Locked;

export const getAssetActions = (
  $t: MessageFormatter,
  asset: AssetResponseDto & { stackPrimaryAssetId?: string },
  album?: AlbumResponseDto,
) => {
  const sharedLink = getSharedLink();
  const authUser = authManager.authenticated ? authManager.user : undefined;
  const isOwner = !!(authUser && authUser.id === asset.ownerId);
  const isAlbumOwner = !!(authUser && authUser.id === album?.albumUsers[0].user.id);
  const originalPath = asset.originalPath?.toLowerCase() ?? '';
  const smartSearchEnabled = featureFlagsManager.value.smartSearch;

  const Share: ActionItem = {
    title: $t('share'),
    icon: mdiShareVariantOutline,
    $if: () => !!(authUser && !asset.isTrashed && asset.visibility !== AssetVisibility.Locked),
    onAction: () => modalManager.show(ShareSheetModal, { assetIds: [asset.id] }),
  };

  const Download: ActionItem = {
    title: $t('download'),
    icon: mdiDownload,
    shortcuts: { key: 'd', shift: true },
    $if: () => !!authUser,
    onAction: () => handleDownloadAsset(asset, { edited: true }),
  };

  const DownloadOriginal: ActionItem = {
    title: $t('download_original'),
    icon: mdiDownloadBox,
    $if: () => !!authUser && asset.isEdited,
    onAction: () => handleDownloadAsset(asset, { edited: false }),
  };

  const SharedLinkDownload: ActionItem = {
    ...Download,
    $if: () => isOwner || !!sharedLink?.allowDownload,
  };

  /**
   * FL-35 / FL-54: the native share sheet with the original file, separate from Frameleaf sharing
   * (App.jsx:818-846). Offered wherever the item may be downloaded with its metadata (a shared link
   * needs downloads and metadata, like `SharedLinkDownload` above), never for a Locked item, and only
   * where the browser can share files.
   */
  const SendCopy: ActionItem = {
    title: $t('frameleaf_send_copy'),
    icon: mdiExportVariant,
    $if: () => sendCopyPermitted(sharedLink) && isSendable(asset) && canSendCopies(),
    onAction: () => void sendCopiesWithFeedback([asset.id]),
  };

  const PlayMotionPhoto: ActionItem = {
    title: $t('play_motion_photo'),
    icon: mdiMotionPlayOutline,
    $if: () => !!asset.livePhotoVideoId && !assetViewerManager.isPlayingMotionPhoto,
    onAction: () => {
      assetViewerManager.isPlayingMotionPhoto = true;
    },
  };

  const StopMotionPhoto: ActionItem = {
    title: $t('stop_motion_photo'),
    icon: mdiMotionPauseOutline,
    $if: () => !!asset.livePhotoVideoId && assetViewerManager.isPlayingMotionPhoto,
    onAction: () => {
      assetViewerManager.isPlayingMotionPhoto = false;
    },
  };

  const PlaySlideshow: ActionItem = {
    title: $t('frameleaf_viewer_play_slideshow'),
    icon: mdiPresentationPlay,
    $if: () => canPlaySlideshow(asset),
    onAction: () => slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow),
  };

  const Favorite: ActionItem = {
    title: $t('to_favorite'),
    icon: mdiHeartOutline,
    $if: () => isOwner && !asset.isFavorite,
    onAction: () => handleFavorite(asset),
    shortcuts: [{ key: 'f' }],
  };

  const Unfavorite: ActionItem = {
    title: $t('unfavorite'),
    icon: mdiHeart,
    $if: () => isOwner && asset.isFavorite,
    onAction: () => handleUnfavorite(asset),
    shortcuts: [{ key: 'f' }],
  };

  const AddToAlbum: ActionItem = {
    title: $t('add_to_album'),
    icon: mdiPlus,
    shortcuts: [{ key: 'l' }],
    // Locked items may go into albums from an unlocked session (owner decision, September 22, 2026).
    $if: () => !asset.isTrashed,
    onAction: () => modalManager.show(AssetAddToAlbumModal, { assetIds: [asset.id] }),
  };

  const RemoveFromAlbum: ActionItem = {
    title: $t('remove_from_album'),
    icon: mdiImageRemoveOutline,
    $if: () => !!album && (isOwner || isAlbumOwner),
    onAction: () => handleRemoveAssetsFromAlbum([asset.id], album!),
  };

  const Offline: ActionItem = {
    title: $t('asset_offline'),
    icon: mdiAlertOutline,
    color: 'danger',
    $if: () => !!asset.isOffline,
    onAction: () => assetViewerManager.toggleDetailPanel(),
  };

  const ZoomIn: ActionItem = {
    title: $t('zoom_image'),
    icon: mdiMagnifyPlusOutline,
    $if: () => assetViewerManager.canZoomIn(),
    onAction: () => assetViewerManager.emit('Zoom'),
  };

  const ZoomOut: ActionItem = {
    title: $t('zoom_image'),
    icon: mdiMagnifyMinusOutline,
    $if: () => assetViewerManager.canZoomOut(),
    onAction: () => assetViewerManager.emit('Zoom'),
  };

  const Copy: ActionItem = {
    title: $t('copy_image'),
    icon: mdiContentCopy,
    $if: () => assetViewerManager.canCopyImage(),
    onAction: () => assetViewerManager.emit('Copy'),
  };

  const Info: ActionItem = {
    title: $t('frameleaf_viewer_information'),
    icon: mdiInformationOutline,
    $if: () => asset.hasMetadata,
    onAction: () => assetViewerManager.toggleDetailPanel(),
    shortcuts: { key: 'i' },
  };

  const Tag: ActionItem = {
    title: $t('add_tag'),
    icon: mdiTagPlusOutline,
    $if: () => authManager.authenticated && authManager.preferences.tags.enabled,
    onAction: () => modalManager.show(AssetTagModal, { assetIds: [asset.id] }),
    shortcuts: { key: 't' },
  };

  const TagPeople: ActionItem = {
    title: $t('tag_people'),
    icon: mdiFaceRecognition,
    $if: () => isOwner && asset.type === AssetTypeEnum.Image && !asset.isTrashed,
    onAction: () => assetViewerManager.toggleFaceEditMode(),
    shortcuts: { key: 'p' },
  };

  const isUnsupportedEditorMedia =
    asset.livePhotoVideoId ||
    asset.exifInfo?.projectionType === ProjectionType.EQUIRECTANGULAR ||
    originalPath.endsWith('.insp') ||
    originalPath.endsWith('.gif') ||
    originalPath.endsWith('.svg');

  const isEditableImage = asset.type === AssetTypeEnum.Image && !isUnsupportedEditorMedia;
  const isEditableVideo = asset.type === AssetTypeEnum.Video && !isUnsupportedEditorMedia;

  const Edit: ActionItem = {
    title: $t('editor'),
    icon: mdiTune,
    $if: () => !sharedLink && isOwner && !asset.isTrashed && (isEditableImage || isEditableVideo),
    onAction: () => assetViewerManager.openEditor(),
    shortcuts: [{ key: 'e' }],
  };

  const SetProfilePicture: ActionItem = {
    title: $t('set_as_profile_picture'),
    icon: mdiAccountCircleOutline,
    // Profile pictures are shown to every account, so only the owner's own photo may become one.
    $if: () => isOwner && asset.type === AssetTypeEnum.Image && asset.visibility !== AssetVisibility.Locked,
    onAction: () => modalManager.show(ProfileImageCropperModal, { asset }),
  };

  const ViewInTimeline: ActionItem = {
    title: $t('view_in_timeline'),
    icon: mdiImageSearch,
    $if: () => isOwner && asset.visibility !== AssetVisibility.Locked && !asset.isArchived && !asset.isTrashed,
    onAction: () => goto(Route.photos({ at: asset.stackPrimaryAssetId ?? asset.id })),
  };

  const ViewSimilar: ActionItem = {
    title: $t('view_similar_photos'),
    icon: mdiCompare,
    $if: () =>
      asset.visibility !== AssetVisibility.Locked && !asset.isArchived && !asset.isTrashed && smartSearchEnabled,
    onAction: () => goto(Route.search({ queryAssetId: asset.stackPrimaryAssetId ?? asset.id })),
  };

  /**
   * FL-35: "View on map" from the viewer's Go to group. The map route centres on the
   * asset's own coordinates, so it is hidden when the asset has none.
   */
  const ViewOnMap: ActionItem = {
    title: $t('frameleaf_viewer_view_on_map'),
    icon: mdiMapMarkerOutline,
    $if: () =>
      typeof asset.exifInfo?.latitude === 'number' &&
      typeof asset.exifInfo?.longitude === 'number' &&
      asset.visibility !== AssetVisibility.Locked,
    onAction: () => goto(Route.map({ zoom: 14, lat: asset.exifInfo!.latitude!, lng: asset.exifInfo!.longitude! })),
  };

  /**
   * FL-35: "Show in folder". Also the relink target of the offline banner — it takes the
   * owner to the folder the original was last recorded in so the library path can be fixed.
   */
  const ShowInFolder: ActionItem = {
    title: $t('frameleaf_viewer_show_in_folder'),
    icon: mdiFolderOpenOutline,
    $if: () =>
      isOwner &&
      !sharedLink &&
      authManager.authenticated &&
      authManager.preferences.folders.enabled &&
      !!folderOf(asset.originalPath),
    onAction: () => goto(Route.folders({ path: folderOf(asset.originalPath) ?? undefined })),
  };

  /**
   * FL-35: the filmstrip is a client-only viewer preference; the viewer renders it only
   * when its caller supplied a real list of neighbours.
   */
  const ToggleFilmstrip: ActionItem = {
    title: get(showFilmstrip) ? $t('frameleaf_viewer_hide_filmstrip') : $t('frameleaf_viewer_show_filmstrip'),
    icon: mdiFilmstrip,
    onAction: () => showFilmstrip.update((value) => !value),
    shortcuts: [{ key: 'f', shift: true }],
  };

  /**
   * FL-35: a panorama opens in the photo-sphere viewer. This switches between looking
   * around it and seeing the flat frame, and is hidden for anything that is not a panorama.
   */
  const PanoramaLookAround: ActionItem = {
    title: assetViewerManager.isPanoramaFlattened
      ? $t('frameleaf_viewer_look_around_panorama')
      : $t('frameleaf_viewer_fit_panorama'),
    icon: assetViewerManager.isPanoramaFlattened ? mdiPanorama : mdiPanoramaVariantOutline,
    $if: () => isPanorama(asset),
    onAction: () => assetViewerManager.togglePanoramaView(),
  };

  const RefreshFacesJob: ActionItem = {
    title: $t('refresh_faces'),
    icon: mdiHeadSyncOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RefreshFaces, assetIds: [asset.id] }),
  };

  const RefreshMetadataJob: ActionItem = {
    title: $t('refresh_metadata'),
    icon: mdiDatabaseRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RefreshMetadata, assetIds: [asset.id] }),
  };

  const RegenerateThumbnailJob: ActionItem = {
    title: $t('refresh_thumbnails'),
    icon: mdiImageRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RegenerateThumbnail, assetIds: [asset.id] }),
  };

  const TranscodeVideoJob: ActionItem = {
    title: $t('refresh_encoded_videos'),
    icon: mdiCogRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.TranscodeVideo, assetIds: [asset.id] }),
    $if: () => asset.type === AssetTypeEnum.Video,
  };

  return {
    Share,
    Download,
    DownloadOriginal,
    SharedLinkDownload,
    SendCopy,
    Offline,
    Info,
    Favorite,
    Unfavorite,
    PlayMotionPhoto,
    StopMotionPhoto,
    PlaySlideshow,
    AddToAlbum,
    RemoveFromAlbum,
    ZoomIn,
    ZoomOut,
    Copy,
    Tag,
    TagPeople,
    Edit,
    SetProfilePicture,
    ViewInTimeline,
    ViewSimilar,
    ViewOnMap,
    ShowInFolder,
    ToggleFilmstrip,
    PanoramaLookAround,
    RefreshFacesJob,
    RefreshMetadataJob,
    RegenerateThumbnailJob,
    TranscodeVideoJob,
  };
};

export const handleDownloadAsset = async (asset: AssetResponseDto, { edited }: { edited: boolean }) => {
  const assets: { filename: string; id: string; size?: number }[] = [
    {
      filename: asset.originalFileName,
      id: asset.id,
      size: asset.exifInfo?.fileSizeInByte ?? undefined,
    },
  ];

  const isAndroidMotionVideo = (asset: AssetResponseDto) => {
    return asset.originalPath.includes('encoded-video');
  };

  if (asset.livePhotoVideoId) {
    const motionAsset = await getAssetInfo({ ...authManager.params, id: asset.livePhotoVideoId });
    if (
      !isAndroidMotionVideo(motionAsset) ||
      (authManager.authenticated && authManager.preferences.download.includeEmbeddedVideos)
    ) {
      const motionFilename = motionAsset.originalFileName;
      const lastDotIndex = motionFilename.lastIndexOf('.');
      const motionDownloadFilename =
        lastDotIndex > 0
          ? `${motionFilename.slice(0, lastDotIndex)}-motion${motionFilename.slice(lastDotIndex)}`
          : `${motionFilename}-motion`;
      assets.push({
        filename: motionDownloadFilename,
        id: asset.livePhotoVideoId,
        size: motionAsset.exifInfo?.fileSizeInByte ?? undefined,
      });
    }
  }

  // A public share's lightbox saves the file directly (PublicViewer.jsx:508-517).
  if (authManager.isSharedLink) {
    for (const [index, { filename, id }] of assets.entries()) {
      if (index > 0) {
        // Play nice with Safari, which drops a second download started in the same tick.
        await sleep(500);
      }
      downloadUrl(getAssetMediaUrl({ id, size: AssetMediaSize.Original, edited }), filename);
    }
    return;
  }

  // FL-45 D-3: each file is its own row in the download panel, with progress, Cancel and Retry,
  // and is saved from there (UploadPanel.jsx `DownloadPanel`).
  for (const { filename, id, size } of assets) {
    downloadAssetFile({ id, filename, edited, size });
  }
};

const handleFavorite = async (asset: AssetResponseDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { isFavorite: true } });
    toastManager.primary($t('added_to_favorites'));
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: asset.isFavorite } }));
  }
};

const handleUnfavorite = async (asset: AssetResponseDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { isFavorite: false } });
    toastManager.primary($t('removed_from_favorites'));
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: asset.isFavorite } }));
  }
};

const handleRemoveAssetsFromAlbum = async (assetIds: string[], album: AlbumResponseDto) => {
  const $t = await getFormatter();

  try {
    const results = await removeAssetFromAlbum({
      id: album.id,
      bulkIdsDto: { ids: assetIds },
    });

    const count = results.filter(({ success }) => success).length;

    toastManager.primary($t('assets_removed_count', { values: { count } }));
    eventManager.emit('AlbumRemoveAssets', { assetIds, albumIds: [album.id] });
  } catch (error) {
    handleError(error, $t('errors.error_removing_assets_from_album'));
  }
};

const getAssetJobMessage = ($t: MessageFormatter, job: AssetJobName) => {
  const messages: Record<AssetJobName, string> = {
    [AssetJobName.RefreshFaces]: $t('refreshing_faces'),
    [AssetJobName.RefreshMetadata]: $t('refreshing_metadata'),
    [AssetJobName.RefreshOcr]: $t('frameleaf_documents_reading_again'),
    [AssetJobName.RegenerateThumbnail]: $t('regenerating_thumbnails'),
    [AssetJobName.TranscodeVideo]: $t('refreshing_encoded_video'),
  };

  return messages[job];
};

const handleRunAssetJob = async (dto: AssetJobsDto) => {
  const $t = await getFormatter();

  try {
    await runAssetJobs({ assetJobsDto: dto });
    toastManager.primary(getAssetJobMessage($t, dto.name));
  } catch (error) {
    handleError(error, $t('errors.unable_to_submit_job'));
  }
};
