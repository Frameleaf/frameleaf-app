<script lang="ts">
  /**
   * The library page: Timeline, Browse and Work bound to one live session (FL-33).
   *
   * The three layouts are presentations of the same state, not three pages. Switching between them
   * writes `layout` and nothing else, so the structured query, the album or Space scope, the
   * selected ids, the open asset, the playhead and the asset-relative scroll anchor all survive the
   * switch. Timeline precedes Browse and Work, and Browse is the default.
   *
   * The surfaces other stories own are extension points, not reimplementations:
   * the rail and top bar (FL-30) render through `shell`, the selection bar and bulk actions
   * (FL-32) through `selectionBar`, the viewer (FL-35) through `viewer`, and the information panel
   * (FL-36) through `infoPanel`. This component owns the session, the layouts and the key map.
   */
  import { browser } from '$app/environment';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import ShortcutsHelp from '$lib/components/frameleaf/ShortcutsHelp.svelte';
  import ShowMore from '$lib/components/frameleaf/ShowMore.svelte';
  import type { DiscoveryDestination, DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryGrouping } from '$lib/frameleaf/library-session';
  import { matchLibraryShortcut, type LibraryShortcut } from '$lib/frameleaf/library-shortcuts';
  import {
    assetMultiSelectManager,
    type AssetMultiSelectManager,
  } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset, TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { onDestroy, type Snippet } from 'svelte';

  type Props = {
    /** Timeline source options (visibility, album, person, partners). */
    options?: TimelineManagerOptions;
    /** The live session. Defaults to the one every view shares. */
    session?: LibrarySessionStore;
    /** Where the results are already shown, so chips never restate it. */
    destination?: DiscoveryDestination;
    timelineManager?: TimelineManager;
    /** Put the portable view state in the URL, so a link reopens what it describes. */
    syncUrl?: boolean;
    ratingFor?: (asset: TimelineAsset) => number | null;
    captionFor?: (asset: TimelineAsset) => string | null;
    /** Open the existing filter panel at a section. */
    onOpenFilterPanel?: (section: DiscoveryFilterSection) => void;
    /** Load the next page of results. */
    onShowMore?: (page: number) => void;
    /** Shortcuts this component does not act on itself (favorite, edit, tag, delete, ...). */
    onShortcut?: (shortcut: LibraryShortcut) => void;
    loading?: boolean;
    /** Restore the scroll position from the URL's asset and from the session's scroll anchor. */
    enableRouting?: boolean;
    /**
     * Mirror the session's selection into the existing multi-select manager, so the bulk actions
     * (FL-32, FL-36) act on exactly what the library shows as selected. One selection, two readers.
     */
    multiSelect?: AssetMultiSelectManager | null;
    /** FL-30: rail and top bar. */
    shell?: Snippet;
    /** Rendered above the results toolbar, inside the scrolling area. */
    children?: Snippet;
    /** Extra results-toolbar controls (sort, grouping, view). */
    toolbar?: Snippet;
    /** FL-32: the floating selection bar and its bulk actions. */
    selectionBar?: Snippet;
    /** FL-35: the viewer, opened from the session's open asset. */
    viewer?: Snippet;
    /** FL-36: the information panel. Work opens it above tablet width only. */
    infoPanel?: Snippet;
    empty?: Snippet;
  };

  let {
    options,
    session = librarySession,
    destination,
    timelineManager = $bindable(),
    syncUrl = true,
    ratingFor,
    captionFor,
    onOpenFilterPanel,
    onShowMore,
    onShortcut,
    loading = false,
    enableRouting = false,
    multiSelect = assetMultiSelectManager,
    shell,
    children,
    toolbar,
    selectionBar,
    viewer,
    infoPanel,
    empty,
  }: Props = $props();

  timelineManager = new TimelineManager();
  onDestroy(() => timelineManager?.destroy());

  let helpOpen = $state(false);
  let restored = false;

  const manager = $derived(timelineManager as TimelineManager);
  // Work opens the information panel only above tablet width; on phones it never auto-opens.
  const showInfoPanel = $derived(session.layout === 'work' && !mediaQueryManager.maxMd);
  const selecting = $derived(session.selection.length > 0);

  $effect(() => {
    if (options) {
      void manager.updateOptions(options);
    }
  });

  $effect(() => {
    session.destination = destination;
  });

  // Restore once per mount: the URL's portable state wins over the stored view, and layout comes
  // from storage because it is device-local.
  $effect(() => {
    if (restored || !browser) {
      return;
    }
    restored = true;
    session.restore(page.url, authManager.authenticated ? authManager.user.id : undefined);
  });

  // Persist the device-local part of the session, and keep the link in step with the view state.
  $effect(() => {
    // Read both so the effect re-runs when either changes.
    const state = JSON.stringify(session.state);
    const layout = session.layout;
    if (!browser || !restored || !state || !layout) {
      return;
    }
    session.persist(authManager.authenticated ? authManager.user.id : undefined);
    if (syncUrl) {
      const next = session.viewUrl(page.url);
      if (next.href !== page.url.href) {
        replaceState(next, page.state);
      }
    }
  });

  const focusedId = () => session.session.scrollAnchor ?? session.selection.at(-1) ?? null;

  const loadedIds = () =>
    manager.months.flatMap((month) =>
      month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => viewerAsset.id)),
    );

  const findAsset = (id: string): TimelineAsset | null => {
    for (const month of manager.months) {
      for (const day of month.timelineDays) {
        const match = day.viewerAssets.find((viewerAsset) => viewerAsset.id === id);
        if (match?.asset) {
          return match.asset;
        }
      }
    }
    return null;
  };

  /**
   * The session owns the selection; the multi-select manager is kept in step with it so the
   * existing bulk actions keep acting on the same items. Assets that are not loaded cannot be
   * mirrored, so a "select everything matching" selection still has to be resolved by its owner.
   */
  $effect(() => {
    const ids = new Set(session.selection);
    if (!multiSelect) {
      return;
    }
    for (const asset of multiSelect.assets) {
      if (!ids.has(asset.id)) {
        multiSelect.removeAssetFromMultiselectGroup(asset.id);
      }
    }
    for (const id of ids) {
      if (multiSelect.hasSelectedAsset(id)) {
        continue;
      }
      const asset = findAsset(id);
      if (asset) {
        multiSelect.selectAsset(asset);
      }
    }
  });

  /**
   * One key map serves the timeline and the viewer. The entries this page can act on itself are
   * handled here; the rest are handed to the owner of that action.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    // While the viewer is open the keys belong to it.
    const surface = session.openAssetId ? 'viewer' : 'timeline';
    const shortcut = matchLibraryShortcut(event, { surface });
    if (!shortcut) {
      return;
    }
    switch (shortcut.id) {
      case 'help': {
        event.preventDefault();
        helpOpen = true;
        return;
      }
      case 'select-all': {
        event.preventDefault();
        session.selectAll(loadedIds());
        return;
      }
      case 'clear-selection': {
        event.preventDefault();
        session.clearSelection();
        return;
      }
      case 'select': {
        const id = focusedId();
        if (id) {
          event.preventDefault();
          session.select(id);
        }
        return;
      }
      case 'close': {
        if (session.openAssetId) {
          event.preventDefault();
          session.close();
          return;
        }
        if (selecting) {
          event.preventDefault();
          session.clearSelection();
          return;
        }
        break;
      }
      case 'group-days':
      case 'group-months':
      case 'group-years': {
        // Grouping is page state: it travels in a link, survives a layout switch and is what the
        // query bridge reads. The timeline itself always draws day groups inside month buckets,
        // which is what the manager loads; coarser groupings need bucket support it does not have.
        event.preventDefault();
        session.patchView({ grouping: shortcut.id.replace('group-', '') as LibraryGrouping });
        return;
      }
      default: {
        break;
      }
    }
    onShortcut?.(shortcut);
  };
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="frameleaf fl-library" data-testid="frameleaf-library" data-layout={session.layout}>
  {@render shell?.()}

  <div class="fl-library-body" class:has-panel={showInfoPanel}>
    <div class="fl-library-main">
      <LibraryTimeline
        timelineManager={manager}
        {session}
        {ratingFor}
        captionFor={session.layout === 'work' ? captionFor : undefined}
        showDayHeaders={session.layout !== 'browse'}
        {enableRouting}
        {empty}
      >
        {#snippet header()}
          {@render children?.()}
          <ResultsToolbar {session} {onOpenFilterPanel}>
            {@render toolbar?.()}
          </ResultsToolbar>
        {/snippet}
      </LibraryTimeline>

      <ShowMore {session} {onShowMore} {loading} />
    </div>

    {#if showInfoPanel}
      <aside class="fl-library-panel">{@render infoPanel?.()}</aside>
    {/if}
  </div>

  {#if selecting}
    {@render selectionBar?.()}
  {/if}
  <!-- The viewer decides for itself when it is open; it is the owner of that surface (FL-35). -->
  {@render viewer?.()}
</div>

{#if helpOpen}
  <ShortcutsHelp surface={session.openAssetId ? 'viewer' : 'timeline'} onClose={() => (helpOpen = false)} />
{/if}

<style>
  .fl-library {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .fl-library-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .fl-library-main {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .fl-library-panel {
    flex: 0 0 320px;
    overflow-y: auto;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
</style>
