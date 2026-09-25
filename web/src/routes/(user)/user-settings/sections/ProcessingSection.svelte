<script lang="ts">
  /**
   * Compute & jobs: Workers & endpoints (FL-72) and Workload destinations (FL-110), two sections of
   * the Command Center as in the prototype; the old `/admin/processing-destinations` page only
   * redirects here. The section only loads the server's worker inventory and destination model and
   * hands them to the panels; every change goes back through the ml-destinations, system-config and
   * render-worker endpoints. A change saved in the destinations panel reloads the inventory.
   */
  import MlDestinationsPanel from '$lib/components/frameleaf/MlDestinationsPanel.svelte';
  import WorkloadRoutingTable from '$lib/components/frameleaf/cloud/WorkloadRoutingTable.svelte';
  import WorkerInventoryPanel from '$lib/components/frameleaf/WorkerInventoryPanel.svelte';
  import { t } from 'svelte-i18n';
  import type { ProcessingData } from './loaders';

  type Props = {
    section: 'workers' | 'routing';
    data: ProcessingData;
  };

  const { section, data }: Props = $props();

  let inventoryKey = $state(0);
</script>

{#if section === 'workers'}
  <div id="workers">
    {#if data.inventory}
      <WorkerInventoryPanel inventory={data.inventory} destinations={data.destinations} refreshKey={inventoryKey} />
    {:else}
      <p role="alert">{$t('admin.frameleaf_workers_error_load')}</p>
    {/if}
  </div>
{:else}
  <div id="ml-destinations" class="routing-section">
    <!-- FL-159 (handoff §3.2): "Where each job runs" first, then the destinations each workload uses. -->
    <WorkloadRoutingTable />
    <MlDestinationsPanel destinations={data.destinations} routes={data.routes} onChanged={() => (inventoryKey += 1)} />
  </div>
{/if}

<style>
  .routing-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
