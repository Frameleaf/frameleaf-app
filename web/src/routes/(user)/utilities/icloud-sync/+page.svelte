<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';
  import ICloudSync from './ICloudSync.svelte';

  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout title={data.meta.title}>
  <ICloudSync initial={data.initial} />
</UserPageLayout>
