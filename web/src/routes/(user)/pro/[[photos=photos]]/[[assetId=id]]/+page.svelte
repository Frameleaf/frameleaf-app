<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import LibraryItemsView from '$lib/components/frameleaf/LibraryItemsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { contextDiscoveryQuery, discoveryUrl } from '$lib/components/discovery/query';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { LibraryScope } from '@frameleaf/sdk';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  const query = $derived(contextDiscoveryQuery(new URL(page.url.href)));
</script>

<UserPageLayout
  fill
  scrollbar={false}
  onUploadClick={() => void openFileUploadDialog({ libraryScope: LibraryScope.Design })}
>
  <LibraryItemsView
    title={data.meta.title}
    {query}
    onQueryChange={(next) => void goto(discoveryUrl(next), { replace: true, reset: false })}
  />
</UserPageLayout>
