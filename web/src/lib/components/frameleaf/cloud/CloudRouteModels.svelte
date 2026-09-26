<script lang="ts">
  /**
   * The Frameleaf Cloud model pickers for one kind of work in Where each job runs and on the Cloud
   * processing page (FL-186). One picker per workload the kind of work covers: restoration has one for
   * faithful and one for creative. A model is saved on the workload's route, so a workload must be
   * routed to Frameleaf Cloud (Processing destinations) before its model can be chosen; until then
   * this says so instead of offering a choice that could not be kept.
   */
  import CloudModelPicker from '$lib/components/frameleaf/cloud/CloudModelPicker.svelte';
  import { workloadNameKey, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
  import { catalogModelsFor, cloudRouteFor, cloudWorkloadsFor } from '$lib/frameleaf/cloud-models';
  import { mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import type { CloudMlModelDto, MlWorkloadRouteDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    row: RoutedWorkload;
    /** The catalogue's models, or null while it is being read or when it could not be. */
    catalog: CloudMlModelDto[] | null;
    catalogFailed: boolean;
    routes: MlWorkloadRouteDto[];
    /** The Frameleaf Cloud destination, once added. */
    cloudDestinationId: string | null;
    disabled?: boolean;
    onSaved: (routes: MlWorkloadRouteDto[], message: string) => void;
  };

  let { row, catalog, catalogFailed, routes, cloudDestinationId, disabled = false, onSaved }: Props = $props();

  const workloads = $derived(cloudWorkloadsFor(row));
</script>

{#if !cloudDestinationId}
  <p class="fc-muted">{$t('admin.frameleaf_cloud_model_no_destination')}</p>
{:else if catalogFailed}
  <p class="fc-routing-summary is-warning" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
{:else if catalog}
  {#each workloads as workload (workload)}
    {@const name = workloads.length > 1 ? $t(mlWorkloadLabelKey(workload)) : $t(workloadNameKey(row))}
    {@const route = cloudRouteFor(routes, workload, cloudDestinationId)}
    {#if route}
      <CloudModelPicker
        {workload}
        {name}
        models={catalogModelsFor(catalog, workload)}
        modelId={route.modelId}
        destinationId={cloudDestinationId}
        {disabled}
        {onSaved}
      />
    {:else}
      <p class="fc-muted">{$t('admin.frameleaf_cloud_model_route_first', { values: { name } })}</p>
    {/if}
  {/each}
{/if}
