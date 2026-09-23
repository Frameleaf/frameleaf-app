<script lang="ts">
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { filterToNew, shouldPageForNew, SPACE_TIMELINE_PAGE } from '$lib/frameleaf/shared-space';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAllTags, searchAssets, type AlbumResponseDto, type AssetResponseDto } from '@immich/sdk';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The photos in one shared space, on the space's own page (FL-55).
   *
   * This is the shared Frameleaf results grid (`ResultsView` over `AssetGrid`) — the one search,
   * Best Photos and a collection already use — fed from the existing metadata search narrowed to the
   * space. That search checks album access for the caller and applies their hidden-content rules, so
   * the grid can only ever hold items every member is allowed to see here, with anything marked
   * sensitive and anything Locked left out exactly as the rest of the library leaves them out.
   *
   * Linked albums do not add items to this grid. A link is a reference to somebody's album, not a
   * copy of it, so what is here is what members put in the space.
   *
   * The selection bar is FL-32's, bound to the space's scope, so a bulk action here behaves as it
   * does in the album view. Opening an item hands over to the album view of the same space, which
   * owns the viewer, per-item activity and the slideshow.
   */
  interface Props {
    space: AlbumResponseDto;
    /** Only these ids, when a member asked to see what is new; `undefined` shows everything. */
    filter?: Set<string>;
    /** Albums and spaces a bulk "add to album" may target. */
    albumOptions?: { id: string; name: string; count?: number }[];
    onOpen: (asset: TimelineAsset) => void;
    /** A bulk action took items out of the space; the page refreshes its counts. */
    onChanged?: () => Promise<void> | void;
  }

  let { space, filter, albumOptions = [], onOpen, onChanged }: Props = $props();

  let assets = $state<AssetResponseDto[]>([]);
  let page = $state(1);
  let loading = $state(false);
  let exhausted = $state(false);
  let failed = $state(false);
  let tagOptions = $state<{ id: string; name: string }[]>([]);

  const load = async (next: number) => {
    loading = true;
    failed = false;
    try {
      const { assets: results } = await searchAssets({
        metadataSearchDto: { albumIds: [space.id], page: next, size: SPACE_TIMELINE_PAGE, order: space.order },
      });
      assets = next === 1 ? results.items : [...assets, ...results.items];
      exhausted = results.nextPage === null;
      page = next;
    } catch (error) {
      failed = true;
      handleError(error, $t('frameleaf_spaces_error_timeline'));
    } finally {
      loading = false;
    }
  };

  const loadMore = () => {
    if (loading || exhausted || failed) {
      return;
    }
    void load(page + 1);
  };

  const shown = $derived(filterToNew(assets, filter).map((asset) => toTimelineAsset(asset)));

  // "New" is by when an item was added, the grid is by when it was taken, so a new item can be on
  // any page. While the filter is on, keep paging until every named item is here.
  $effect(() => {
    if (shouldPageForNew({ filter, found: shown.length, exhausted, loading }) && !failed) {
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
    const removed = new Set(ids);
    assets = assets.filter(({ id }) => !removed.has(id));
    void onChanged?.();
  };

  const selectEverythingLoaded = () => librarySession.selectAll(shown.map(({ id }) => id));

  onMount(() => {
    void load(1);
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
    bulkContext={{ albumId: space.id }}
    {tagOptions}
    {albumOptions}
    onEndReached={loadMore}
    onRemoved={handleRemoved}
    onSelectAll={selectEverythingLoaded}
    {onOpen}
  >
    {#snippet empty()}
      {#if !loading && !failed}
        <p class="empty">
          {filter ? $t('frameleaf_spaces_new_only_empty') : $t('frameleaf_spaces_timeline_empty')}
        </p>
      {/if}
    {/snippet}
  </ResultsView>

  {#if loading}
    <Status message={$t('loading')} busy={true} />
  {:else if failed}
    <p class="empty">
      {$t('frameleaf_spaces_error_timeline')}
      <button type="button" onclick={() => void load(assets.length === 0 ? 1 : page + 1)}>{$t('retry')}</button>
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
