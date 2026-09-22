<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import BulkDateDialog from '$lib/components/frameleaf/BulkDateDialog.svelte';
  import BulkDescriptionDialog from '$lib/components/frameleaf/BulkDescriptionDialog.svelte';
  import BulkLocationDialog from '$lib/components/frameleaf/BulkLocationDialog.svelte';
  import BulkOperationStatus from '$lib/components/frameleaf/BulkOperationStatus.svelte';
  import BulkTagDialog from '$lib/components/frameleaf/BulkTagDialog.svelte';
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
  import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
  import { Icon } from '@immich/ui';
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
    mdiMapMarkerOutline,
    mdiMotionPauseOutline,
    mdiMotionPlayOutline,
    mdiMovieEditOutline,
    mdiPlaylistRemove,
    mdiShieldLockOutline,
    mdiShieldOutline,
    mdiTagPlusOutline,
    mdiTextBoxOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

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
    mdiMapMarkerOutline,
    mdiMotionPauseOutline,
    mdiMotionPlayOutline,
    mdiMovieEditOutline,
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
   * the library view binds to `runBulkAction`; the bar never calls an endpoint itself, so there is
   * one place where an action is bound and one place where its failures are reported.
   *
   * September 22, 2026 revision: the bar carries the complete bulk set, nothing is selected on
   * load, and "select everything matching" offers a scope-bound snapshot that runs in the
   * background with progress and cancellation.
   */
  let {
    count = 0,
    /** Total matching the current scope, for the "Select all n" offer. Null while unknown. */
    total = null,
    /** The selected assets, when the view has them loaded. */
    assets = [],
    context = {},
    tagOptions = [],
    albumOptions = [],
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
  }: {
    count?: number;
    total?: number | null;
    assets?: BulkAsset[];
    context?: Omit<BulkActionContext, 'assets' | 'count'>;
    tagOptions?: { id: string; name: string }[];
    albumOptions?: { id: string; name: string; count?: number }[];
    operations?: BulkOperationRecord[];
    undoLabel?: string;
    onAction: (id: BulkActionId, payload?: BulkPayload) => void;
    onUndo?: () => void;
    onClear: () => void;
    onSelectAllMatching?: () => void;
    onCancelOperation?: (requestId: string) => void;
    onRetryOperation?: (operation: BulkOperationRecord) => void;
    onDismissOperation?: (requestId: string) => void;
  } = $props();

  let menuOpen = $state(false);
  let dialog = $state<BulkActionId | null>(null);
  /** Bound to the open dialog, so closing it from inside clears the parent's choice too. */
  let dialogOpen = $state(false);
  let moreButton = $state<HTMLButtonElement | undefined>();
  let menu = $state<HTMLDivElement | undefined>();

  const menuId = $props.id();

  let open = $derived(count > 0);
  let trash = $derived(!!context.trash);
  let actions = $derived(bulkActions({ ...context, assets, count }));
  let byId = $derived(bulkActionById(actions));
  let primary = $derived(primaryBulkActions(actions, trash));
  let menuGroups = $derived(menuBulkActions(actions, trash));
  const icon = (name: string) => ICONS[name] ?? mdiDotsHorizontal;

  $effect(() => {
    if (!open) {
      menuOpen = false;
      dialog = null;
      dialogOpen = false;
    }
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
    onAction(id, payload);
  };

  $effect(() => {
    if (!dialogOpen && dialog) {
      dialog = null;
    }
  });

  const closeMenu = () => {
    menuOpen = false;
    moreButton?.focus();
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
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

  /** Escape closes the menu before it clears the selection, as the prototype does. */
  const handleEscape = () => (menuOpen ? closeMenu() : onClear());
  const deleteKey = () => perform(trash ? 'delete-permanently' : 'delete');
</script>

<svelte:window
  use:shortcuts={open && !dialog
    ? [
        { shortcut: { key: 'Escape' }, onShortcut: handleEscape },
        { shortcut: { key: 'D', ctrl: true }, onShortcut: onClear, preventDefault: true },
        { shortcut: { key: 'Delete' }, onShortcut: deleteKey },
        { shortcut: { key: 'Backspace' }, onShortcut: deleteKey },
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
      <span aria-live="polite">{$t('selected_count', { values: { count } })}</span>
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
      <button type="button" class="clear" onclick={onClear} title={$t('frameleaf_selection_deselect_hint')}>
        <Icon icon={mdiClose} size="1.125rem" />
        <span>{$t('deselect_all')}</span>
      </button>
    </div>

    <div class="actions" role="group" aria-label={$t('frameleaf_selection_actions')}>
      {#each primary as action (action.id)}
        <button
          type="button"
          class="action"
          class:is-danger={action.danger}
          title={$t(action.labelKey)}
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
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onclick={() => (menuOpen = !menuOpen)}
            onkeydown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                menuOpen = true;
              }
            }}
          >
            <Icon icon={mdiDotsHorizontal} size="1.125rem" />
            <span>{$t('more')}</span>
          </button>

          {#if menuOpen}
            <div bind:this={menu} id={menuId} class="menu" role="menu" aria-label={$t('more')} onkeydown={menuKeydown}>
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

{#if dialog === 'change-date'}
  <BulkDateDialog {count} bind:open={dialogOpen} onSubmit={(payload) => submitDialog('change-date', payload)} />
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
  <BulkAlbumDialog
    {count}
    albums={albumOptions}
    bind:open={dialogOpen}
    onSubmit={(payload) => submitDialog('add-to-album', payload)}
  />
{:else if dialog === 'delete-permanently'}
  <BulkConfirmDialog {count} bind:open={dialogOpen} onConfirm={() => submitDialog('delete-permanently')} />
{/if}

<style>
  .selection-bar {
    position: fixed;
    inset-block-end: max(1rem, env(safe-area-inset-bottom));
    inset-inline: 0;
    z-index: 30;
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    padding-inline: 1rem;
    pointer-events: none;
    opacity: 0;
    translate: 0 1rem;
    transition:
      opacity 120ms ease,
      translate 120ms ease;
  }
  .selection-bar.is-open {
    opacity: 1;
    translate: none;
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .selection-bar {
      transition: none;
    }
  }
  .pill {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    max-inline-size: 100%;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    box-shadow: 0 12px 32px rgb(0 0 0 / 35%);
    padding: 0.4rem 0.6rem;
    font-size: 0.875rem;
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
    border-radius: var(--fl-radius);
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
    color: #e0716a;
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
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    box-shadow: 0 12px 32px rgb(0 0 0 / 35%);
    padding: 0.35rem;
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
  @media (max-width: 40rem) {
    .pill {
      inline-size: 100%;
    }
    .actions .action span {
      display: none;
    }
  }
</style>
