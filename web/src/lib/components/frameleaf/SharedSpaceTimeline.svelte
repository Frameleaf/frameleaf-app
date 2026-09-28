<script lang="ts">
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { filterToNew, shouldPageForNew } from '$lib/frameleaf/shared-space';
  import type { SpacePhotoSet } from '$lib/frameleaf/space-photos.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAllTags, type AlbumResponseDto } from '@immich/sdk';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The photos in one shared space, on the space's own page (FL-55).
   *
   * This is the shared Frameleaf results grid (`ResultsView` over `AssetGrid`) — the one search,
   * Best Photos and a collection already use — drawn from the space's photo set. The page owns that
   * set and hands the same one to the space's viewer, so next and previous in the viewer walk
   * exactly this grid's order. The set reads the existing metadata search narrowed to the space,
   * which checks album access for the caller and applies their hidden-content rules, so the grid can
   * only ever hold items every member is allowed to see here, with anything marked sensitive and
   * anything Locked left out exactly as the rest of the library leaves them out.
   *
   * Linked albums do not add items to this grid. A link is a reference to somebody's album, not a
   * copy of it, so what is here is what members put in the space.
   *
   * The selection bar is FL-32's, bound to the space's scope, so a bulk action here behaves as it
   * does in the album view. Opening an item opens the space's own viewer.
   *
   * "Select all N matching" (FL-55 follow-up) uses `ResultsView`'s `selectAllMode="matching"`, the
   * same `snapshotSearch`/space-as-album-condition machinery the album route's `LibraryView`
   * uses for a space (`bulk-operations.ts`'s `snapshotSearch` already special-cases
   * `scope.kind === 'space'`): the bar counts and selects a frozen snapshot of the space's own
   * scope, and a bulk action run against it goes to the server as a durable, cancellable operation
   * rather than an explicit id list. It falls back to selecting only what is loaded (as before)
   * while the "only new since visit" filter narrows the grid to a client-side id set the server
   * cannot resolve on its own. A viewer's (non-contributor's) matching set is narrowed to download
   * and add-to-own-album by `spaceViewerMatching`, exactly as the album route's `isSpaceViewer`
   * narrows it; the server still checks every item's access per item, and another member's Locked
   * asset is never in a matching set a non-elevated session's search cannot see.
   */
  interface Props {
    space: AlbumResponseDto;
    /** The space's photos as far as they are loaded; shared with the viewer. */
    photos: SpacePhotoSet;
    /** Only these ids, when a member asked to see what is new; `undefined` shows everything. */
    filter?: Set<string>;
    /** True when the signed-in person is not an owner or editor of this space (FL-48/FL-55). */
    isViewer?: boolean;
    onOpen: (asset: TimelineAsset) => void;
    /** A bulk action took items out of the space; the page refreshes its counts. */
    onChanged?: () => Promise<void> | void;
  }

  let { space, photos, filter, isViewer = false, onOpen, onChanged }: Props = $props();

  const bulkContext = $derived({ albumId: space.id, ...(isViewer && { spaceViewerMatching: true }) });

  // A "select all matching" snapshot is a server-side search over the whole space; the client-side
  // "only new since visit" id set has no server-side equivalent to intersect it with, so that view
  // keeps the honest "everything loaded" offer instead of silently widening past what it shows.
  const selectAllMode = $derived<'matching' | 'loaded'>(filter ? 'loaded' : 'matching');

  let tagOptions = $state<{ id: string; name: string }[]>([]);

  const loadMore = () => void photos.loadMore();

  const shown = $derived(filterToNew(photos.assets, filter).map((asset) => toTimelineAsset(asset)));

  // "New" is by when an item was added, the grid is by when it was taken, so a new item can be on
  // any page. While the filter is on, keep paging until every named item is here.
  $effect(() => {
    if (
      shouldPageForNew({ filter, found: shown.length, exhausted: photos.exhausted, loading: photos.loading }) &&
      !photos.failed
    ) {
      untrack(loadMore);
    }
  });

  // The bar acts on this space, and a selection made elsewhere never carries in.
  $effect(() => {
    const scope = { kind: 'space' as const, id: space.id };
    if (librarySession.state.scope.kind !== scope.kind || librarySession.state.scope.id !== scope.id) {
      librarySession.setScope(scope);
    }
  });

  const handleRemoved = (ids: string[]) => {
    photos.remove(ids);
    void onChanged?.();
  };

  const selectEverythingLoaded = () => librarySession.selectAll(shown.map(({ id }) => id));

  // The set outlives this panel: coming back to it, or closing the viewer, keeps what is loaded. A
  // new set (another space, or the owner changed the order) starts from its first page.
  $effect(() => {
    if (photos.page === 0 && !photos.loading && !photos.failed) {
      untrack(() => void photos.load(1));
    }
  });

  onMount(() => {
    void getAllTags()
      .then((tags) => (tagOptions = tags.map(({ id, value }) => ({ id, name: value }))))
      .catch(() => {
        // Tagging simply offers no existing tags if they cannot be read.
      });
  });
</script>

<section class="space-timeline" aria-label={$t('frameleaf_spaces_panel_timeline')}>
  <ResultsView
    assets={shown}
    {bulkContext}
    {selectAllMode}
    downloadFileName={namedArchiveName(space.albumName, $t('frameleaf_archive_name_space'))}
    {tagOptions}
    onEndReached={loadMore}
    onRemoved={handleRemoved}
    onSelectAll={selectEverythingLoaded}
    {onOpen}
  >
    {#snippet empty()}
      {#if !photos.loading && !photos.failed}
        <p class="empty">
          {filter ? $t('frameleaf_spaces_new_only_empty') : $t('frameleaf_spaces_timeline_empty')}
        </p>
      {/if}
    {/snippet}
  </ResultsView>

  {#if photos.loading}
    <Status message={$t('loading')} busy={true} />
  {:else if photos.failed}
    <p class="empty">
      {$t('frameleaf_spaces_error_timeline')}
      <button type="button" onclick={() => void photos.retry()}>{$t('retry')}</button>
    </p>
  {/if}
</section>

<style>
  .space-timeline {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--fl-text);
  }
  .empty {
    margin: 0;
    padding: 2rem 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
    text-align: center;
  }
  button {
    margin-inline-start: 0.5rem;
    padding: 0 0.75rem;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
</style>
