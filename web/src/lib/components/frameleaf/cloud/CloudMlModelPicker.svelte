<script lang="ts">
  /**
   * The catalogue model one workload uses on Frameleaf Cloud (FL-159). It replaces the prototype's
   * GPU and runtime pickers (`.jm-launch-fields`, JobsManager.jsx:1550-1583): there is no hardware to
   * rent, only a model from the catalogue Frameleaf Cloud offers now, with its price per unit. The
   * choice is saved on the workload's route, so it applies only while the workload is routed here;
   * a model the cloud has since retired shows as unavailable and admission refuses it rather than
   * choosing another.
   */
  import { formatUnitPrice, modelsFor } from '$lib/frameleaf/cloud-ml';
  import { mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import { handleError } from '$lib/utils/handle-error';
  import { setMlWorkloadRoute, type CloudMlModelDto, type MlWorkload, type MlWorkloadRouteDto } from '@immich/sdk';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    workload: MlWorkload;
    destinationId: string;
    models: CloudMlModelDto[];
    route: MlWorkloadRouteDto | undefined;
    disabled?: boolean;
    onChanged?: () => void;
  };

  let { workload, destinationId, models, route, disabled = false, onChanged }: Props = $props();

  const selectId = $props.id();
  const routedHere = $derived(route?.destinationId === destinationId);
  const options = $derived(modelsFor(models, workload));
  const current = $derived(routedHere ? (route?.modelId ?? null) : null);
  const currentModel = $derived(options.find((model) => model.id === current));
  let saving = $state(false);

  const choose = async (modelId: string) => {
    saving = true;
    try {
      await setMlWorkloadRoute({
        workload,
        mlWorkloadRouteUpdateDto: { destinationId, modelId: modelId || null },
      });
      onChanged?.();
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_model_error'));
    } finally {
      saving = false;
    }
  };

  const optionText = (model: CloudMlModelDto) =>
    model.priceUsd === null
      ? model.name
      : $t('admin.frameleaf_cloud_ml_model_option_price', {
          values: {
            name: model.name,
            price: formatUnitPrice(model.priceUsd, $locale),
            unit: model.pricingUnit ?? $t('admin.frameleaf_cloud_ml_model_unit_request'),
          },
        });
</script>

<div class="picker">
  <label for={selectId}>{$t(mlWorkloadLabelKey(workload))}</label>
  {#if !routedHere}
    <p class="muted">{$t('admin.frameleaf_cloud_ml_model_not_routed')}</p>
  {:else if options.length === 0}
    <p class="muted">{$t('admin.frameleaf_cloud_ml_model_none_offered')}</p>
  {:else}
    <select
      id={selectId}
      value={currentModel ? currentModel.id : ''}
      disabled={disabled || saving}
      onchange={(event) => void choose(event.currentTarget.value)}
    >
      <option value="">{$t('admin.frameleaf_cloud_ml_model_cloud_default')}</option>
      {#each options as model (model.id)}
        <option value={model.id}>{optionText(model)}</option>
      {/each}
    </select>
    {#if current && !currentModel}
      <p class="warning" role="status">{$t('admin.frameleaf_cloud_ml_model_retired', { values: { id: current } })}</p>
    {:else if currentModel?.description}
      <p class="muted">{currentModel.description}</p>
    {/if}
  {/if}
</div>

<style>
  /* jobs-manager.css:845-853 `.jm-launch-fields label` and its selects. */
  .picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  label {
    color: var(--fl-muted);
  }
  select {
    width: 100%;
    min-width: 0;
    padding: 0.4375rem 0.625rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-muted);
    border-radius: var(--fl-radius-control);
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--fl-muted);
  }
  .warning {
    color: var(--fl-warning);
  }
</style>
