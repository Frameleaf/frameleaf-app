<script lang="ts">
  import { matchesShortcut, shouldIgnoreEvent } from '$lib/actions/shortcut';
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
  import { getSharedLink } from '$lib/utils';
  import type { OnUndoDelete } from '$lib/utils/actions';
  import {
    AssetTypeEnum,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { ActionButton, isModalOpen, Tooltip, type ActionItem } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiDotsVertical, mdiVideoOutline } from '@mdi/js';
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
    $if: () => !!onClose && !assetViewerManager.isFaceEditMode && !assetViewerManager.isEditFacesPanelOpen,
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
   * The viewer's action keys (I, Escape, F, Shift+D, L, T, P, E, Shift+F, ...). These used to be
   * dispatched by the upstream command palette, which FL-83 disabled; the viewer now dispatches
   * its own actions with the same rules (first enabled match wins, skipped while a modal is open,
   * inside text fields, or when the key was already handled).
   */
  const viewerActions = $derived([Close, Cast, PlayOriginalVideo, ...Object.values(Actions)]);
  const onActionShortcut = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isModalOpen()) {
      return;
    }
    for (const action of viewerActions) {
      const shortcuts = action.shortcuts ? [action.shortcuts].flat() : [];
      if (shortcuts.every((shortcut) => !matchesShortcut(event, shortcut)) || (action.$if && !action.$if())) {
        continue;
      }
      const { ignoreInputFields = true, preventDefault = true } = action.shortcutOptions ?? {};
      if (ignoreInputFields && shouldIgnoreEvent(event)) {
        continue;
      }
      if (preventDefault) {
        event.preventDefault();
      }
      void action.onAction(action);
      return;
    }
  };
</script>

<!-- On body, like the palette listener it replaces, so it runs before the document-level handlers. -->
<svelte:body onkeydown={onActionShortcut} />

<div
  class="flex h-16 place-items-center justify-between gap-3 bg-linear-to-b from-black/40 px-3 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)] transition-transform duration-200"
>
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <div class="dark shrink-0">
      <ActionButton action={Close} />
    </div>

    <!-- FL-35: file name with the short EXIF line underneath. -->
    <ViewerTitle {asset} />
  </div>

  <div
    class="dark -m-1 flex items-center gap-2 overflow-x-auto p-1 *:shrink-0"
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
    <ActionButton action={Cast} />
    <ActionButton action={Actions.Share} />
    <ActionButton action={Actions.Offline} />
    <ActionButton action={Actions.ZoomIn} />
    <ActionButton action={Actions.ZoomOut} />
    <ActionButton action={Actions.PlayMotionPhoto} />
    <ActionButton action={Actions.StopMotionPhoto} />
    <ActionButton action={Actions.Copy} />
    <ActionButton action={Actions.SharedLinkDownload} />
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
        icon={mdiDotsVertical}
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
