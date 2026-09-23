<script lang="ts">
  /**
   * Processing destinations (FL-110). The page only loads the server's destination model and
   * hands it to the panel; every change goes back through the ml-destinations endpoints.
   */
  import MlDestinationsPanel from '$lib/components/frameleaf/MlDestinationsPanel.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Container } from '@immich/ui';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();
</script>

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-6">
    <MlDestinationsPanel destinations={data.destinations} routes={data.routes} />
  </Container>
</AdminPageLayout>
