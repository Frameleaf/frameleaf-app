<script lang="ts">
  /**
   * Frameleaf Folders browser (FL-46). The Frameleaf UI is the only UI here now: see
   * `$lib/components/frameleaf/FolderBrowserPanel.svelte`, built on the existing
   * `foldersStore` (`GET /view/folder/unique-paths`, `GET /view/folder`).
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
  <FolderBrowserPanel tree={data.tree} pathAssets={data.pathAssets} />
</UserPageLayout>
