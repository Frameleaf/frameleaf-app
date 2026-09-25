<script lang="ts">
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import DeleteAction from '$lib/components/asset-viewer/actions/DeleteAction.svelte';
  import RatingAction from '$lib/components/asset-viewer/actions/RatingAction.svelte';
  import ViewerMoreMenu from '$lib/components/frameleaf/ViewerMoreMenu.svelte';
  import ViewerTitle from '$lib/components/frameleaf/ViewerTitle.svelte';
  import LoadingDots from '$lib/components/LoadingDots.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import { getGlobalActions } from '$lib/services/app.service';
  import { getAssetActions } from '$lib/services/asset.service';
  import { getSharedLink, withoutIcons } from '$lib/utils';
  import type { OnUndoDelete } from '$lib/utils/actions';
  import {
    AssetTypeEnum,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, Tooltip, type ActionItem } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiDotsHorizontal, mdiVideoOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    album?: AlbumResponseDto;
    person?: PersonResponseDto | null;
    stack?: StackResponseDto | null;
    preAction: PreAction;
    onAction: OnAction;
    onUndoDelete?: OnUndoDelete;
    onClose?: () => void;
    isPlayingOriginalVideo: boolean;
    setPlayOriginalVideo: (value: boolean) => void;
    /** FL-35: the viewer has a neighbour, so the slideshow and filmstrip are meaningful. */
    canNavigateCollection?: boolean;
    /** FL-35: the caller supplied a real list of neighbours for the filmstrip. */
    canShowFilmstrip?: boolean;
  }

  let {
    asset,
    album,
    person = null,
    stack = null,
    preAction,
    onAction,
    onUndoDelete = undefined,
    onClose,
    isPlayingOriginalVideo = false,
    setPlayOriginalVideo,
    canNavigateCollection = false,
    canShowFilmstrip = false,
  }: Props = $props();

  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);

  const { Cast } = $derived(getGlobalActions($t));

  const Close: ActionItem = $derived({
    title: $t('frameleaf_viewer_close'),
    icon: languageManager.rtl ? mdiArrowRight : mdiArrowLeft,
    $if: () => !!onClose && !assetViewerManager.isFaceEditMode,
    onAction: () => onClose?.(),
    shortcuts: [{ key: 'Escape' }],
  });

  const PlayOriginalVideo: ActionItem = $derived({
    title: isPlayingOriginalVideo ? $t('play_transcoded_video') : $t('play_original_video'),
    icon: mdiVideoOutline,
    $if: () => asset.type === AssetTypeEnum.Video,
    onAction: () => setPlayOriginalVideo(!isPlayingOriginalVideo),
  });

  const Actions = $derived(getAssetActions($t, { ...asset, stackPrimaryAssetId: stack?.primaryAssetId }, album));
  const sharedLink = getSharedLink();

  /**
   * A shared link's viewer has no More menu, so its one slideshow entry point sits in the bar itself
   * (FL-83; `action:viewer:slideshow-play-pause-previous-next-repeat-shuffle`). It keeps the gate the
   * old public header had: only when the link allows downloads, and only with something to move to.
   */
  const SharedLinkSlideshow: ActionItem = $derived({
    ...Actions.PlaySlideshow,
    $if: () => !!sharedLink?.allowDownload && canNavigateCollection && (Actions.PlaySlideshow.$if?.() ?? true),
  });
</script>

<CommandPaletteDefaultProvider
  name={$t('assets')}
  actions={withoutIcons([Close, Cast, PlayOriginalVideo, ...Object.values(Actions)])}
/>

<!--
  FL-35: the frosted viewer header (apple-style.css:383-403, 504-507). The actions follow the template's
  top row (MediaViewer.jsx:1023-1200): Share, Cast, Copy image (wide screens only), Information,
  Favorite, Rating, Edit, Trash and More. The legacy Offline button is gone (audit V-6): the offline
  banner explains a missing original. Zoom lives in the footer, as in the template (ViewerFooter,
  MediaViewer.jsx:1765-1790). On phones the actions leave the header for a frosted bottom toolbar
  above the footer, like iPhone Photos (apple-style.css:756-790).
-->
<div class="fl-viewer-header">
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <div class="dark shrink-0">
      <ActionButton action={Close} />
    </div>

    <!-- FL-35: file name with the short EXIF line underneath. -->
    <ViewerTitle {asset} />
  </div>

  <div class="fl-viewer-toolbar">
    <div
      class="fl-viewer-actions dark"
      role="toolbar"
      aria-label={$t('frameleaf_viewer_actions')}
      data-testid="asset-viewer-navbar-actions"
    >
      {#if assetViewerManager.isImageLoading}
        <Tooltip text={$t('loading')}>
          {#snippet child({ props })}
            <div {...props} role="status" aria-label={$t('loading')}>
              <LoadingDots class="me-1" />
            </div>
          {/snippet}
        </Tooltip>
      {/if}
      <ActionButton action={Actions.Share} />
      <ActionButton action={Cast} />
      <span class="fl-wide-only">
        <ActionButton action={Actions.Copy} />
      </span>
      <ActionButton action={Actions.PlayMotionPhoto} />
      <ActionButton action={Actions.StopMotionPhoto} />
      {#if sharedLink}
        <!-- A shared link has no More menu, so its download and its copy through the share sheet sit here. -->
        <ActionButton action={Actions.SharedLinkDownload} />
        <ActionButton action={Actions.SendCopy} />
        <ActionButton action={SharedLinkSlideshow} />
      {/if}
      <ActionButton action={Actions.Info} />
      <ActionButton action={Actions.Favorite} />
      <ActionButton action={Actions.Unfavorite} />

      {#if isOwner}
        <RatingAction {asset} {onAction} />
      {/if}

      <ActionButton action={Actions.Edit} />

      {#if isOwner}
        <DeleteAction {asset} {onAction} {preAction} {onUndoDelete} />
      {/if}

      {#if !sharedLink}
        <ButtonContextMenu
          direction="left"
          align="top-right"
          color="secondary"
          title={$t('frameleaf_viewer_more_actions')}
          icon={mdiDotsHorizontal}
        >
          <!--
            FL-35: the complete grouped menu (Download, Organize, Stack, Set as, Go to, Jobs,
            Viewer). Every entry maps to an existing asset action and a group that has no
            supported entry in this context is not rendered at all.
          -->
          <ViewerMoreMenu
            {asset}
            {album}
            {person}
            {stack}
            {preAction}
            {onAction}
            {canNavigateCollection}
            {canShowFilmstrip}
            playOriginalVideo={PlayOriginalVideo}
          />
        </ButtonContextMenu>
      {/if}
    </div>
  </div>
</div>

<style>
  .fl-viewer-header {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 64px;
    padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px
      max(12px, env(safe-area-inset-left));
    border-bottom: 1px solid #ffffff14;
    color: #fff;
  }

  /*
   * The frosted material lives on a pseudo-element: backdrop-filter on the header itself would make it
   * the containing block of the fixed phone toolbar and of the More menu (apple-style.css:785-789).
   */
  .fl-viewer-header::before,
  .fl-viewer-toolbar::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: #1c1c1e99;
    backdrop-filter: var(--fl-material-blur);
  }

  .fl-viewer-toolbar {
    display: contents;
  }

  .fl-viewer-toolbar::before {
    content: none;
  }

  .fl-viewer-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: -4px;
    padding: 4px;
    overflow-x: auto;
  }

  .fl-viewer-actions > :global(*) {
    flex-shrink: 0;
  }

  .fl-wide-only {
    display: contents;
  }

  @media (max-width: 760px) {
    .fl-viewer-header {
      gap: 8px;
      padding-inline: max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right));
    }

    .fl-wide-only {
      display: none;
    }
  }

  /* Phones: the actions become a bottom toolbar, like iPhone Photos (apple-style.css:756-790). */
  @media (max-width: 700px) {
    .fl-viewer-toolbar {
      position: fixed;
      inset-inline: 0;
      /* Above the 60px footer (apple-style.css:760-763). */
      bottom: calc(60px + env(safe-area-inset-bottom));
      z-index: 3;
      isolation: isolate;
      display: block;
      padding: 4px max(8px, env(safe-area-inset-right)) 4px max(8px, env(safe-area-inset-left));
      border-top: 1px solid #ffffff14;
      transition:
        opacity 260ms ease,
        translate 420ms var(--fl-spring);
    }

    .fl-viewer-toolbar::before {
      content: '';
    }

    .fl-viewer-actions {
      justify-content: space-around;
      margin: 0;
      padding: 0;
    }

    :global(.chrome-hidden) .fl-viewer-toolbar {
      opacity: 0;
      translate: 0 12px;
      pointer-events: none;
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-header::before,
    .fl-viewer-toolbar::before {
      background: #1c1c1e;
      backdrop-filter: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fl-viewer-toolbar {
      transition: opacity 150ms ease;
    }

    :global(.chrome-hidden) .fl-viewer-toolbar {
      translate: none;
    }
  }
</style>
