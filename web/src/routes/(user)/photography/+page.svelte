<script lang="ts">
  import PhotographyWorkspace from '$lib/components/frameleaf/PhotographyWorkspace.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout title={data.meta.title} rail={false}><PhotographyWorkspace /></UserPageLayout>
