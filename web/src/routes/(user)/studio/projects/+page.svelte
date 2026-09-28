<script lang="ts">
  import StudioProjectLibrary from '$lib/components/frameleaf/StudioProjectLibrary.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<!-- Studio is a top bar workspace with no library rail, as in the prototype (FL-30). -->
<UserPageLayout title={data.meta.title} rail={false}>
  <StudioProjectLibrary shelf={data.shelf} />
</UserPageLayout>
