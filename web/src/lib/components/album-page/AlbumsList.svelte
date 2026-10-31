<script lang="ts">
  import AlbumCardGroup from '$lib/components/album-page/AlbumCardGroup.svelte';
  import AlbumsTable from '$lib/components/album-page/AlbumsTable.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import {
    AlbumFilter,
    AlbumGroupBy,
    AlbumSortBy,
    AlbumViewMode,
    locale,
    SortOrder,
    type AlbumViewSettings,
  } from '$lib/stores/preferences.store';
  import {
    getSelectedAlbumGroupOption,
    groupAlbumsByYear,
    groupAlbumsByOwner,
    createAlbumSearchPredicate,
    sortAlbums,
    stringToSortOrder,
    type AlbumGroup,
  } from '$lib/utils/album-utils';
  import { AlbumUserRole, type AlbumResponseDto, type SharedLinkResponseDto } from '@frameleaf/sdk';
  import { type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    ownedAlbums?: AlbumResponseDto[];
    sharedAlbums?: AlbumResponseDto[];
    searchQuery?: string;
    userSettings: AlbumViewSettings;
    showOwner?: boolean;
    albumGroupIds?: string[];
    getAlbumHref?: (album: AlbumResponseDto) => string;
    onAlbumDrop?: (draggedId: string, targetAlbum: AlbumResponseDto) => void;
    canAcceptDrop?: (draggedId: string, targetAlbum: AlbumResponseDto) => boolean;
    draggedId?: string | null;
    empty?: Snippet;
  }

  let {
    ownedAlbums = $bindable([]),
    sharedAlbums = $bindable([]),
    searchQuery = '',
    userSettings,
    showOwner = false,
    // eslint-disable-next-line no-useless-assignment
    albumGroupIds = $bindable([]),
    getAlbumHref = Route.viewAlbum,
    onAlbumDrop = undefined,
    canAcceptDrop = undefined,
    draggedId = $bindable(null),
    empty,
  }: Props = $props();

  interface AlbumGroupOption {
    [option: string]: (order: SortOrder, albums: AlbumResponseDto[]) => AlbumGroup[];
  }

  const groupOptions: AlbumGroupOption = {
    /** No grouping */
    [AlbumGroupBy.None]: (order, albums): AlbumGroup[] => {
      return [
        {
          id: $t('albums'),
          name: $t('albums'),
          albums,
        },
      ];
    },

    [AlbumGroupBy.Year]: (order, albums) =>
      groupAlbumsByYear(albums, order, userSettings.sortBy === AlbumSortBy.OldestPhoto, $t('unknown_year')),
    [AlbumGroupBy.Owner]: (order, albums) =>
      groupAlbumsByOwner(albums, order, authManager.user.id, $locale, $t('my_albums')),
  };

  let albums = $derived.by(() => {
    switch (userSettings.filter) {
      case AlbumFilter.Owned: {
        return ownedAlbums;
      }
      case AlbumFilter.Shared: {
        return sharedAlbums;
      }
      default: {
        const nonOwnedAlbums = sharedAlbums.filter(
          (album) =>
            album.albumUsers.find(({ user: { id } }) => id === authManager.user.id)?.role !== AlbumUserRole.Owner,
        );
        return nonOwnedAlbums.length > 0 ? ownedAlbums.concat(nonOwnedAlbums) : ownedAlbums;
      }
    }
  });
  let filteredAlbums = $derived(searchQuery ? albums.filter(createAlbumSearchPredicate(searchQuery)) : albums);

  let albumGroupOption = $derived(getSelectedAlbumGroupOption(userSettings));
  let groupedAlbums = $derived.by(() => {
    const groupFunc = groupOptions[albumGroupOption] ?? groupOptions[AlbumGroupBy.None];
    const groupedAlbums = groupFunc(stringToSortOrder(userSettings.groupOrder), filteredAlbums);

    return groupedAlbums.map((group) => ({
      id: group.id,
      name: group.name,
      albums: sortAlbums(group.albums, { sortBy: userSettings.sortBy, orderBy: userSettings.sortOrder }),
    }));
  });

  // TODO get rid of this
  $effect(() => {
    albumGroupIds = groupedAlbums.map(({ id }) => id);
  });

  const findAndUpdate = (albums: AlbumResponseDto[], album: AlbumResponseDto) => {
    const target = albums.find(({ id }) => id === album.id);
    if (target) {
      Object.assign(target, album);
    }

    return albums;
  };

  const onAlbumUpdate = (album: AlbumResponseDto) => {
    ownedAlbums = findAndUpdate(ownedAlbums, album);
    sharedAlbums = findAndUpdate(sharedAlbums, album);
  };

  const onAlbumDelete = (album: AlbumResponseDto) => {
    ownedAlbums = ownedAlbums.filter(({ id }) => id !== album.id);
    sharedAlbums = sharedAlbums.filter(({ id }) => id !== album.id);
  };

  const onSharedLinkCreate = (sharedLink: SharedLinkResponseDto) => {
    if (sharedLink.album) {
      onAlbumUpdate(sharedLink.album);
    }
  };
</script>

<OnEvents {onAlbumUpdate} {onAlbumDelete} {onSharedLinkCreate} />

{#if albums.length > 0}
  {#if userSettings.view === AlbumViewMode.Cover}
    <!-- Album Cards -->
    {#if albumGroupOption === AlbumGroupBy.None}
      <AlbumCardGroup
        albums={groupedAlbums[0].albums}
        {showOwner}
        showDateRange
        showItemCount
        {getAlbumHref}
        {onAlbumDrop}
        {canAcceptDrop}
        bind:draggedId
      />
    {:else}
      {#each groupedAlbums as albumGroup (albumGroup.id)}
        <AlbumCardGroup
          albums={albumGroup.albums}
          group={albumGroup}
          {showOwner}
          showDateRange
          showItemCount
          {getAlbumHref}
          {onAlbumDrop}
          {canAcceptDrop}
          bind:draggedId
        />
      {/each}
    {/if}
  {:else if userSettings.view === AlbumViewMode.List}
    <!-- Album Table -->
    <AlbumsTable {groupedAlbums} {albumGroupOption} />
  {/if}
{:else}
  <!-- Empty Message -->
  {@render empty?.()}
{/if}
