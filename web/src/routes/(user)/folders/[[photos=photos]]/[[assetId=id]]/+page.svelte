<script lang="ts">
  /**
   * Frameleaf Folders browser (FL-46). See `$lib/components/frameleaf/FolderBrowserPanel.svelte`,
   * built on `foldersStore` (`GET /view/folder/summary`, `GET /view/folder`). The page is always
   * reachable by its address, whatever the rail shows: the rail honours the account's Folders
   * preferences, the page and the server's access checks do not.
   */
  import FolderBrowserPanel from '$lib/components/frameleaf/FolderBrowserPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <FolderBrowserPanel tree={data.tree} path={data.path} assets={data.assets} />
</UserPageLayout>
