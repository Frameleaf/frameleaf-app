<script lang="ts">
  /**
   * Frameleaf Tags browser (FL-46). See `$lib/components/frameleaf/TagBrowserPanel.svelte` for the
   * tree, detail and dialogs and `$lib/frameleaf/tag-tree.ts` for the tree adapter. The viewer is
   * mounted over the chosen tag's preview items, so an address that opens one of them still works.
   */
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import TagBrowserPanel from '$lib/components/frameleaf/TagBrowserPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { AssetResponseDto } from '@immich/sdk';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  let covers = $state<AssetResponseDto[]>([]);
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <TagBrowserPanel tags={data.tags} statistics={data.statistics} path={data.path} bind:covers />
</UserPageLayout>

<ResultsAssetViewer
  assets={covers}
  onAssetChange={(asset) => (covers = covers.map((cover) => (cover.id === asset.id ? asset : cover)))}
  onRemove={(id) => (covers = covers.filter((cover) => cover.id !== id))}
/>
