<script lang="ts">
  import { albumViewSettings, SortOrder, AlbumSortBy } from '$lib/stores/preferences.store';
  import type { AlbumSortOptionMetadata } from '$lib/utils/album-utils';
  import { t, type Translations } from 'svelte-i18n';

  interface Props {
    option: AlbumSortOptionMetadata;
  }

  let { option }: Props = $props();

  const handleSort = () => {
    albumViewSettings.update((settings) => ({
      ...settings,
      sortBy: option.id,
      sortOrder:
        settings.sortBy === option.id
          ? settings.sortOrder === SortOrder.Asc
            ? SortOrder.Desc
            : SortOrder.Asc
          : option.defaultOrder,
    }));
  };

  const albumSortByKeys: Record<AlbumSortBy, Translations> = {
    [AlbumSortBy.Title]: 'sort_title',
    [AlbumSortBy.ItemCount]: 'sort_items',
    [AlbumSortBy.DateModified]: 'sort_modified',
    [AlbumSortBy.DateCreated]: 'sort_created',
    [AlbumSortBy.MostRecentPhoto]: 'sort_recent',
    [AlbumSortBy.OldestPhoto]: 'sort_oldest',
  };
</script>

<th class="text-sm font-medium {option.columnStyle}">
  <button
    type="button"
    class="rounded-lg p-2 hover:bg-immich-dark-primary hover:dark:bg-immich-dark-primary/50"
    onclick={handleSort}
  >
    {#if $albumViewSettings.sortBy === option.id}
      {#if $albumViewSettings.sortOrder === SortOrder.Desc}
        &#8595;
      {:else}
        &#8593;
      {/if}
    {/if}
    {$t(albumSortByKeys[option.id])}
  </button>
</th>
