<script lang="ts">
  /**
   * Compute & jobs: Workers & endpoints (FL-72) above Processing destinations (FL-110), in the
   * order the prototype shows them. The page only loads the server's worker inventory and
   * destination model and hands them to the panels; every change goes back through the
   * ml-destinations, system-config and render-worker endpoints. A change saved in the
   * destinations panel reloads the inventory so the two never disagree for long.
   */
  import MlDestinationsPanel from '$lib/components/frameleaf/MlDestinationsPanel.svelte';
  import WorkerInventoryPanel from '$lib/components/frameleaf/WorkerInventoryPanel.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Container } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  let inventoryKey = $state(0);
</script>

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-6">
    <div id="workers">
      {#if data.inventory}
        <WorkerInventoryPanel inventory={data.inventory} destinations={data.destinations} refreshKey={inventoryKey} />
      {:else}
        <p role="alert">{$t('admin.frameleaf_workers_error_load')}</p>
      {/if}
    </div>
    <div id="ml-destinations">
      <MlDestinationsPanel
        destinations={data.destinations}
        routes={data.routes}
        onChanged={() => (inventoryKey += 1)}
      />
    </div>
  </Container>
</AdminPageLayout>
