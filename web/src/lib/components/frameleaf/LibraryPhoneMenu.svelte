<script lang="ts">
  /**
   * The library's one menu on phones (review: "phone library header takes four rows").
   *
   * Above phone width the header carries the Timeline / Browse / Work switch and the results
   * toolbar carries Sort, Grid / List, Slideshow and "More library actions". On a phone those
   * stacked into four rows before the first photo. Here they are one overflow menu at the end of
   * the single toolbar row; the count and Filter stay beside it.
   */
  import { LAYOUT_LABELS, LAYOUT_ORDER, showLibraryLayout } from '$lib/components/frameleaf/LibraryLayoutSwitch.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryLayout, LibrarySort } from '$lib/frameleaf/library-session';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheck,
    mdiCheckboxMultipleMarkedOutline,
    mdiDotsHorizontal,
    mdiFormatListBulleted,
    mdiPlayBoxOutline,
    mdiViewGridOutline,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    session: LibrarySessionStore;
    /** The layouts on offer; one layout (Locked) draws no View group. */
    layouts?: readonly LibraryLayout[];
    current: LibraryLayout;
    /** The sorts this view's source can apply; undefined draws no Sort group. */
    sorts?: readonly LibrarySort[];
    sort?: LibrarySort;
    onSortChange?: (sort: LibrarySort) => void;
    /** Grid or List; undefined draws neither, as in the Timeline. */
    view?: 'grid' | 'list';
    onViewChange?: (view: 'grid' | 'list') => void;
    onSlideshow?: () => void;
    /** "Select all N", with its label, where the page offers it. */
    selectAllLabel?: string;
    onSelectAll?: () => void;
    /** Nothing to act on: Slideshow and Select all are listed but not offered. */
    empty?: boolean;
  };

  let {
    session,
    layouts = LAYOUT_ORDER,
    current,
    sorts,
    sort,
    onSortChange,
    view,
    onViewChange,
    onSlideshow,
    selectAllLabel,
    onSelectAll,
    empty = false,
  }: Props = $props();

  /** The results toolbar's five sorts, in its order (`ResultsToolbar` SORT_OPTIONS). */
  const SORT_OPTIONS: { value: LibrarySort; label: Translations }[] = [
    { value: 'captured-desc', label: 'frameleaf_library_sort_captured_newest' },
    { value: 'captured-asc', label: 'frameleaf_library_sort_captured_oldest' },
    { value: 'imported-desc', label: 'frameleaf_library_sort_added_newest' },
    { value: 'filename', label: 'frameleaf_library_sort_filename' },
    { value: 'rating', label: 'frameleaf_library_sort_rating' },
  ];

  let open = $state(false);
  const shownLayouts = $derived(LAYOUT_ORDER.filter((layout) => layouts.includes(layout)));
  const shownSorts = $derived(sorts ? SORT_OPTIONS.filter((option) => sorts.includes(option.value)) : []);
  const currentSort = $derived(sort ?? session.state.sort);
</script>

<div class="fl-phone-menu" data-testid="frameleaf-library-phone-menu">
  <Menu label={$t('frameleaf_library_view_menu')} align="end" bind:open>
    {#snippet trigger()}
      <Icon icon={mdiDotsHorizontal} size="20" aria-hidden />
    {/snippet}

    {#if shownLayouts.length > 1}
      <div class="fl-phone-menu-label" role="presentation">{$t('frameleaf_library_layout')}</div>
      {#each shownLayouts as layout (layout)}
        <MenuItem checked={current === layout} onSelect={() => showLibraryLayout(session, layout)}>
          <span class="fl-phone-menu-mark" aria-hidden="true">
            {#if current === layout}<Icon icon={mdiCheck} size="16" />{/if}
          </span>
          {$t(LAYOUT_LABELS[layout])}
        </MenuItem>
      {/each}
    {/if}

    {#if view && onViewChange}
      <hr />
      <MenuItem checked={view === 'grid'} onSelect={() => onViewChange('grid')}>
        <Icon icon={mdiViewGridOutline} size="16" aria-hidden />
        {$t('frameleaf_library_grid_view')}
      </MenuItem>
      <MenuItem checked={view === 'list'} onSelect={() => onViewChange('list')}>
        <Icon icon={mdiFormatListBulleted} size="16" aria-hidden />
        {$t('frameleaf_library_list_view')}
      </MenuItem>
    {/if}

    {#if shownSorts.length > 1}
      <hr />
      <div class="fl-phone-menu-label" role="presentation">{$t('frameleaf_library_view_menu_sort')}</div>
      {#each shownSorts as option (option.value)}
        <MenuItem
          checked={currentSort === option.value}
          onSelect={() => (onSortChange ? onSortChange(option.value) : session.patchView({ sort: option.value }))}
        >
          <span class="fl-phone-menu-mark" aria-hidden="true">
            {#if currentSort === option.value}<Icon icon={mdiCheck} size="16" />{/if}
          </span>
          {$t(option.label)}
        </MenuItem>
      {/each}
    {/if}

    {#if onSlideshow || onSelectAll}
      <hr />
    {/if}
    {#if onSlideshow}
      <MenuItem disabled={empty} onSelect={onSlideshow}>
        <Icon icon={mdiPlayBoxOutline} size="16" aria-hidden />
        {$t('slideshow')}
      </MenuItem>
    {/if}
    {#if onSelectAll && selectAllLabel}
      <MenuItem disabled={empty} onSelect={onSelectAll}>
        <Icon icon={mdiCheckboxMultipleMarkedOutline} size="16" aria-hidden />
        {selectAllLabel}
      </MenuItem>
    {/if}
  </Menu>
</div>

<style>
  .fl-phone-menu {
    display: inline-flex;
  }
  /* The trigger is a plain icon button in the toolbar row, at the full touch size. */
  .fl-phone-menu :global(.menu-root > button) {
    min-width: var(--fl-control-height);
    min-height: var(--fl-control-height);
    padding: 0;
    border-color: transparent;
    background: transparent;
  }
  .fl-phone-menu :global(.menu-root > button:hover),
  .fl-phone-menu :global(.menu-root > button[aria-expanded='true']) {
    background: var(--fl-raised);
  }
  .fl-phone-menu :global([role='menu']) {
    min-width: 14rem;
    max-height: min(32rem, calc(100dvh - var(--fl-topbar-height-phone, 6rem) - var(--fl-tabbar-space, 0px) - 4rem));
    overflow-y: auto;
  }
  .fl-phone-menu-label {
    padding: var(--fl-space-2) var(--fl-space-3) var(--fl-space-1);
    color: var(--fl-muted);
    font: var(--fl-type-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fl-phone-menu-mark {
    display: inline-grid;
    place-items: center;
    width: var(--fl-icon-md);
    flex-shrink: 0;
  }
  hr {
    margin: var(--fl-space-1) 0;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
</style>
