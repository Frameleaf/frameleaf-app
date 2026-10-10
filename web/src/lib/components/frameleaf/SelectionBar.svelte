<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import BulkDateDialog from '$lib/components/frameleaf/BulkDateDialog.svelte';
  import BulkDescriptionDialog from '$lib/components/frameleaf/BulkDescriptionDialog.svelte';
  import BulkLocationDialog from '$lib/components/frameleaf/BulkLocationDialog.svelte';
  import BulkOperationStatus from '$lib/components/frameleaf/BulkOperationStatus.svelte';
  import BulkTagDialog from '$lib/components/frameleaf/BulkTagDialog.svelte';
  import PreservationExportDialog from '$lib/components/frameleaf/PreservationExportDialog.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import {
    bulkActionById,
    bulkActions,
    livePhotoPair,
    menuBulkActions,
    primaryBulkActions,
    selectedStackIds,
    type BulkAction,
    type BulkActionContext,
    type BulkActionId,
    type BulkAsset,
  } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { MODAL_SELECTOR } from '$lib/frameleaf/library-key-actions';
  import { isTypingTarget } from '$lib/frameleaf/library-shortcuts';
  import { selectionForPreservation } from '$lib/frameleaf/preservation';
  import { canSendCopies, sendCopiesWithFeedback, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
  import { SharedLinkType } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiArchiveArrowUpOutline,
    mdiArchiveOutline,
    mdiCalendarEdit,
    mdiClose,
    mdiDatabaseRefreshOutline,
    mdiDeleteForeverOutline,
    mdiDeleteOutline,
    mdiDeleteRestore,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiFaceRecognition,
    mdiHeart,
    mdiHeartOutline,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiLayersOutline,
    mdiLayersPlus,
    mdiLinkOff,
    mdiLinkVariant,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiMapMarkerOutline,
    mdiMotionPauseOutline,
    mdiMotionPlayOutline,
    mdiMovieEditOutline,
    mdiPackageVariantClosed,
    mdiPlaylistRemove,
    mdiShieldLockOutline,
    mdiShieldOutline,
    mdiTagPlusOutline,
    mdiTextBoxOutline,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { canAnimate, leave } from '$lib/frameleaf/motion';
  import type { SelectionBarLeadingAction } from '$lib/frameleaf/selection-bar';
  import type { CaptureTime } from '$lib/frameleaf/time-zones';

  /**
   * The bar's own icons, imported one by one. The whole Material catalogue is served as data to the
   * icon pickers; it is never bundled into the web client.
   */
  const ICONS: Record<string, string> = {
    mdiArchiveArrowUpOutline,
    mdiArchiveOutline,
    mdiCalendarEdit,
    mdiDatabaseRefreshOutline,
    mdiDeleteForeverOutline,
    mdiDeleteOutline,
    mdiDeleteRestore,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiFaceRecognition,
    mdiHeart,
    mdiHeartOutline,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiLayersOutline,
    mdiLayersPlus,
    mdiLinkOff,
    mdiLinkVariant,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiMapMarkerOutline,
    mdiMotionPauseOutline,
    mdiMotionPlayOutline,
    mdiMovieEditOutline,
    mdiPackageVariantClosed,
    mdiPlaylistRemove,
    mdiShieldLockOutline,
    mdiShieldOutline,
    mdiTagPlusOutline,
    mdiTextBoxOutline,
  };

  /**
   * The floating selection bar (FL-32), ported from `design/frameleaf/template/src/SelectionBar.jsx`.
   *
   * It owns presentation and payload collection only. Every action is handed to `onAction`, which
   * the library view binds to `runBulkAction`; the bar never runs an action itself, so there is
   * one place where an action is bound and one place where its failures are reported. The only read
   * it makes is the Add to album picker loading the album list it offers. The one exception is
   * "Send a copy…" (FL-35 / FL-54): the browser's share sheet, which changes nothing on the server
   * and must start from the click, so the bar hands the selection to `sendCopiesWithFeedback`.
   *
   * September 22, 2026 revision: the bar carries the complete bulk set, nothing is selected on
   * load, and "select everything matching" offers a scope-bound snapshot that runs in the
   * background with progress and cancellation.
   *
   * September 24 "one toolbar": while items are selected this bar takes the library bar's place
   * and carries the page's own actions (`leading`: Compare, Quick edit, Open in Studio) as labelled
   * buttons ahead of the bulk actions, which are icon-only and named in tooltips. It is a frosted
   * capsule over the photos (apple-style.css "#1 one toolbar"), and sits above the phone tab bar.
   */
  let {
    count = 0,
    /** Total matching the current scope, for the "Select all n" offer. Null while unknown. */
    total = null,
    /** The selected assets, when the view has them loaded. */
    assets = [],
    selectedIds = assets.map((asset) => asset.id),
    context = {},
    tagOptions = [],
    operations = [],
    /** The last completed action that can be reversed. */
    undoLabel,
    onAction,
    onUndo,
    onClear,
    onSelectAllMatching,
    onCancelOperation,
    onRetryOperation,
    onDismissOperation,
    leading = [],
    onDialogSettled,
    resolveCaptureTimes,
  }: {
    count?: number;
    total?: number | null;
    assets?: BulkAsset[];
    /** Explicit selection, including items outside the loaded timeline window. */
    selectedIds?: readonly string[];
    context?: Omit<BulkActionContext, 'assets' | 'count'>;
    tagOptions?: { id: string; name: string }[];
    operations?: BulkOperationRecord[];
    undoLabel?: string;
    onAction: (id: BulkActionId, payload?: BulkPayload) => void;
    onUndo?: () => void;
    onClear: () => void;
    onSelectAllMatching?: () => void;
    onCancelOperation?: (requestId: string) => void;
    onRetryOperation?: (operation: BulkOperationRecord) => void;
    onDismissOperation?: (requestId: string) => void;
    /** The page's own actions, labelled, ahead of the bulk actions (SelectionBar.jsx `leading`). */
    leading?: SelectionBarLeadingAction[];
    /** An action's dialog closed: submitted, or cancelled. */
    onDialogSettled?: (id: BulkActionId, submitted: boolean) => void;
    /** The selection's real capture times, for Change date (FL-32). */
    resolveCaptureTimes?: (ids: string[]) => Promise<Record<string, CaptureTime> | null>;
  } = $props();

  let menuOpen = $state(false);
  let dialog = $state<BulkActionId | null>(null);
  /** Bound to the open dialog, so closing it from inside clears the parent's choice too. */
  let dialogOpen = $state(false);
  let moreButton = $state<HTMLButtonElement | undefined>();
  let menu = $state<HTMLDivElement | undefined>();
  /** Where a tile's right-click opened the menu; null when it hangs from More. */
  let menuAt = $state<{ x: number; y: number } | null>(null);
  let returnFocus: HTMLElement | null = null;

  const menuId = $props.id();

  let open = $derived(count > 0);
  // The bar fades out after the selection is cleared; it keeps the last count until it is gone
  // rather than flashing "0 selected".
  let shownCount = $state(untrack(() => count));
  $effect(() => {
    if (count > 0) {
      shownCount = count;
    }
  });
  // The More menu leaves on the Pop exit: it stays mounted, inert, until the fade ends (Menu.svelte).
  let menuLeaving = $state(false);
  let cancelMenuLeave: (() => void) | undefined;
  let menuWasOpen = false;
  $effect.pre(() => {
    if (menuOpen) {
      cancelMenuLeave?.();
      cancelMenuLeave = undefined;
      menuLeaving = false;
      menuWasOpen = true;
      return;
    }
    if (!menuWasOpen) {
      return;
    }
    menuWasOpen = false;
    const node = untrack(() => menu);
    if (!canAnimate(node) || !node.isConnected) {
      return;
    }
    menuLeaving = true;
    cancelMenuLeave = leave(node, 'pop', () => (menuLeaving = false));
  });
  let trash = $derived(!!context.trash);
  let locked = $derived(!!context.locked);
  let actions = $derived(
    bulkActions({ canSendCopy: canSendCopies() && sendCopyPermitted(), ...context, assets, count }),
  );
  let byId = $derived(bulkActionById(actions));
  let primary = $derived(primaryBulkActions(actions, trash, locked));
  let menuGroups = $derived(menuBulkActions(actions, trash, locked));
  const icon = (name: string) => ICONS[name] ?? mdiDotsHorizontal;

  $effect(() => {
    if (open) {
      return;
    }

    menuOpen = false;
    dialog = null;
    dialogOpen = false;
  });

  /**
   * Actions that need a payload open their dialog; everything else is dispatched straight away.
   * Stack order and the Live Photo pair are derived here because only the bar knows the selection.
   */
  const perform = (id: BulkActionId) => {
    const action: BulkAction | undefined = byId[id];
    if (!action?.available) {
      return;
    }
    menuOpen = false;
    if (action.dialog || action.confirm) {
      dialog = id;
      dialogOpen = true;
      return;
    }
    if (id === 'send-copy') {
      // The one action the bar runs itself: the browser's share sheet, which changes nothing on the
      // server and has to start from this click (App.jsx:818-846 `sendCopy`).
      void sendCopiesWithFeedback(selectedIds);
      return;
    }
    if (id === 'unstack') {
      onAction(id, { stackIds: selectedStackIds(assets) });
      return;
    }
    if (id === 'link-live-photo') {
      const pair = livePhotoPair(assets);
      if (pair) {
        onAction(id, pair);
      }
      return;
    }
    if (id === 'stack') {
      onAction(id, { primaryId: assets[0]?.id });
      return;
    }
    if (id === 'remove-from-album' || id === 'set-album-cover') {
      if (context.albumId) {
        onAction(id, { albumId: context.albumId });
      }
      return;
    }
    if (id === 'remove-from-shared-link') {
      if (context.sharedLinkId) {
        onAction(id, { sharedLinkId: context.sharedLinkId });
      }
      return;
    }
    onAction(id);
  };

  const submitDialog = (id: BulkActionId, payload?: BulkPayload) => {
    dialog = null;
    dialogOpen = false;
    onDialogSettled?.(id, true);
    onAction(id, payload);
  };

  $effect(() => {
    if (dialogOpen || !dialog) {
      return;
    }
    const cancelled = dialog;
    dialog = null;
    untrack(() => onDialogSettled?.(cancelled, false));
  });

  const closeMenu = () => {
    menuOpen = false;
    (menuAt ? returnFocus : moreButton)?.focus();
  };

  /** A tile's right-click: the quick actions as a menu at the pointer. */
  export const openContextMenu = (x: number, y: number) => {
    returnFocus = document.activeElement as HTMLElement | null;
    menuAt = { x, y };
    menuOpen = true;
  };

  /** Editing works on one item, so a multiple selection's menu leaves the editors out. */
  const EDITING_ACTIONS = new Set(['quick-edit', 'studio']);
  let contextLeading = $derived(
    leading.filter((action) => !action.disabled && !(count > 1 && EDITING_ACTIONS.has(action.id))),
  );

  /** Opens up from a click in the lower half, and never runs past the window. */
  const contextPlacement = (at: { x: number; y: number }) => {
    const up = at.y > innerHeight / 2;
    return {
      up,
      left: `${Math.max(8, Math.min(at.x, innerWidth - 264))}px`,
      top: up ? undefined : `${at.y}px`,
      bottom: up ? `${innerHeight - at.y}px` : undefined,
      maxHeight: `${(up ? at.y : innerHeight - at.y) - 8}px`,
    };
  };

  const menuKeydown = (event: KeyboardEvent) => {
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => items[((next % items.length) + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        focusAt(index + 1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        focusAt(index - 1);
        break;
      }
      case 'Home': {
        event.preventDefault();
        focusAt(0);
        break;
      }
      case 'End': {
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      }
      case 'Escape': {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        break;
      }
      case 'Tab': {
        menuOpen = false;
        break;
      }
    }
  };

  $effect(() => {
    if (!menuOpen) {
      return;
    }
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu?.contains(target) && !moreButton?.contains(target)) {
        menuOpen = false;
      }
    };
    // A menu at the pointer stays where it was put, so scrolling the photos away from it closes it.
    const onScroll = (event: Event) => {
      if (menuAt && !menu?.contains(event.target as Node)) {
        menuOpen = false;
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  });

  /** Run an action as if chosen from the bar, for the library's keyboard shortcuts and tile actions. */
  export const performAction = (id: BulkActionId) => perform(id);

  /** Escape closes the menu before it clears the selection, as the prototype does. */
  const handleEscape = () => (menuOpen ? closeMenu() : onClear());
  const deleteKey = () => perform(trash || locked ? 'delete-permanently' : 'delete');
  const guardShortcut = (action: () => void) => (event: KeyboardEvent) => {
    if (isTypingTarget(event.target) || document.querySelector(MODAL_SELECTOR)) return;
    event.preventDefault();
    action();
  };
</script>

<svelte:window
  use:shortcuts={open && !dialog
    ? [
        { shortcut: { key: 'Escape' }, onShortcut: guardShortcut(handleEscape), preventDefault: false },
        { shortcut: { key: 'D', ctrl: true }, onShortcut: guardShortcut(onClear), preventDefault: false },
        { shortcut: { key: 'Delete' }, onShortcut: guardShortcut(deleteKey), preventDefault: false },
        { shortcut: { key: 'Backspace' }, onShortcut: guardShortcut(deleteKey), preventDefault: false },
      ]
    : []}
/>

<div
  class="selection-bar"
  class:is-open={open}
  role="region"
  aria-label={$t('frameleaf_selection_region')}
  inert={!open}
>
  <BulkOperationStatus
    {operations}
    onCancel={onCancelOperation}
    onRetry={onRetryOperation}
    onDismiss={onDismissOperation}
  />

  <div class="pill">
    <div class="count">
      <span aria-live="polite">{$t('selected_count', { values: { count: shownCount } })}</span>
      {#if onSelectAllMatching && total !== null && total > count}
        <button type="button" class="text" onclick={onSelectAllMatching}>
          {$t('frameleaf_selection_select_all_matching', { values: { total } })}
        </button>
      {/if}
      {#if context.snapshot}
        <span class="snapshot">{$t('frameleaf_selection_snapshot')}</span>
      {/if}
      {#if undoLabel && onUndo}
        <button type="button" class="text" onclick={onUndo}>{$t('undo')}: {undoLabel}</button>
      {/if}
      <!-- T-20 (SelectionBar.jsx:204-212): reads "Deselect", named "Deselect all". -->
      <button
        type="button"
        class="clear"
        onclick={onClear}
        aria-label={$t('frameleaf_selection_deselect_all')}
        title={$t('frameleaf_selection_deselect_hint')}
      >
        <Icon icon={mdiClose} size="1.125rem" />
        <span>{$t('frameleaf_selection_deselect')}</span>
      </button>
    </div>

    <div class="actions" role="group" aria-label={$t('frameleaf_selection_actions')}>
      {#each leading as action (action.id)}
        <button
          type="button"
          class="action is-leading"
          class:is-primary={action.primary}
          title={action.disabled && action.disabledReason ? action.disabledReason : action.label}
          aria-disabled={action.disabled && action.disabledReason ? 'true' : undefined}
          disabled={action.disabled && !action.disabledReason}
          data-testid="selection-leading-{action.id}"
          onclick={() => {
            if (!action.disabled) {
              action.onClick();
            }
          }}
        >
          <Icon icon={action.icon} size="1.125rem" />
          <span>{action.label}</span>
        </button>
      {/each}
      {#if leading.length > 0}
        <span class="divider" aria-hidden="true"></span>
      {/if}
      {#each primary as action, index (action.id)}
        <button
          type="button"
          class="action"
          class:is-danger={action.danger}
          class:icon-only={leading.length > 0}
          class:is-everyday={index < 3}
          title={$t(action.labelKey)}
          aria-label={$t(action.labelKey)}
          onclick={() => perform(action.id)}
        >
          <Icon icon={icon(action.icon)} size="1.125rem" />
          <span>{$t(action.labelKey)}</span>
        </button>
      {/each}

      {#if menuGroups.length > 0}
        <div class="more">
          <button
            bind:this={moreButton}
            type="button"
            class="action"
            class:icon-only={leading.length > 0}
            title={$t('frameleaf_selection_more_actions')}
            aria-label={$t('frameleaf_selection_more_actions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onclick={() => {
              menuAt = null;
              menuOpen = !menuOpen;
            }}
            onkeydown={(event) => {
              if (!(event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                return;
              }

              event.preventDefault();
              menuAt = null;
              menuOpen = true;
            }}
          >
            <Icon icon={mdiDotsHorizontal} size="1.125rem" />
            <span>{$t('more')}</span>
          </button>

          {#if (menuOpen || menuLeaving) && !menuAt}
            <div
              bind:this={menu}
              id={menuId}
              class="menu fl-pop fl-origin-bottom-end"
              role="menu"
              tabindex="-1"
              inert={!menuOpen}
              aria-hidden={menuOpen ? undefined : 'true'}
              aria-label={$t('frameleaf_selection_more_actions')}
              onkeydown={menuKeydown}
            >
              {#each menuGroups as group (group.id)}
                <div role="group" aria-labelledby={`${menuId}-${group.id}`}>
                  <p class="menu-title" id={`${menuId}-${group.id}`}>{$t(group.titleKey)}</p>
                  {#each group.items as action (action.id)}
                    <button
                      type="button"
                      role="menuitem"
                      tabindex="-1"
                      class:is-danger={action.danger}
                      onclick={() => perform(action.id)}
                    >
                      <Icon icon={icon(action.icon)} size="1rem" />
                      {$t(action.labelKey)}
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<!--
  A tile's right-click menu: outside the bar, whose frosted capsule and slide-in would otherwise
  hold a fixed menu inside them. A quick list: the page's actions that apply now (no editors for a
  multiple selection) and the bar's own buttons, without "Send a copy…"; everything else stays under More.
-->
{#if menuAt && (menuOpen || menuLeaving)}
  {@const place = contextPlacement(menuAt)}
  <div
    bind:this={menu}
    id={menuId}
    class="menu is-context fl-pop"
    class:fl-origin-bottom-start={place.up}
    style:left={place.left}
    style:top={place.top}
    style:bottom={place.bottom}
    style:max-block-size={place.maxHeight}
    role="menu"
    tabindex="-1"
    inert={!menuOpen}
    aria-hidden={menuOpen ? undefined : 'true'}
    aria-label={$t('frameleaf_selection_actions')}
    data-testid="selection-context-menu"
    onkeydown={menuKeydown}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each contextLeading as action (action.id)}
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        onclick={() => {
          menuOpen = false;
          action.onClick();
        }}
      >
        <Icon icon={action.icon} size="1rem" />
        {action.label}
      </button>
    {/each}
    {#each primary.filter((action) => action.id !== 'send-copy') as action (action.id)}
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class:is-danger={action.danger}
        onclick={() => perform(action.id)}
      >
        <Icon icon={icon(action.icon)} size="1rem" />
        {$t(action.labelKey)}
      </button>
    {/each}
  </div>
{/if}

{#if dialog === 'change-date'}
  <BulkDateDialog
    {count}
    assets={assets.length === count ? assets : []}
    {resolveCaptureTimes}
    bind:open={dialogOpen}
    onSubmit={(payload) => submitDialog('change-date', payload)}
  />
{:else if dialog === 'change-description'}
  <BulkDescriptionDialog
    {count}
    bind:open={dialogOpen}
    onSubmit={(payload) => submitDialog('change-description', payload)}
  />
{:else if dialog === 'change-location'}
  <BulkLocationDialog {count} bind:open={dialogOpen} onSubmit={(payload) => submitDialog('change-location', payload)} />
{:else if dialog === 'tag'}
  <BulkTagDialog
    {count}
    options={tagOptions}
    bind:open={dialogOpen}
    onSubmit={(payload) => submitDialog('tag', payload)}
  />
{:else if dialog === 'add-to-album'}
  <BulkAlbumDialog {count} bind:open={dialogOpen} onSubmit={(payload) => submitDialog('add-to-album', payload)} />
{:else if dialog === 'delete-permanently'}
  <BulkConfirmDialog {count} bind:open={dialogOpen} onConfirm={() => submitDialog('delete-permanently')} />
{:else if dialog === 'export-preservation'}
  <!--
    FL-74: the Preservation export workflow (CommandCenter.jsx `preservation`, settings-catalog.mjs
    "Originals & preservation") opened on this selection. The dialog starts its own durable job, so
    nothing is dispatched to the bulk runner; only the viewer's own items are sent.
  -->
  <PreservationExportDialog
    bind:open={dialogOpen}
    selection={selectionForPreservation(selectedIds, assets, context.currentUserId)}
    includeLockedDefault={locked}
    onCreated={() => {
      dialog = null;
      dialogOpen = false;
      onDialogSettled?.('export-preservation', true);
      toastManager.info($t('frameleaf_preservation_export_started'));
    }}
  />
{:else if dialog === 'create-shared-link'}
  <!-- The form creates the link itself, so nothing is dispatched to the bulk runner. -->
  <SharedLinkForm
    bind:open={dialogOpen}
    target={{
      type: SharedLinkType.Individual,
      assetIds: [...selectedIds],
      name: $t('frameleaf_sharing.individual_items', { values: { count } }),
    }}
  />
{/if}

<style>
  /*
   * apple-style.css "#1 one toolbar": a frosted capsule centred over the library photos, between
   * the rail and the inspector (--fl-left / --fl-right, published by LibraryView).
   */
  .selection-bar {
    position: fixed;
    inset-block-end: max(18px, var(--fl-safe-bottom, 0px));
    inset-inline: calc(var(--fl-left, 0px) + 12px) calc(var(--fl-right, 0px) + 12px);
    z-index: 30;
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    pointer-events: none;
    opacity: 0;
    translate: 0 12px;
    transition:
      opacity var(--fl-duration-fade) var(--fl-ease),
      translate var(--fl-duration-dock) var(--fl-spring);
  }
  .selection-bar.is-open {
    opacity: 1;
    translate: none;
  }
  .selection-bar.is-open > :global(*) {
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .selection-bar {
      translate: none;
      transition: opacity var(--fl-duration-reduced) var(--fl-ease) !important;
    }
  }
  .pill {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    max-inline-size: 100%;
    min-block-size: 52px;
    color: var(--fl-text);
    background: var(--fl-material);
    -webkit-backdrop-filter: var(--fl-material-blur);
    backdrop-filter: var(--fl-material-blur);
    border: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-capsule);
    box-shadow: var(--fl-shadow-3);
    padding: 6px 10px 6px 18px;
    font-size: 0.875rem;
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .pill {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .divider {
    align-self: stretch;
    width: 1px;
    margin: 4px;
    background: var(--fl-material-edge);
  }
  .action span {
    white-space: nowrap;
  }
  .action.icon-only {
    padding-inline: 8px;
  }
  .action.icon-only span {
    display: none;
  }
  /* A disabled action that says why stays focusable and hoverable so its reason can be read. */
  .action[aria-disabled='true'] {
    opacity: 0.4;
    cursor: default;
  }
  .action[aria-disabled='true']:hover {
    background: transparent;
  }
  /* With room to spare the three everyday actions carry their names, even beside a page's own. */
  @media (min-width: 1600px) {
    .action.icon-only.is-everyday {
      padding-inline: 0.6rem;
    }
    .action.icon-only.is-everyday span {
      display: inline;
    }
  }
  .action.is-primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  .action.is-primary:hover:not(:disabled) {
    background: var(--fl-accent-hover, var(--fl-accent));
  }
  .action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .count {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    font-weight: 600;
  }
  .snapshot {
    color: var(--fl-muted);
    font-weight: 400;
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    color: var(--fl-text);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    padding: 0 0.6rem;
    font: inherit;
  }
  button:hover {
    background: var(--fl-raised);
  }
  .text {
    color: var(--fl-accent);
    font-weight: 600;
    padding-inline: 0.25rem;
  }
  .clear {
    color: var(--fl-muted);
  }
  .is-danger {
    color: var(--fl-danger);
  }
  .more {
    position: relative;
  }
  .menu {
    position: absolute;
    inset-block-end: calc(100% + 0.4rem);
    inset-inline-end: 0;
    min-inline-size: 15rem;
    max-block-size: 60dvh;
    overflow: auto;
    /* Solid, not frosted: it hangs inside the frosted capsule, which leaves it nothing to blur. */
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    padding: 0.35rem;
  }
  .menu.is-context {
    position: fixed;
    inset-block-end: auto;
    inset-inline-end: auto;
    z-index: 40;
    inline-size: 16rem;
  }
  .menu button {
    inline-size: 100%;
    justify-content: flex-start;
  }
  .menu-title {
    margin: 0.35rem 0 0.15rem;
    padding-inline: 0.6rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  /* Phones: the bar spans the screen just above the tab bar, labels drop to icons. */
  @media (max-width: 700px) {
    .selection-bar {
      inset-inline: 12px;
      inset-block-end: calc(max(10px, var(--fl-safe-bottom, 0px)) + 74px);
    }
    .pill {
      inline-size: 100%;
      justify-content: space-between;
      row-gap: 4px;
      padding-inline-start: 12px;
    }
    .actions {
      flex: 1 1 100%;
      flex-wrap: nowrap;
      justify-content: space-between;
      overflow-x: auto;
    }
    /* No tooltips on touch: each action carries a short name under its icon. */
    .actions .action,
    .actions .action.icon-only {
      flex: 0 0 auto;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      min-inline-size: 3.5rem;
      padding: 4px 6px;
    }
    .actions .action span,
    .actions .action.icon-only span {
      display: block;
      max-inline-size: 5rem;
      overflow: hidden;
      font-size: var(--fl-font-micro);
      font-weight: 500;
      text-overflow: ellipsis;
    }
    .divider {
      display: none;
    }
  }
</style>
