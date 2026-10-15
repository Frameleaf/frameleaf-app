<script lang="ts">
  import { longPress } from '$lib/actions/long-press';
  import { scrollProperties } from '$lib/components/shared-components/album-selection/album-selection-utils';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { splitSearchMatch } from '$lib/utils/string-utils.js';
  import { type AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircle } from '@mdi/js';
  import type { Action } from 'svelte/action';
  import AlbumListItemDetails from './AlbumListItemDetails.svelte';

  interface Props {
    album: AlbumResponseDto;
    searchQuery?: string;
    selected: boolean;
    multiSelected?: boolean;
    onAlbumClick: () => void;
    onMultiSelect: () => void;
  }

  let {
    album,
    searchQuery = '',
    selected = false,
    multiSelected = false,
    onAlbumClick,
    onMultiSelect,
  }: Props = $props();

  const scrollIntoViewIfSelected: Action = (node) => {
    $effect(() => {
      if (selected) {
        node.scrollIntoView(scrollProperties());
      }
    });
  };

  const albumNameArray = $derived(splitSearchMatch(album.albumName, searchQuery, $locale));

  const handleMultiSelectClicked = (e?: MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    onMultiSelect();
  };

  let usingMobileDevice = $derived(mediaQueryManager.pointerCoarse);
  let mouseOver = $state(false);
  const onMouseEnter = () => {
    if (usingMobileDevice) {
      return;
    }
    mouseOver = true;
  };

  const onMouseLeave = () => {
    mouseOver = false;
  };
</script>

<div
  role="group"
  class={[
    'relative my-2 flex w-full justify-between rounded-xl text-start transition-colors hover:cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700',
    { 'bg-primary/10 hover:bg-primary/10': multiSelected },
  ]}
  onmouseenter={onMouseEnter}
  onmouseleave={onMouseLeave}
>
  <button
    type="button"
    onclick={onAlbumClick}
    use:scrollIntoViewIfSelected
    class="flex w-full gap-4 p-2 text-start"
    class:bg-gray-200={selected}
    class:dark:bg-gray-700={selected}
    use:longPress={{ onLongPress: () => handleMultiSelectClicked() }}
  >
    <span class="size-16 shrink-0 rounded-xl bg-slate-300">
      {#if album.albumThumbnailAssetId}
        <img
          src={getAssetMediaUrl({ id: album.albumThumbnailAssetId })}
          alt={album.albumName}
          class={['size-full rounded-xl object-cover transition-all duration-300 hover:shadow-lg']}
          data-testid="album-image"
          draggable="false"
        />
      {/if}
    </span>
    <span class="flex h-full flex-col items-start justify-center overflow-hidden">
      <span class="w-full shrink truncate">{albumNameArray[0]}<b>{albumNameArray[1]}</b>{albumNameArray[2]}</span>
      <span class="flex gap-1 text-sm">
        <AlbumListItemDetails {album} />
      </span>
    </span>
  </button>

  {#if mouseOver || multiSelected}
    <button
      type="button"
      onclick={handleMultiSelectClicked}
      class="absolute inset-e-0 top-4 p-3 hover:cursor-pointer focus:outline-none"
      role="checkbox"
      tabindex={-1}
      aria-checked={selected}
    >
      {#if multiSelected}
        <div class="rounded-full">
          <Icon icon={mdiCheckCircle} size="24" class="text-primary" />
        </div>
      {:else}
        <Icon icon={mdiCheckCircle} size="24" class="text-gray-300 hover:text-primary/75" />
      {/if}
    </button>
  {/if}
</div>
