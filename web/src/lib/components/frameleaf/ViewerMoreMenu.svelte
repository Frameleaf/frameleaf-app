<script lang="ts">
  /**
   * The Frameleaf viewer's complete "More" menu (FL-35).
   *
   * The grouping, the hiding rules and the labels live in `$lib/frameleaf/viewer-menu`, ported from
   * the approved template (`media-viewer.mjs` `viewerActionGroups` and the Viewer group of
   * `MediaViewer.jsx:1215-1282`). Every entry below is an existing production action — an
   * `ActionItem` from `asset.service` / `album.service` / `app.service`, or one of the
   * `asset-viewer/actions` components — so nothing here introduces a new endpoint. A group whose
   * entries are all unsupported in the current context is dropped along with its heading.
   *
   * "Album cover" outside an album the user may change and "Featured photo for person" open the
   * template's chooser (`ViewerChooserDialog`, audit V-9) over the albums that hold the item and the
   * people tagged in it.
   */
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import AddToStackAction from '$lib/components/asset-viewer/actions/AddToStackAction.svelte';
  import ArchiveAction from '$lib/components/asset-viewer/actions/ArchiveAction.svelte';
  import {
    confirmAndDeletePermanently,
    restoreFromTrash,
  } from '$lib/components/asset-viewer/actions/delete-permanently';
  import KeepThisDeleteOthersAction from '$lib/components/asset-viewer/actions/KeepThisDeleteOthers.svelte';
  import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/RemoveAssetFromStack.svelte';
  import SetStackPrimaryAsset from '$lib/components/asset-viewer/actions/SetStackPrimaryAsset.svelte';
  import SetVisibilityAction from '$lib/components/asset-viewer/actions/SetVisibilityAction.svelte';
  import UnstackAction from '$lib/components/asset-viewer/actions/UnstackAction.svelte';
  import ViewerChooserDialog, { type ViewerChooserPick } from '$lib/components/frameleaf/ViewerChooserDialog.svelte';
  import ViewerMenuGroupLabel from '$lib/components/frameleaf/ViewerMenuGroupLabel.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { canSendCopies, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import { folderOf } from '$lib/frameleaf/viewer-headline';
  import { isImageAsset, isVideoAsset } from '$lib/frameleaf/viewer-media';
  import {
    viewerMenuChooser,
    viewerMenuGroups,
    viewerMenuLabelKey,
    type ViewerActionId,
    type ViewerMenuContext,
    type ViewerMenuGroup,
  } from '$lib/frameleaf/viewer-menu';
  import { showFilmstrip } from '$lib/frameleaf/viewer-preferences';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { castManager, CastDestinationType } from '$lib/managers/cast-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getAlbumAssetActions } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { getAssetActions } from '$lib/services/asset.service';
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getSharedLink } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AlbumUserRole,
    AssetVisibility,
    getAllAlbums,
    updatePerson,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { modalManager, toastManager, type ActionItem } from '@immich/ui';
  import {
    mdiAccountCircleOutline,
    mdiCogOutline,
    mdiDeleteForeverOutline,
    mdiDeleteRestore,
    mdiImageAlbum,
    mdiMovieOpenOutline,
    mdiPause,
    mdiPlayCircleOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    album?: AlbumResponseDto;
    stack?: StackResponseDto | null;
    preAction: PreAction;
    onAction: OnAction;
    /** The viewer can move to another item, so the slideshow and filmstrip are meaningful. */
    canNavigateCollection?: boolean;
    /** The caller supplied a real list of neighbours for a filmstrip. */
    canShowFilmstrip?: boolean;
  };

  let {
    asset,
    album,
    stack = null,
    preAction,
    onAction,
    canNavigateCollection = false,
    canShowFilmstrip = false,
  }: Props = $props();

  const sharedLink = getSharedLink();
  const { slideshowState } = slideshowStore;
  const Actions = $derived(getAssetActions($t, { ...asset, stackPrimaryAssetId: stack?.primaryAssetId }, album));
  const { Cast } = $derived(getGlobalActions($t));

  const userId = $derived(authManager.authenticated ? authManager.user.id : undefined);
  const isOwner = $derived(!!userId && asset.ownerId === userId);

  /** Albums a user may change: their own, or one shared with them as an editor (`Permission.AlbumUpdate`). */
  const canEditAlbum = (candidate: AlbumResponseDto) =>
    !!userId &&
    candidate.albumUsers.some(
      ({ user, role }) => user.id === userId && (role === AlbumUserRole.Owner || role === AlbumUserRole.Editor),
    );

  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);
  const contextAlbumEditable = $derived(!!album && (isOwner || canEditAlbum(album)));
  const contextAlbumCover = $derived(!!album && canEditAlbum(album));

  /**
   * The albums that hold this item and whose cover the user may set, for the album chooser. They are
   * read only when the chooser could be offered (a still that is not Locked, outside an album the user
   * may change), after the viewer settles on the item, so stepping through a slideshow reads nothing.
   */
  let coverAlbums = $state<AlbumResponseDto[]>([]);
  $effect(() => {
    const id = asset.id;
    coverAlbums = [];
    if (!userId || sharedLink || !isImageAsset(asset) || isLocked || asset.isTrashed || contextAlbumCover) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      getAllAlbums({ assetId: id })
        .then((albums) => {
          if (!cancelled && asset.id === id) {
            coverAlbums = albums.filter((candidate) => canEditAlbum(candidate));
          }
        })
        .catch(() => {
          // The entry stays hidden; nothing was changed.
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  /** The people tagged in the item, named and not hidden: the person chooser's rows. */
  const taggedPeople = $derived(
    (asset.people ?? []).filter((candidate) => !!candidate.name && !candidate.isHidden) as PersonResponseDto[],
  );

  const context: ViewerMenuContext = $derived({
    isVideo: isVideoAsset(asset),
    isImage: isImageAsset(asset),
    isOwner,
    isTrashed: asset.isTrashed,
    isLocked,
    isArchived: asset.isArchived,
    isEdited: asset.isEdited,
    isSharedLink: !!sharedLink,
    canDownload: authManager.authenticated,
    canSendCopy: canSendCopies() && sendCopyPermitted(),
    canCopyImage: assetViewerManager.canCopyImage(),
    hasStack: !!stack,
    stackSize: stack?.assets.length ?? 0,
    isStackPrimary: !!stack && stack.primaryAssetId === asset.id,
    hasAlbumContext: !!album,
    canEditAlbum: contextAlbumEditable,
    canSetAlbumCover: contextAlbumCover,
    albumCoverChoices: coverAlbums.length,
    peopleChoices: taggedPeople.length,
    hasOriginalPath: !!folderOf(asset.originalPath),
    hasCoordinates: typeof asset.exifInfo?.latitude === 'number' && typeof asset.exifInfo?.longitude === 'number',
    hasCastDestination:
      castManager.availableDestinations.length > 0 &&
      castManager.availableDestinations[0].type === CastDestinationType.GCAST,
    smartSearchEnabled: featureFlagsManager.value.smartSearch,
    foldersEnabled: authManager.authenticated && authManager.preferences.folders.enabled,
    canNavigateCollection,
    canShowFilmstrip,
    filmstripShown: $showFilmstrip,
    slideshowPlaying: $slideshowState === SlideshowState.PlaySlideshow,
  });

  const groups: ViewerMenuGroup[] = $derived(viewerMenuGroups(context));

  const has = (group: ViewerMenuGroup, id: ViewerActionId) => group.items.includes(id);
  const label = (id: ViewerActionId) => $t(viewerMenuLabelKey(id, context));
  const run = (action: ActionItem) => action.onAction(action);

  const setAlbumCover = (target: AlbumResponseDto) => run(getAlbumAssetActions($t, target, asset).SetCover);

  const setPersonFeatured = async (target: PersonResponseDto) => {
    try {
      const updated = await updatePerson({ id: target.id, personUpdateDto: { featureFaceAssetId: asset.id } });
      onAction({ type: AssetAction.SET_PERSON_FEATURED_PHOTO, asset, person: { ...target, ...updated } });
      toastManager.primary($t('feature_photo_updated'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_feature_photo'));
    }
  };

  const choose = async (id: 'set-album-cover' | 'set-person-featured') => {
    const kind = viewerMenuChooser(id, context);
    if (kind === null && album) {
      await setAlbumCover(album);
      return;
    }
    const pick: ViewerChooserPick | undefined = await modalManager.show(ViewerChooserDialog, {
      kind: kind ?? 'album',
      albums: coverAlbums,
      people: taggedPeople,
    });
    if (pick?.kind === 'album') {
      await setAlbumCover(pick.album);
    } else if (pick?.kind === 'person') {
      await setPersonFeatured(pick.person);
    }
  };

  const toggleSlideshow = () =>
    slideshowState.set(
      $slideshowState === SlideshowState.PlaySlideshow ? SlideshowState.PauseSlideshow : SlideshowState.PlaySlideshow,
    );

  // The settings return focus to the footer's cog, as closing them does in the template (MediaViewer.jsx:740-744).
  const openSlideshowSettings = () =>
    slideshowStore.openSettings(
      document.querySelector<HTMLElement>('[data-testid="viewer-footer"] [data-slideshow-settings]'),
    );
</script>

{#each groups as group, index (group.id)}
  <ViewerMenuGroupLabel text={$t(group.labelKey)} divided={index > 0} />

  {#if has(group, 'download')}
    <MenuOption icon={Actions.Download.icon} text={label('download')} onClick={() => run(Actions.Download)} />
  {/if}
  {#if has(group, 'download-original')}
    <MenuOption
      icon={Actions.DownloadOriginal.icon}
      text={label('download-original')}
      onClick={() => run(Actions.DownloadOriginal)}
    />
  {/if}
  {#if has(group, 'send-copy')}
    <MenuOption icon={Actions.SendCopy.icon} text={label('send-copy')} onClick={() => run(Actions.SendCopy)} />
  {/if}
  {#if has(group, 'copy-image')}
    <MenuOption icon={Actions.Copy.icon} text={label('copy-image')} onClick={() => run(Actions.Copy)} />
  {/if}

  {#if has(group, 'restore')}
    <MenuOption icon={mdiDeleteRestore} text={label('restore')} onClick={() => restoreFromTrash({ asset, onAction })} />
  {/if}
  {#if has(group, 'delete-permanently')}
    <MenuOption
      icon={mdiDeleteForeverOutline}
      text={label('delete-permanently')}
      textColor="text-[var(--fl-danger)]"
      onClick={() => confirmAndDeletePermanently({ asset, preAction, onAction })}
    />
  {/if}

  {#if has(group, 'add-to-album')}
    <MenuOption icon={Actions.AddToAlbum.icon} text={label('add-to-album')} onClick={() => run(Actions.AddToAlbum)} />
  {/if}
  {#if has(group, 'remove-from-album')}
    <MenuOption
      icon={Actions.RemoveFromAlbum.icon}
      text={label('remove-from-album')}
      onClick={() => run(Actions.RemoveFromAlbum)}
    />
  {/if}
  {#if has(group, 'archive') || has(group, 'unarchive')}
    <ArchiveAction {asset} {onAction} {preAction} />
  {/if}
  {#if has(group, 'set-visibility-locked')}
    <SetVisibilityAction asset={toTimelineAsset(asset)} {onAction} {preAction} />
  {/if}

  {#if has(group, 'add-to-stack')}
    <AddToStackAction {asset} {stack} {onAction} text={label('add-to-stack')} />
  {/if}
  {#if has(group, 'unstack') && stack}
    <UnstackAction {stack} {onAction} text={label('unstack')} />
  {/if}
  {#if has(group, 'stack-keep-this') && stack}
    <KeepThisDeleteOthersAction {stack} {asset} {onAction} text={label('stack-keep-this')} />
  {/if}
  {#if has(group, 'stack-set-primary') && stack}
    <SetStackPrimaryAsset {stack} {asset} {onAction} text={label('stack-set-primary')} />
  {/if}
  {#if has(group, 'stack-remove-this') && stack}
    <RemoveAssetFromStack {asset} {stack} {onAction} text={label('stack-remove-this')} />
  {/if}

  {#if has(group, 'set-album-cover')}
    <MenuOption icon={mdiImageAlbum} text={label('set-album-cover')} onClick={() => choose('set-album-cover')} />
  {/if}
  {#if has(group, 'set-person-featured')}
    <MenuOption
      icon={mdiAccountCircleOutline}
      text={label('set-person-featured')}
      onClick={() => choose('set-person-featured')}
    />
  {/if}
  {#if has(group, 'set-profile-picture')}
    <MenuOption
      icon={Actions.SetProfilePicture.icon}
      text={label('set-profile-picture')}
      onClick={() => run(Actions.SetProfilePicture)}
    />
  {/if}

  {#if has(group, 'view-in-timeline')}
    <MenuOption
      icon={Actions.ViewInTimeline.icon}
      text={label('view-in-timeline')}
      onClick={() => run(Actions.ViewInTimeline)}
    />
  {/if}
  {#if has(group, 'find-similar')}
    <MenuOption icon={Actions.ViewSimilar.icon} text={label('find-similar')} onClick={() => run(Actions.ViewSimilar)} />
  {/if}
  {#if has(group, 'view-on-map')}
    <MenuOption icon={Actions.ViewOnMap.icon} text={label('view-on-map')} onClick={() => run(Actions.ViewOnMap)} />
  {/if}
  {#if has(group, 'open-folder')}
    <MenuOption
      icon={Actions.ShowInFolder.icon}
      text={label('open-folder')}
      onClick={() => run(Actions.ShowInFolder)}
    />
  {/if}

  {#if has(group, 'refresh-faces')}
    <MenuOption
      icon={Actions.RefreshFacesJob.icon}
      text={label('refresh-faces')}
      onClick={() => run(Actions.RefreshFacesJob)}
    />
  {/if}
  {#if has(group, 'refresh-metadata')}
    <MenuOption
      icon={Actions.RefreshMetadataJob.icon}
      text={label('refresh-metadata')}
      onClick={() => run(Actions.RefreshMetadataJob)}
    />
  {/if}
  {#if has(group, 'refresh-thumbnails')}
    <MenuOption
      icon={Actions.RegenerateThumbnailJob.icon}
      text={label('refresh-thumbnails')}
      onClick={() => run(Actions.RegenerateThumbnailJob)}
    />
  {/if}
  {#if has(group, 'refresh-encoded')}
    <MenuOption
      icon={Actions.TranscodeVideoJob.icon}
      text={label('refresh-encoded')}
      onClick={() => run(Actions.TranscodeVideoJob)}
    />
  {/if}
  {#if has(group, 'transcode')}
    <!-- The template's "Transcode video" queues the same encode job as "Refresh encoded video" (App.jsx:1207-1209). -->
    <MenuOption icon={mdiMovieOpenOutline} text={label('transcode')} onClick={() => run(Actions.TranscodeVideoJob)} />
  {/if}

  {#if has(group, 'tag-people')}
    <MenuOption icon={Actions.TagPeople.icon} text={label('tag-people')} onClick={() => run(Actions.TagPeople)} />
  {/if}
  {#if has(group, 'cast')}
    <MenuOption icon={Cast.icon} text={label('cast')} onClick={() => run(Cast)} />
  {/if}
  {#if has(group, 'toggle-filmstrip')}
    <MenuOption
      icon={Actions.ToggleFilmstrip.icon}
      text={label('toggle-filmstrip')}
      onClick={() => showFilmstrip.update((value) => !value)}
    />
  {/if}
  {#if has(group, 'play-slideshow')}
    <MenuOption
      icon={context.slideshowPlaying ? mdiPause : mdiPlayCircleOutline}
      text={label('play-slideshow')}
      onClick={toggleSlideshow}
    />
  {/if}
  {#if has(group, 'slideshow-settings')}
    <MenuOption icon={mdiCogOutline} text={label('slideshow-settings')} onClick={openSlideshowSettings} />
  {/if}
{/each}
