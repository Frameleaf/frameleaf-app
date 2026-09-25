<script lang="ts">
  /**
   * Draws a Command Center section that is a page of its own rather than a settings form (FL-71):
   * the old administration pages (deduplication, Compute & jobs, Maintenance, Users), the account's
   * Trash and repair queues, and the account settings (`UserSettingsList`).
   */
  import CloudMlSection from '$lib/components/frameleaf/cloud/CloudMlSection.svelte';
  import HardwareSection from '$lib/components/frameleaf/cloud/HardwareSection.svelte';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import UserSettingsList from '../UserSettingsList.svelte';
  import DeduplicationSection from './DeduplicationSection.svelte';
  import EnrichmentCareSection from './EnrichmentCareSection.svelte';
  import Loader from './Loader.svelte';
  import { loadProcessing, loadRenderWorkers } from './loaders';
  import MaintenanceSection from './MaintenanceSection.svelte';
  import ProcessingSection from './ProcessingSection.svelte';
  import QueuesSection from './QueuesSection.svelte';
  import RenderWorkersSection from './RenderWorkersSection.svelte';
  import RepairSection from './RepairSection.svelte';
  import TrashSection from './TrashSection.svelte';
  import UsersSection from './UsersSection.svelte';

  let { section }: { section: SettingsHostSection } = $props();

  const MAINTENANCE = ['mode', 'backups', 'integrity'] as const;
  const maintenanceSection = $derived(MAINTENANCE.find((key) => key === section.key));
</script>

{#if section.admin}
  {#if section.key === 'deduplication'}
    <DeduplicationSection />
  {:else if section.key === 'workers' || section.key === 'routing'}
    {@const key = section.key}
    <Loader load={loadProcessing}>
      {#snippet children(data)}
        <ProcessingSection section={key} {data} />
      {/snippet}
    </Loader>
  {:else if section.key === 'queues'}
    <QueuesSection />
  {:else if section.key === 'cloud-processing'}
    <CloudMlSection />
  {:else if section.key === 'hardware'}
    <HardwareSection />
  {:else if section.key === 'render-workers'}
    <Loader load={loadRenderWorkers}>
      {#snippet children(data)}
        <RenderWorkersSection {data} />
      {/snippet}
    </Loader>
  {:else if maintenanceSection}
    <MaintenanceSection section={maintenanceSection} />
  {:else if section.key === 'accounts'}
    <UsersSection />
  {:else if section.key === 'enrichment-care'}
    <EnrichmentCareSection />
  {/if}
{:else if section.key === 'repair'}
  <RepairSection />
{:else if section.key === 'contents'}
  <TrashSection />
{:else}
  <UserSettingsList section={section.key} />
{/if}
