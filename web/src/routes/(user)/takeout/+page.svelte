<script lang="ts">
  import TakeoutWizard from '$lib/components/frameleaf/TakeoutWizard.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout title={data.meta.title}>
  <!-- A different import, or none, is a fresh wizard: its state is the server's, never the last one's. -->
  {#key data.current?.id}
    <TakeoutWizard imports={data.imports} current={data.current} />
  {/key}
</UserPageLayout>
