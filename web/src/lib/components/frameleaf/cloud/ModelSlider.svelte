<script lang="ts">
  /**
   * The model slider (FL-159, handoff §3.3; prototype ModelSlider.jsx and gpu-models.css): every model
   * for one kind of work, light → heavy, banded by where it runs with the detected hardware —
   * white = this server's processor, green = your GPU, blue = Frameleaf Cloud only. Each stop has an
   * icon and a text label and the selected stop a full line, so colour is never the only signal.
   * Built on native radio buttons (a radio group: arrow keys move between the stops that can be
   * chosen). The route decides what can be chosen: Local only crosses out blue stops with the reason,
   * and Cloud only moves hostable models to blue; a model's licence never keeps it off blue (FL-451).
   * Below phone width the stops show their icons only.
   *
   * FL-455: smart search and faces have sliders too. Their blue stops are this server's own models run
   * on Frameleaf Cloud, one right after each local model the live catalogue says it runs (`twins`);
   * without a catalogue the slider has white and green stops only. `tiered` adds the quality word above
   * every stop, which stays when the names are hidden on a phone.
   */
  import './gpu-models.css';
  import { formatDuration, formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
  import {
    GENERIC_CLOUD_STOP,
    isMatchedWorkload,
    ladderStates,
    localTwinId,
    matchedStopStates,
    modelLicenceNoteKey,
    modelNoteKey,
    withLiveCloudStops,
    workloadUnitKey,
    workloadUnits,
    type Band,
    type Benchmark,
    type DetectedGpu,
    type GpuProfileId,
    type LiveCloudTwin,
    type PositionState,
    type RouteMode,
    type SliderWorkload,
  } from '$lib/frameleaf/gpu-model-catalog';
  import { stopTiers, tierKey } from '$lib/frameleaf/model-tiers';
  import { Icon } from '@frameleaf/ui';
  import { mdiCancel, mdiChip, mdiCloudOutline, mdiExpansionCard, mdiInformationOutline } from '@mdi/js';
  import { tick } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  type Props = {
    workload: SliderWorkload;
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
    /** FL-455: the entries of the live catalogue that run this server's own models (search and faces). */
    twins?: readonly LiveCloudTwin[];
    /** The blue stops, when they come from Frameleaf Cloud itself rather than this slider's own list. */
    cloudStops?: readonly PositionState[];
    /** Show the quality word of each stop, and say "Faster" to "Better results" along the track. */
    tiered?: boolean;
    /** Said in place of "nothing can run this" when the saved model is simply not one of the stops. */
    customNote?: string;
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
    twins = [],
    cloudStops,
    tiered = false,
    customNote,
    onChange,
  }: Props = $props();

  const id = $props.id();
  const ICONS: Record<Band, string> = { cpu: mdiChip, gpu: mdiExpansionCard, cloud: mdiCloudOutline, none: mdiCancel };

  const reasonText = (entry: PositionState) =>
    entry.reasons.map((reason) => $t(reason.key as Translations, { values: reason.values })).join(' ');

  const options = $derived({
    gpu,
    // live blue stops replace the ladder's, so Cloud only doesn't move the home models to blue
    route: cloudStops && route === 'cloud' ? ('both' as const) : route,
    benchmark,
    cpuProfile,
  });
  const ladder = $derived(
    isMatchedWorkload(workload) ? matchedStopStates(workload, twins, options) : ladderStates(workload, options),
  );
  const stops = $derived(
    (cloudStops ? withLiveCloudStops(ladder, cloudStops, route) : ladder).map((entry) =>
      localDisabledReason && entry.runsOn === 'local' && !entry.disabled
        ? { ...entry, disabled: true, reasonText: localDisabledReason }
        : { ...entry, reasonText: reasonText(entry) },
    ),
  );
  // the stop that stands for Frameleaf Cloud as a whole is no model, so it has no quality word
  const tiers = $derived(
    stopTiers(
      stops.filter((entry) => entry.item.id !== GENERIC_CLOUD_STOP),
      (entry) => localTwinId(entry.item.id),
    ),
  );
  const tierOf = (index: number) => {
    const tier = tiers.at(index);
    return tier ? $t(tierKey(tier)) : '';
  };
  const selectedIndex = $derived(stops.findIndex((entry) => entry.item.id === value));
  const selected = $derived(selectedIndex === -1 ? null : stops[selectedIndex]);
  const reasons = $derived([...new Set(stops.filter((entry) => entry.disabled).map((entry) => entry.reasonText))]);
  const bandsPresent = $derived(new Set(stops.map((entry) => entry.band)));

  const unit = (count: number) => $t(workloadUnitKey(workload) as Translations, { values: { count } });

  /** "Your GPU · ~3 s per photo", "CPU · slow · ~20 s per photo", "Cloud · 122B · about $0.013 per 100 photos". */
  const stopLabel = (entry: PositionState) => {
    if (entry.band === 'gpu' || entry.band === 'cpu') {
      // Under a second a photo reads as "0 sec", so these are quoted per batch.
      const per = (entry.seconds ?? 1) < 0.5 ? workloadUnits[workload].per : 1;
      return $t(entry.band === 'gpu' ? 'frameleaf_model_label_gpu' : 'frameleaf_model_label_cpu', {
        values: {
          slow: entry.speedClass === 'slow' ? 'yes' : 'no',
          time: formatDuration(entry.seconds === null ? null : entry.seconds * per, $locale),
          unit: unit(per),
        },
      });
    }
    if (entry.twin) {
      return entry.twin.priceUsd === null
        ? $t('frameleaf_model_label_cloud_twin')
        : $t('frameleaf_model_label_cloud_twin_rate', { values: { rate: formatRatePerMinute(entry.twin.priceUsd) } });
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
    if (entry.twin) {
      return entry.twin.label ? `${entry.twin.label}.` : '';
    }
    if (entry.band === 'cloud' && entry.item.cloud) {
      return $t('frameleaf_model_detail_cloud', {
        values: { gpu: $t(`frameleaf_gpu_class_${entry.item.cloud.gpuClass}` as Translations) },
      });
    }
    return '';
  };

  /** What a stop says it is for: a Cloud run of a search or faces model has one sentence of its own. */
  const noteOf = (entry: PositionState) =>
    entry.item.id === GENERIC_CLOUD_STOP
      ? $t('frameleaf_enhance_model_cloud_help')
      : entry.twin
        ? $t(`frameleaf_model_note_cloud_twin_${workload}` as Translations)
        : $t(modelNoteKey(entry.item) as Translations);

  /**
   * A choice the page didn't take (it needs Frameleaf Cloud set up first, or a write failed) must not stay
   * ticked: the radios follow `value`, and only a new `value` would re-draw them.
   */
  const choose = async (event: Event, entry: PositionState) => {
    const input = event.currentTarget as HTMLInputElement;
    onChange?.(entry.item.id, entry);
    await tick();
    // The browser unticked the stop that was selected, and Svelte doesn't know: put the whole group back.
    for (const radio of input.closest('fieldset')?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      radio.checked = radio.value === value;
    }
  };
</script>

<fieldset class="ms" data-workload={workload} {disabled}>
  <legend class="ms-legend">{label}</legend>
  <div class="ms-track" style:--ms-count={stops.length}>
    {#each stops as entry, index (entry.item.id)}
      {@const checked = entry.item.id === value}
      <label
        class="ms-stop"
        class:is-cpu={entry.band === 'cpu'}
        class:is-gpu={entry.band === 'gpu'}
        class:is-cloud={entry.band === 'cloud'}
        class:is-none={entry.band === 'none'}
        class:is-selected={checked}
        class:is-disabled={entry.disabled}
        title={entry.disabled
          ? entry.reasonText
          : `${tiered ? `${tierOf(index)} · ` : ''}${entry.item.name} · ${stopLabel(entry)}`}
      >
        <input
          type="radio"
          class="sr-only"
          name="{id}-model"
          value={entry.item.id}
          {checked}
          disabled={entry.disabled}
          aria-describedby={entry.disabled ? `${id}-reasons` : undefined}
          onchange={(event) => choose(event, entry)}
        />
        <span class="ms-band" aria-hidden="true"></span>
        <span class="ms-knob" aria-hidden="true"></span>
        {#if tiered}
          <span class="ms-tier" aria-hidden="true">{tierOf(index)}</span>
        {/if}
        <span class="ms-stop-name" aria-hidden="true">
          <Icon icon={ICONS[entry.band]} size="14" />
          <span>{entry.item.short}</span>
        </span>
        <span class="sr-only">
          {tiered ? `${tierOf(index)}, ` : ''}{entry.item.name}: {stopLabel(entry)}{entry.disabled
            ? `. ${$t('frameleaf_model_unavailable_prefix')} ${entry.reasonText}`
            : ''}
        </span>
      </label>
    {/each}
  </div>
  <div class="ms-scale" aria-hidden="true">
    <span>{$t(tiered ? 'frameleaf_model_scale_faster' : 'frameleaf_model_scale_lighter')}</span>
    <span>{$t(tiered ? 'frameleaf_model_scale_better_results' : 'frameleaf_model_scale_heavier')}</span>
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
        <strong>{tiered ? `${tierOf(selectedIndex)} · ` : ''}{selected.item.name}</strong> · {stopLabel(selected)}
        <small>
          {noteOf(selected)}
          {detail(selected)}
          {#if selected.item.licenceNote}
            {$t('frameleaf_model_licence', {
              values: { note: $t(modelLicenceNoteKey(selected.item) as Translations) },
            })}
          {/if}
        </small>
      </span>
    </p>
  {:else if customNote}
    <p class="ms-readout" role="status"><span>{customNote}</span></p>
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
          {gpu?.integrated
            ? $t('frameleaf_model_key_gpu_integrated', { values: { gpu: gpu.name } })
            : gpu
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
