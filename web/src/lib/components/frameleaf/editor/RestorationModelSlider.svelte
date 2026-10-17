<script lang="ts">
  /**
   * FL-423: the Enhance card's model slider (prototype Editor.jsx:1884-1890 and ModelSlider.jsx, styled
   * by gpu-models.css like every model slider). Its stops are the models the computer at home really
   * runs, lighter to heavier, then Frameleaf Cloud in blue, whose model and cost are chosen with its
   * estimate. Choosing a stop chooses the model the restoration request names; a stop that is not ready
   * stays visible, crossed out with the reason. Native radio buttons, so arrow keys move between the
   * stops that can be chosen, and every stop says where it runs in words as well as colour.
   */
  import '$lib/components/frameleaf/cloud/gpu-models.css';
  import { restorationModeHelpKey, type EnhanceStop } from '$lib/frameleaf/restoration';
  import { Icon } from '@frameleaf/ui';
  import { mdiCancel, mdiChip, mdiCloudOutline, mdiExpansionCard, mdiInformationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    stops: EnhanceStop[];
    value: string | null;
    label: string;
    /** The computer at home the local stops run on: its name, or null for this server. */
    computer: string | null;
    /** The GPU it reported, for the legend. */
    gpu: { name: string; vramGb: number } | null;
    /** Said in place of the local stops when no computer at home can take the work. */
    noLocalReason?: string;
    disabled?: boolean;
    onChange?: (stop: EnhanceStop) => void;
  };

  let { stops, value, label, computer, gpu, noLocalReason = '', disabled = false, onChange }: Props = $props();

  const id = $props.id();
  const ICONS = { cpu: mdiChip, gpu: mdiExpansionCard, cloud: mdiCloudOutline } as const;

  const selected = $derived(stops.find((stop) => stop.id === value) ?? null);
  const where = $derived(
    computer ? $t('frameleaf_enhance_model_on', { values: { computer } }) : $t('frameleaf_enhance_model_here'),
  );
  const nameOf = (stop: EnhanceStop) =>
    stop.runsOn === 'cloud' ? $t('frameleaf_enhance_model_cloud') : stop.name || $t('frameleaf_enhance_model_own');
  const reasonOf = (stop: EnhanceStop) =>
    stop.reason === 'not-ready'
      ? $t('frameleaf_enhance_model_not_ready', { values: { name: stop.name } })
      : stop.reason === 'needs-cloud'
        ? $t('frameleaf_enhance_needs_cloud')
        : '';
  const reasons = $derived([
    ...new Set([
      ...(noLocalReason && !stops.some((stop) => stop.runsOn === 'local') ? [noLocalReason] : []),
      ...stops.filter((stop) => stop.disabled).map((stop) => reasonOf(stop)),
    ]),
  ]);
  const bandsPresent = $derived(new Set(stops.map((stop) => stop.band)));
</script>

<fieldset class="ms" data-workload="restoration" {disabled} data-testid="restoration-model-slider">
  <legend class="ms-legend">{label}</legend>
  <div class="ms-track" style:--ms-count={Math.max(stops.length, 1)}>
    {#each stops as stop (stop.id)}
      {@const checked = stop.id === value}
      <label
        class="ms-stop"
        class:is-cpu={stop.band === 'cpu'}
        class:is-gpu={stop.band === 'gpu'}
        class:is-cloud={stop.band === 'cloud'}
        class:is-selected={checked}
        class:is-disabled={stop.disabled}
        title={stop.disabled
          ? reasonOf(stop)
          : `${nameOf(stop)} · ${stop.runsOn === 'cloud' ? $t('frameleaf_enhance_cloud_cost') : where}`}
      >
        <input
          type="radio"
          class="sr-only"
          name="{id}-model"
          value={stop.id}
          {checked}
          disabled={stop.disabled}
          aria-describedby={stop.disabled ? `${id}-reasons` : undefined}
          onchange={() => onChange?.(stop)}
        />
        <span class="ms-band" aria-hidden="true"></span>
        <span class="ms-knob" aria-hidden="true"></span>
        <span class="ms-stop-name" aria-hidden="true">
          <Icon icon={ICONS[stop.band]} size="14" />
          <span>{nameOf(stop)}</span>
        </span>
        <span class="sr-only">
          {nameOf(stop)}: {stop.runsOn === 'cloud' ? $t('frameleaf_enhance_cloud_cost') : where}{stop.disabled
            ? `. ${$t('frameleaf_model_unavailable_prefix')} ${reasonOf(stop)}`
            : ''}
        </span>
      </label>
    {/each}
  </div>
  <div class="ms-scale" aria-hidden="true">
    <span>{$t('frameleaf_model_scale_lighter')}</span>
    <span>{$t('frameleaf_model_scale_heavier')}</span>
  </div>
  {#if selected}
    <p
      class="ms-readout"
      class:is-cpu={selected.band === 'cpu'}
      class:is-gpu={selected.band === 'gpu'}
      class:is-cloud={selected.band === 'cloud'}
      aria-live="polite"
    >
      <Icon icon={ICONS[selected.band]} size="16" aria-hidden={true} />
      <span>
        <strong>{nameOf(selected)}</strong>{#if selected.runsOn === 'local'}&nbsp;· {where}{/if}
        <small>
          {selected.runsOn === 'cloud'
            ? $t('frameleaf_enhance_model_cloud_help')
            : $t(restorationModeHelpKey(selected.mode!))}
        </small>
      </span>
    </p>
  {:else}
    <p class="ms-readout is-none" role="status">
      <Icon icon={mdiCancel} size="16" aria-hidden={true} />
      <span>{$t('frameleaf_model_nothing')}</span>
    </p>
  {/if}
  <ul class="ms-key" aria-label={$t('frameleaf_model_key_label')}>
    {#if bandsPresent.has('cpu')}
      <li class="is-cpu"><Icon icon={mdiChip} size="14" aria-hidden={true} /> {$t('frameleaf_model_key_cpu')}</li>
    {/if}
    {#if bandsPresent.has('gpu')}
      <li class="is-gpu">
        <Icon icon={mdiExpansionCard} size="14" aria-hidden={true} />
        {gpu
          ? $t('frameleaf_model_key_gpu_named', { values: { gpu: gpu.name, memory: gpu.vramGb } })
          : $t('frameleaf_model_key_gpu')}
      </li>
    {/if}
    {#if bandsPresent.has('cloud')}
      <li class="is-cloud">
        <Icon icon={mdiCloudOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_model_key_cloud')}
      </li>
    {/if}
  </ul>
  {#if reasons.length > 0}
    <ul class="ms-reasons" id="{id}-reasons">
      {#each reasons as reason (reason)}
        <li><Icon icon={mdiInformationOutline} size="14" aria-hidden={true} /> {reason}</li>
      {/each}
    </ul>
  {/if}
</fieldset>
