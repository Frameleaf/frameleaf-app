<script lang="ts">
  /**
   * The model slider (FL-159, handoff §3.3; prototype ModelSlider.jsx and gpu-models.css): every model
   * for one kind of work, light → heavy, banded by where it runs with the detected hardware —
   * white = this server's processor, green = your GPU, blue = Frameleaf Cloud only. Each stop has an
   * icon and a text label and the selected stop a full line, so colour is never the only signal.
   * Built on native radio buttons (a radio group: arrow keys move between the stops that can be
   * chosen). The route decides what can be chosen: Local only crosses out blue stops with the reason,
   * Cloud only moves hostable models to blue, and a licence that forbids hosted use never reaches blue.
   * Below phone width the stops show their icons only.
   */
  import './gpu-models.css';
  import { formatDuration, formatUsd } from '$lib/frameleaf/cloud-ml';
  import {
    ladderStates,
    modelLicenceNoteKey,
    modelNoteKey,
    workloadUnitKey,
    type Band,
    type Benchmark,
    type DetectedGpu,
    type GpuProfileId,
    type LadderWorkload,
    type PositionState,
    type RouteMode,
  } from '$lib/frameleaf/gpu-model-catalog';
  import { Icon } from '@immich/ui';
  import { mdiCancel, mdiChip, mdiCloudOutline, mdiExpansionCard, mdiInformationOutline } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  type Props = {
    workload: LadderWorkload;
    value: string | null | undefined;
    gpu: DetectedGpu | null;
    route: RouteMode;
    benchmark?: Benchmark | null;
    cpuProfile?: GpuProfileId;
    label: string;
    hideLegend?: boolean;
    disabled?: boolean;
    /** Disables every local stop with this reason (for example a busy or missing worker). */
    localDisabledReason?: string;
    onChange?: (id: string, state: PositionState) => void;
  };

  let {
    workload,
    value,
    gpu,
    route,
    benchmark = null,
    cpuProfile = 'cpu8',
    label,
    hideLegend = false,
    disabled = false,
    localDisabledReason = '',
    onChange,
  }: Props = $props();

  const id = $props.id();
  const ICONS: Record<Band, string> = { cpu: mdiChip, gpu: mdiExpansionCard, cloud: mdiCloudOutline, none: mdiCancel };

  const reasonText = (entry: PositionState) =>
    entry.reasons.map((reason) => $t(reason.key as Translations, { values: reason.values })).join(' ');

  const stops = $derived(
    ladderStates(workload, { gpu, route, benchmark, cpuProfile }).map((entry) =>
      localDisabledReason && entry.runsOn === 'local' && !entry.disabled
        ? { ...entry, disabled: true, reasonText: localDisabledReason }
        : { ...entry, reasonText: reasonText(entry) },
    ),
  );
  const selected = $derived(stops.find((entry) => entry.item.id === value) ?? null);
  const reasons = $derived([...new Set(stops.filter((entry) => entry.disabled).map((entry) => entry.reasonText))]);
  const bandsPresent = $derived(new Set(stops.map((entry) => entry.band)));

  const unit = (count: number) => $t(workloadUnitKey(workload) as Translations, { values: { count } });

  /** "Your GPU · ~3 s per photo", "CPU · slow · ~20 s per photo", "Cloud · 122B · about $0.013 per 100 photos". */
  const stopLabel = (entry: PositionState) => {
    if (entry.band === 'gpu' || entry.band === 'cpu') {
      return $t(entry.band === 'gpu' ? 'frameleaf_model_label_gpu' : 'frameleaf_model_label_cpu', {
        values: {
          slow: entry.speedClass === 'slow' ? 'yes' : 'no',
          time: formatDuration(entry.seconds, $locale),
          unit: unit(1),
        },
      });
    }
    if (entry.band === 'cloud' && entry.quote) {
      return $t(entry.item.params ? 'frameleaf_model_label_cloud_params' : 'frameleaf_model_label_cloud', {
        values: { params: entry.item.params ?? '', price: formatUsd(entry.quote.usd), unit: unit(entry.quote.per) },
      });
    }
    return $t('frameleaf_model_label_none');
  };

  const detail = (entry: PositionState) => {
    if (entry.band === 'gpu' || entry.band === 'cpu') {
      return $t(entry.measured ? 'frameleaf_model_detail_measured' : 'frameleaf_model_detail_estimated');
    }
    if (entry.band === 'cloud' && entry.item.cloud) {
      return $t('frameleaf_model_detail_cloud', {
        values: { gpu: $t(`frameleaf_gpu_class_${entry.item.cloud.gpuClass}` as Translations) },
      });
    }
    return '';
  };
</script>

<fieldset class="ms" data-workload={workload} {disabled}>
  <legend class="ms-legend">{label}</legend>
  <div class="ms-track" style:--ms-count={stops.length}>
    {#each stops as entry (entry.item.id)}
      {@const checked = entry.item.id === value}
      <label
        class="ms-stop"
        class:is-cpu={entry.band === 'cpu'}
        class:is-gpu={entry.band === 'gpu'}
        class:is-cloud={entry.band === 'cloud'}
        class:is-none={entry.band === 'none'}
        class:is-selected={checked}
        class:is-disabled={entry.disabled}
        title={entry.disabled ? entry.reasonText : `${entry.item.name} · ${stopLabel(entry)}`}
      >
        <input
          type="radio"
          class="sr-only"
          name="{id}-model"
          value={entry.item.id}
          {checked}
          disabled={entry.disabled}
          aria-describedby={entry.disabled ? `${id}-reasons` : undefined}
          onchange={() => onChange?.(entry.item.id, entry)}
        />
        <span class="ms-band" aria-hidden="true"></span>
        <span class="ms-knob" aria-hidden="true"></span>
        <span class="ms-stop-name" aria-hidden="true">
          <Icon icon={ICONS[entry.band]} size="14" />
          <span>{entry.item.short}</span>
        </span>
        <span class="sr-only">
          {entry.item.name}: {stopLabel(entry)}{entry.disabled
            ? `. ${$t('frameleaf_model_unavailable_prefix')} ${entry.reasonText}`
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
      class:is-none={selected.band === 'none'}
      aria-live="polite"
    >
      <Icon icon={ICONS[selected.band]} size="16" aria-hidden={true} />
      <span>
        <strong>{selected.item.name}</strong> · {stopLabel(selected)}
        <small>
          {$t(modelNoteKey(selected.item) as Translations)}
          {detail(selected)}
          {#if selected.item.licenceNote}
            {$t('frameleaf_model_licence', {
              values: { note: $t(modelLicenceNoteKey(selected.item) as Translations) },
            })}
          {/if}
        </small>
      </span>
    </p>
  {:else}
    <p class="ms-readout is-none" role="status">
      <Icon icon={mdiCancel} size="16" aria-hidden={true} />
      <span>{$t('frameleaf_model_nothing')}</span>
    </p>
  {/if}
  {#if !hideLegend}
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
  {/if}
  {#if reasons.length > 0}
    <ul class="ms-reasons" id="{id}-reasons">
      {#each reasons as reason (reason)}
        <li><Icon icon={mdiInformationOutline} size="14" aria-hidden={true} /> {reason}</li>
      {/each}
    </ul>
  {/if}
</fieldset>
