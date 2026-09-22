<script lang="ts">
  /**
   * Frameleaf Tags browser (FL-46). The Frameleaf UI is the only UI here now: see
   * `$lib/components/frameleaf/TagBrowserPanel.svelte` for the tree/detail/dialog behavior and
   * `$lib/frameleaf/tag-tree.ts` for the tree adapter it is built on.
   */
  import TagBrowserPanel from '$lib/components/frameleaf/TagBrowserPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <TagBrowserPanel tags={data.tags} path={data.path} />
</UserPageLayout>
