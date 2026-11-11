<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import CreatorsWorkspace from '$lib/components/frameleaf/creators/CreatorsWorkspace.svelte';
  import LibraryItemsView from '$lib/components/frameleaf/LibraryItemsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { contextDiscoveryQuery, discoveryUrl } from '$lib/components/discovery/query';
  import { isCreatorsArea } from '$lib/frameleaf/creators';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { AssetTypeEnum, LibraryItemSearchKind, LibraryScope } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  const query = $derived(contextDiscoveryQuery(new URL(page.url.href)));
  /** Boards' other area (FL-1448): `?area=creators`, with its own page; Items is everything else. */
  const creators = $derived(isCreatorsArea(new URL(page.url.href)));
  /** The rail's Links view: `?kinds=bookmark`. */
  const kinds = $derived(
    page.url.searchParams.get('kinds') === LibraryItemSearchKind.Bookmark
      ? [LibraryItemSearchKind.Bookmark]
      : undefined,
  );
  /**
   * Prototype ProWorkspace.jsx: the heading names the rail view on show (All items, Images, Videos,
   * Links, Unfiled), as the rail marks it; the tab title stays "Boards".
   */
  const viewTitle = $derived.by(() => {
    if (kinds) {
      return $t('frameleaf_boards_links');
    }
    const filter = query.filter as { type?: { eq?: string }; hasAlbums?: { eq?: boolean } };
    if (filter.type?.eq === AssetTypeEnum.Image) {
      return $t('frameleaf_boards_images');
    }
    if (filter.type?.eq === AssetTypeEnum.Video) {
      return $t('frameleaf_boards_videos');
    }
    if (filter.hasAlbums?.eq === false) {
      return $t('frameleaf_pro_unfiled');
    }
    return $t('frameleaf_boards_all_items');
  });
  /** The extension's "Open" for a saved link: `?bookmark=<id>` opens that link in the inspector. */
  const bookmark = $derived(page.url.searchParams.get('bookmark') ?? undefined);
  /** Filtering inside Links stays in Links. */
  const withKinds = (href: string) => {
    if (!kinds) {
      return href;
    }
    const url = new URL(href, page.url.origin);
    url.searchParams.set('kinds', LibraryItemSearchKind.Bookmark);
    return url.pathname + url.search;
  };
</script>

<UserPageLayout
  fill
  scrollbar={false}
  onUploadClick={() => void openFileUploadDialog({ libraryScope: LibraryScope.Design })}
>
  {#if creators}
    <CreatorsWorkspace />
  {:else}
    <LibraryItemsView
      title={viewTitle}
      {query}
      {kinds}
      {bookmark}
      onQueryChange={(next) => void goto(withKinds(discoveryUrl(next)), { replace: true, reset: false })}
      onKindsChange={(next, nextQuery) => {
        // The Type menu's Links is the rail's Links view: `?kinds=bookmark` beside the query.
        const url = new URL(discoveryUrl(nextQuery), page.url.origin);
        if (next?.length) {
          url.searchParams.set('kinds', next.join(','));
        } else {
          url.searchParams.delete('kinds');
        }
        void goto(url.pathname + url.search, { replace: true, reset: false });
      }}
    />
  {/if}
</UserPageLayout>
