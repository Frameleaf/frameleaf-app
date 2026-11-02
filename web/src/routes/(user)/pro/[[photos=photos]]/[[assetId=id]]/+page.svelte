<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import LibraryItemsView from '$lib/components/frameleaf/LibraryItemsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { contextDiscoveryQuery, discoveryUrl } from '$lib/components/discovery/query';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { LibraryItemSearchKind, LibraryScope } from '@frameleaf/sdk';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  const query = $derived(contextDiscoveryQuery(new URL(page.url.href)));
  /** The rail's Links view: `?kinds=bookmark`. */
  const kinds = $derived(
    page.url.searchParams.get('kinds') === LibraryItemSearchKind.Bookmark
      ? [LibraryItemSearchKind.Bookmark]
      : undefined,
  );
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
  <LibraryItemsView
    title={data.meta.title}
    {query}
    {kinds}
    {bookmark}
    onQueryChange={(next) => void goto(withKinds(discoveryUrl(next)), { replace: true, reset: false })}
  />
</UserPageLayout>
