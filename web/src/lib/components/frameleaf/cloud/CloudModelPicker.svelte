<script lang="ts">
  /**
   * The Frameleaf Cloud model for one workload (FL-186; prototype WorkloadRouting.jsx `DefaultModelSlider`
   * and ModelSlider.jsx, gpu-models.css). The stops are the models Frameleaf Cloud's catalogue offers
   * for exactly this workload, lightest first, on the slider's blue band; restoration's faithful and
   * creative modes each have their own picker. Choosing a stop saves its SKU on the workload's route
   * at once, and admission names it for every cloud job of this workload. With no model chosen, the
   * model the catalogue recommends is used and marked; where it recommends none, and always for
   * Studio AI, the picker asks for a choice, because those jobs are refused until one is made.
   * Built on native radio buttons, so arrow keys move between the models.
   */
  import './gpu-models.css';
  import { cloudModelChoice, takesCatalogDefault } from '$lib/frameleaf/cloud-models';
  import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import { setMlWorkloadRoute, type CloudMlModelDto, type MlWorkload, type MlWorkloadRouteDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiCloudOutline, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    workload: MlWorkload;
    /** The catalogue models for exactly this workload, lightest first. */
    models: CloudMlModelDto[];
    /** The model saved on the route, or null for the catalogue's recommendation. */
    modelId: string | null;
    /** The Frameleaf Cloud destination the route points at. */
    destinationId: string;
    /** The name of the work, as Where each job runs shows it. */
    name: string;
    disabled?: boolean;
    onSaved: (routes: MlWorkloadRouteDto[], message: string) => void;
  };

  let { workload, models, modelId, destinationId, name, disabled = false, onSaved }: Props = $props();

  const id = $props.id();
  let saving = $state(false);
  /** Redrawn after a failed save, so the radios show the saved model again. */
  let revision = $state(0);

  const choice = $derived(cloudModelChoice(models, workload, modelId));
  const selectedId = $derived(choice.kind === 'chosen' || choice.kind === 'default' ? choice.model.id : null);
  const recommended = $derived(takesCatalogDefault(workload) ? models.find((model) => model.isDefault) : undefined);

  const price = (model: CloudMlModelDto) => {
    if (model.priceUsd === null) {
      return $t('admin.frameleaf_cloud_model_price_unknown');
    }
    return model.pricingUnit === 'second'
      ? $t('admin.frameleaf_cloud_model_price_minute', { values: { rate: formatRatePerMinute(model.priceUsd) } })
      : $t('admin.frameleaf_cloud_model_price_unit', {
          values: { price: formatUsd(model.priceUsd), unit: model.pricingUnit ?? '' },
        });
  };

  const save = async (next: string | null) => {
    if (saving || next === modelId) {
      return;
    }
    saving = true;
    try {
      const { routes } = await setMlWorkloadRoute({
        workload,
        mlWorkloadRouteUpdateDto: { destinationId, modelId: next },
      });
      const model = next ? models.find((entry) => entry.id === next) : undefined;
      onSaved(
        routes,
        model
          ? $t('admin.frameleaf_cloud_model_saved', { values: { model: model.name, name } })
          : $t('admin.frameleaf_cloud_model_saved_default', { values: { name } }),
      );
    } catch (error) {
      revision += 1;
      handleError(error, $t('admin.frameleaf_cloud_model_error_save', { values: { name } }));
    } finally {
      saving = false;
    }
  };
</script>

<fieldset class="ms" data-workload={workload} disabled={disabled || saving} aria-busy={saving}>
  <legend class="ms-legend">{$t('admin.frameleaf_cloud_model_for', { values: { name } })}</legend>
  {#if models.length === 0}
    <p class="ms-readout is-none" role="status">
      <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
      <span>{$t('admin.frameleaf_cloud_model_empty')}</span>
    </p>
  {:else}
    {#key revision}
      <div class="ms-track" style:--ms-count={models.length}>
        {#each models as model (model.id)}
          {@const checked = model.id === selectedId}
          <label class="ms-stop is-cloud" class:is-selected={checked} title="{model.name} · {price(model)}">
            <input
              type="radio"
              class="sr-only"
              name="{id}-model"
              value={model.id}
              {checked}
              onchange={() => save(model.id)}
            />
            <span class="ms-band" aria-hidden="true"></span>
            <span class="ms-knob" aria-hidden="true"></span>
            <span class="ms-stop-name" aria-hidden="true">
              <Icon icon={model.id === recommended?.id ? mdiStarOutline : mdiCloudOutline} size="14" />
              <span>{model.name}</span>
            </span>
            <span class="sr-only">
              {model.name}: {price(model)}{model.id === recommended?.id
                ? `. ${$t('admin.frameleaf_cloud_model_recommended')}`
                : ''}
            </span>
          </label>
        {/each}
      </div>
    {/key}
    <div class="ms-scale" aria-hidden="true">
      <span>{$t('frameleaf_model_scale_lighter')}</span>
      <span>{$t('frameleaf_model_scale_heavier')}</span>
    </div>
    {#if choice.kind === 'chosen' || choice.kind === 'default'}
      <p class="ms-readout is-cloud" aria-live="polite">
        <Icon icon={mdiCloudOutline} size="16" aria-hidden={true} />
        <span>
          <strong>{choice.model.name}</strong> · {price(choice.model)}
          <small>
            {choice.model.description}.
            {#if choice.model.id === recommended?.id}
              {$t('admin.frameleaf_cloud_model_recommended_note')}
            {/if}
            {#if choice.kind === 'default'}
              {$t('admin.frameleaf_cloud_model_using_default')}
            {/if}
          </small>
        </span>
      </p>
    {:else}
      <p class="ms-readout is-none" role="status">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        <span>
          {#if choice.kind === 'missing'}
            {$t('admin.frameleaf_cloud_model_missing', { values: { model: choice.id } })}
          {:else if takesCatalogDefault(workload)}
            {$t('admin.frameleaf_cloud_model_none')}
          {:else}
            {$t('admin.frameleaf_cloud_model_none_studio')}
          {/if}
        </span>
      </p>
    {/if}
    {#if recommended && modelId !== null && modelId !== recommended.id}
      <button type="button" class="fc-link" onclick={() => save(null)}>
        {$t('admin.frameleaf_cloud_model_use_recommended', { values: { model: recommended.name } })}
      </button>
    {/if}
    <ul class="ms-key" aria-label={$t('frameleaf_model_key_label')}>
      <li class="is-cloud">
        <Icon icon={mdiCloudOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_model_key_cloud')}
      </li>
      {#if recommended}
        <li>
          <Icon icon={mdiStarOutline} size="14" aria-hidden={true} />
          {$t('admin.frameleaf_cloud_model_recommended')}
        </li>
      {/if}
    </ul>
  {/if}
</fieldset>
