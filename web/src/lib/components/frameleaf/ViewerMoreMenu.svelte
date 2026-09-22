<script lang="ts">
  /**
   * The Frameleaf viewer's complete "More" menu (FL-35).
   *
   * The grouping and the hiding rules live in `$lib/frameleaf/viewer-menu`, ported from the
   * approved template (`design/frameleaf/template/src/media-viewer.mjs`). Every entry below
   * is an existing production action — an `ActionItem` from `asset.service` / `album.service`
   * / `app.service`, or one of the `asset-viewer/actions` components — so nothing here
   * introduces a new endpoint. A group whose entries are all unsupported in the current
   * context is dropped along with its heading.
   */
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import AddToStackAction from '$lib/components/asset-viewer/actions/AddToStackAction.svelte';
  import ArchiveAction from '$lib/components/asset-viewer/actions/ArchiveAction.svelte';
  import KeepThisDeleteOthersAction from '$lib/components/asset-viewer/actions/KeepThisDeleteOthers.svelte';
  import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/RemoveAssetFromStack.svelte';
  import RestoreAction from '$lib/components/asset-viewer/actions/RestoreAction.svelte';
  import SetFeaturedPhotoAction from '$lib/components/asset-viewer/actions/SetPersonFeaturedAction.svelte';
  import SetStackPrimaryAsset from '$lib/components/asset-viewer/actions/SetStackPrimaryAsset.svelte';
  import SetVisibilityAction from '$lib/components/asset-viewer/actions/SetVisibilityAction.svelte';
  import UnstackAction from '$lib/components/asset-viewer/actions/UnstackAction.svelte';
  import ViewerMenuGroupLabel from '$lib/components/frameleaf/ViewerMenuGroupLabel.svelte';
  import MarkNsfwAction from '$lib/components/timeline/actions/MarkNsfwAction.svelte';
  import { folderOf } from '$lib/frameleaf/viewer-headline';
  import { isImageAsset, isPanorama, isVideoAsset } from '$lib/frameleaf/viewer-media';
  import { viewerMenuGroups, type ViewerActionId, type ViewerMenuGroup } from '$lib/frameleaf/viewer-menu';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { castManager, CastDestinationType } from '$lib/managers/cast-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getAlbumAssetActions } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { getAssetActions } from '$lib/services/asset.service';
  import { getSharedLink } from '$lib/utils';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetVisibility,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import type { ActionItem } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    album?: AlbumResponseDto;
    person?: PersonResponseDto | null;
    stack?: StackResponseDto | null;
    preAction: PreAction;
    onAction: OnAction;
    /** The viewer can move to another item, so the slideshow and filmstrip are meaningful. */
    canNavigateCollection?: boolean;
    /** The caller supplied a real list of neighbours for a filmstrip. */
    canShowFilmstrip?: boolean;
    playOriginalVideo: ActionItem;
  };

  let {
    asset,
    album,
    person = null,
    stack = null,
    preAction,
    onAction,
    canNavigateCollection = false,
    canShowFilmstrip = false,
    playOriginalVideo,
  }: Props = $props();

  const sharedLink = getSharedLink();
  const Actions = $derived(getAssetActions($t, { ...asset, stackPrimaryAssetId: stack?.primaryAssetId }, album));
  const { Cast } = $derived(getGlobalActions($t));

  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);
  const isAlbumOwner = $derived(!!album && authManager.authenticated && album.albumUsers[0]?.user.id === authManager.user.id);

  const groups: ViewerMenuGroup[] = $derived(
    viewerMenuGroups({
      isVideo: isVideoAsset(asset),
      isImage: isImageAsset(asset),
      isOwner,
      isTrashed: asset.isTrashed,
      isLocked: asset.visibility === AssetVisibility.Locked,
      isArchived: asset.isArchived,
      isEdited: asset.isEdited,
      isPanorama: isPanorama(asset),
      isLivePhoto: !!asset.livePhotoVideoId,
      isSharedLink: !!sharedLink,
      canDownload: authManager.authenticated,
      canCopyImage: assetViewerManager.canCopyImage(),
      hasStack: !!stack,
      stackSize: stack?.assets.length ?? 0,
      isStackPrimary: !!stack && stack.primaryAssetId === asset.id,
      hasAlbumContext: !!album,
      canEditAlbum: isOwner || isAlbumOwner,
      hasPersonContext: !!person,
      hasOriginalPath: !!folderOf(asset.originalPath),
      hasCoordinates: typeof asset.exifInfo?.latitude === 'number' && typeof asset.exifInfo?.longitude === 'number',
      hasCastDestination:
        castManager.availableDestinations.length > 0 &&
        castManager.availableDestinations[0].type === CastDestinationType.GCAST,
      smartSearchEnabled: featureFlagsManager.value.smartSearch,
      foldersEnabled: authManager.authenticated && authManager.preferences.folders.enabled,
      tagsEnabled: authManager.authenticated && authManager.preferences.tags.enabled,
      canNavigateCollection,
      canShowFilmstrip,
    }),
  );

  const has = (group: ViewerMenuGroup, id: ViewerActionId) => group.items.includes(id);
</script>

{#each groups as group, index (group.id)}
  <ViewerMenuGroupLabel text={$t(group.labelKey)} divided={index > 0} />

  {#if has(group, 'download')}
    <ActionMenuItem action={Actions.Download} />
  {/if}
  {#if has(group, 'download-original')}
    <ActionMenuItem action={Actions.DownloadOriginal} />
  {/if}
  {#if has(group, 'copy-image')}
    <ActionMenuItem action={Actions.Copy} />
  {/if}

  {#if has(group, 'restore')}
    <RestoreAction {asset} {onAction} />
  {/if}

  {#if has(group, 'add-to-album')}
    <ActionMenuItem action={Actions.AddToAlbum} />
  {/if}
  {#if has(group, 'remove-from-album')}
    <ActionMenuItem action={Actions.RemoveFromAlbum} />
  {/if}
  {#if has(group, 'archive') || has(group, 'unarchive')}
    <ArchiveAction {asset} {onAction} {preAction} />
  {/if}
  {#if has(group, 'mark-sensitive')}
    <MarkNsfwAction menuItem assetIds={[asset.id]} clearSelection={false} />
  {/if}
  {#if has(group, 'unmark-sensitive')}
    <MarkNsfwAction menuItem markSafe assetIds={[asset.id]} clearSelection={false} />
  {/if}
  {#if has(group, 'set-visibility-locked')}
    <SetVisibilityAction asset={toTimelineAsset(asset)} {onAction} {preAction} />
  {/if}
  {#if has(group, 'add-tag')}
    <ActionMenuItem action={Actions.Tag} />
  {/if}

  {#if has(group, 'add-to-stack')}
    <AddToStackAction {asset} {stack} {onAction} />
  {/if}
  {#if has(group, 'unstack') && stack}
    <UnstackAction {stack} {onAction} />
  {/if}
  {#if has(group, 'stack-keep-this') && stack}
    <KeepThisDeleteOthersAction {stack} {asset} {onAction} />
  {/if}
  {#if has(group, 'stack-set-primary') && stack}
    <SetStackPrimaryAsset {stack} {asset} {onAction} />
  {/if}
  {#if has(group, 'stack-remove-this') && stack}
    <RemoveAssetFromStack {asset} {stack} {onAction} />
  {/if}

  {#if has(group, 'set-album-cover') && album}
    {@const { SetCover } = getAlbumAssetActions($t, album, asset)}
    <ActionMenuItem action={SetCover} />
  {/if}
  {#if has(group, 'set-person-featured') && person}
    <SetFeaturedPhotoAction {asset} {person} {onAction} />
  {/if}
  {#if has(group, 'set-profile-picture')}
    <ActionMenuItem action={Actions.SetProfilePicture} />
  {/if}

  {#if has(group, 'view-in-timeline')}
    <ActionMenuItem action={Actions.ViewInTimeline} />
  {/if}
  {#if has(group, 'find-similar')}
    <ActionMenuItem action={Actions.ViewSimilar} />
  {/if}
  {#if has(group, 'view-on-map')}
    <ActionMenuItem action={Actions.ViewOnMap} />
  {/if}
  {#if has(group, 'open-folder')}
    <ActionMenuItem action={Actions.ShowInFolder} />
  {/if}

  {#if has(group, 'refresh-faces')}
    <ActionMenuItem action={Actions.RefreshFacesJob} />
  {/if}
  {#if has(group, 'refresh-metadata')}
    <ActionMenuItem action={Actions.RefreshMetadataJob} />
  {/if}
  {#if has(group, 'refresh-thumbnails')}
    <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
  {/if}
  {#if has(group, 'refresh-encoded')}
    <ActionMenuItem action={Actions.TranscodeVideoJob} />
  {/if}

  {#if has(group, 'tag-people')}
    <ActionMenuItem action={Actions.TagPeople} />
  {/if}
  {#if has(group, 'cast')}
    <ActionMenuItem action={Cast} />
  {/if}
  {#if has(group, 'play-original-video')}
    <ActionMenuItem action={playOriginalVideo} />
  {/if}
  {#if has(group, 'panorama-look-around')}
    <ActionMenuItem action={Actions.PanoramaLookAround} />
  {/if}
  {#if has(group, 'toggle-filmstrip')}
    <ActionMenuItem action={Actions.ToggleFilmstrip} />
  {/if}
  {#if has(group, 'play-slideshow')}
    <ActionMenuItem action={Actions.PlaySlideshow} />
  {/if}
{/each}
