<script lang="ts">
  import { getAlbumDateRange } from '$lib/utils/date-time';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
  };

  const { album }: Props = $props();
  const startDate = $derived(album.startDate);
  // An album whose dates the server sent malformed shows no range (and no separator) rather than failing.
  const range = $derived(startDate ? getAlbumDateRange(startDate, album.endDate ?? startDate) : '');
</script>

<span class="my-2 flex gap-2 text-sm font-medium text-gray-500" data-testid="album-details">
  {#if range}
    <span>{range}</span>
    <span>•</span>
  {/if}
  <span>{$t('items_count', { values: { count: album.assetCount } })}</span>
</span>
