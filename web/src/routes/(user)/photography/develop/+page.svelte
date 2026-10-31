<script lang="ts">
  import { goto } from '$app/navigation';
  import PhotographyDevelop from '$lib/components/frameleaf/develop/PhotographyDevelop.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout rail={false} fill>
  {#key `${data.shootId}:${data.photoId}:${data.only?.join(',')}`}
    <PhotographyDevelop
      shootId={data.shootId}
      photoId={data.photoId}
      only={data.only}
      onBack={() => goto(Route.photography({ shoot: data.shootId || undefined }))}
      onProof={() => goto(Route.photography({ shoot: data.shootId || undefined, section: 'galleries' }))}
    />
  {/key}
</UserPageLayout>
