<script lang="ts">
  /**
   * Frameleaf Memories index (FL-62). The Frameleaf UI is the only UI here now: see
   * `$lib/components/frameleaf/MemoriesPanel.svelte` for the card grid, settings and
   * per-memory actions, built on the existing `memoryManager` and memories API.
   */
  import MemoriesPanel from '$lib/components/frameleaf/MemoriesPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <MemoriesPanel />
</UserPageLayout>
