<script lang="ts">
  import ActivityView from '$lib/components/frameleaf/ActivityView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout title={data.meta.title}>
  <ActivityView filter={data.filter} />
</UserPageLayout>
