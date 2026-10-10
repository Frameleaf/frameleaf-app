<script lang="ts">
  /**
   * The model slider of one Frameleaf Cloud job (FL-162; prototype ModelSlider.jsx and gpu-models.css):
   * the models Frameleaf Cloud offers for this work, light → heavy, on the blue band (every stop runs on
   * Frameleaf Cloud). Each stop has an icon and a text label and the chosen stop a full line with its GPU
   * class and price, so colour is never the only signal. Native radio buttons: arrow keys move between
   * the stops. Choosing another model asks for a new estimate; nothing is sent until it is confirmed.
   */
  import './gpu-models.css';
  import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
  import type { CloudMlJobModelDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCloudOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    models: CloudMlJobModelDto[];
    value: string | null;
    label: string;
    disabled?: boolean;
    onChange?: (sku: string) => void;
  };

  let { models, value, label, disabled = false, onChange }: Props = $props();

  const id = $props.id();
  const selected = $derived(models.find((model) => model.sku === value) ?? null);

  /** "L40S-class, 48 GB · $0.0781 per minute of GPU time + $0.10 start fee". */
  const rateText = (model: CloudMlJobModelDto) =>
    $t('frameleaf_cloud_job_model_rate', {
      values: { gpu: model.gpu, rate: formatRatePerMinute(model.perSecondUsd), fee: formatUsd(model.startFeeUsd) },
    });
</script>

<fieldset class="ms" data-workload="cloud" {disabled}>
  <legend class="ms-legend">{label}</legend>
  <div class="ms-track" style:--ms-count={models.length}>
    {#each models as model (model.sku)}
      {@const checked = model.sku === value}
      <label class="ms-stop is-cloud" class:is-selected={checked} title="{model.label} · {rateText(model)}">
        <input
          type="radio"
          class="sr-only"
          name="{id}-model"
          value={model.sku}
          {checked}
          onchange={() => onChange?.(model.sku)}
        />
        <span class="ms-band" aria-hidden="true"></span>
        <span class="ms-knob" aria-hidden="true"></span>
        <span class="ms-stop-name" aria-hidden="true">
          <Icon icon={mdiCloudOutline} size="14" />
          <span>{model.label}</span>
        </span>
        <span class="sr-only">{model.label}: {rateText(model)}</span>
      </label>
    {/each}
  </div>
  <div class="ms-scale" aria-hidden="true">
    <span>{$t('frameleaf_model_scale_lighter')}</span>
    <span>{$t('frameleaf_model_scale_heavier')}</span>
  </div>
  {#if selected}
    <p class="ms-readout is-cloud" aria-live="polite">
      <Icon icon={mdiCloudOutline} size="16" aria-hidden={true} />
      <span>
        <strong>{selected.label}</strong> · {rateText(selected)}
        <small>{$t('frameleaf_model_key_cloud')}</small>
      </span>
    </p>
  {/if}
</fieldset>
