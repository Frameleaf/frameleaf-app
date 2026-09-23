<script lang="ts">
  import StudioProjectLibrary from '$lib/components/frameleaf/StudioProjectLibrary.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout title={data.meta.title}>
  <StudioProjectLibrary shelf={data.shelf} />
</UserPageLayout>
