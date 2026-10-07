<script lang="ts" module>
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  export type StudioExportChoice = {
    format: StudioExportFormat;
    color: StudioExportColor;
    resolution: StudioExportResolution;
    quality: StudioExportQuality;
    mastering?: StudioExportMastering;
    subtitleMode: StudioExportSubtitleMode;
    range?: { inPoint: number; outPoint: number };
    destination: MediaOperationDestination;
    /**
     * FL-162 Smooth motion of the exported video, as its own job once it is in the library. The export
     * still renders at home; a Frameleaf Cloud Smooth motion is confirmed and billed separately.
     */
    smoothMotion?: { factor: 2 | 4 | 8; destinationId: string };
  };
</script>

<script lang="ts">
  /**
   * Export the project as a video (FL-88 header, FL-106 server), ported from `ExportDialog` in
   * `design/frameleaf/template/src/Studio.jsx:1661-1739`: Format, Colour, Resolution and Render on,
   * with the prototype's notes. The render runs as a durable job on the server and is followed in
   * Activity; nothing renders in the browser.
   *
   * Exports render on this server or another computer on the home network, never on Frameleaf Cloud
   * (FL-159 §2.7). Each format, colour and resolution is judged against what the qualified render
   * workers verified (FL-42, `studio.render` evidence, `studioRenderChoices`). Format and colour
   * remain selectable at the minimum resolution so a supported tuple is reachable when several
   * defaults must change; submission still requires the full chosen combination to be supported.
   * The time, size and cost rows are not shown, because nothing on the server measures them for a Studio export yet and the prototype's figures are simulated.
   */
  import { t } from 'svelte-i18n';
  import {
    MediaOperationDestination,
    MlDestinationKind,
    MlWorkload,
    Primaries,
    StudioExportColor,
    StudioExportFormat,
    StudioExportResolution,
    StudioExportQuality,
    StudioExportSubtitleMode,
    getMlCapabilities,
    type MlCapabilityDestinationDto,
    type StudioExportMastering,
  } from '@frameleaf/sdk';
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import { resolvePosition, type DetectedGpu, type RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertOutline, mdiExportVariant } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';
  import {
    evaluateStudioRender,
    studioRenderChoices,
    studioRenderRefusalKey,
    type StudioRenderVerdict,
  } from '$lib/frameleaf/studio/render-output';

  let {
    open = $bindable(false),
    sequenceName,
    busy = false,
    renderEvidence = [],
    onExport,
  }: {
    open?: boolean;
    sequenceName: string;
    busy?: boolean;
    /** What the qualified render workers verified, per destination (FL-42). */
    renderEvidence?: readonly StudioRenderEvidence[];
    onExport: (choice: StudioExportChoice) => void;
  } = $props();

  const formats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.Mp4HevcMain10, label: 'frameleaf_studio_export_format_hevc' },
    { value: StudioExportFormat.Mp4H264, label: 'frameleaf_studio_export_format_h264' },
    { value: StudioExportFormat.MovH264, label: 'frameleaf_studio_export_format_mov_h264' },
    { value: StudioExportFormat.WebmAv1, label: 'frameleaf_studio_export_format_av1' },
    { value: StudioExportFormat.Prores422Hq, label: 'frameleaf_studio_export_format_prores' },
  ];
  const colors: { value: StudioExportColor; label: Translations }[] = [
    { value: StudioExportColor.Preserve, label: 'frameleaf_studio_export_color_preserve' },
    { value: StudioExportColor.Hdr10, label: 'frameleaf_studio_export_color_hdr10' },
    { value: StudioExportColor.DolbyVision, label: 'frameleaf_studio_export_color_dolby' },
  ];
  // Largest first, as in the prototype.
  const resolutions: { value: StudioExportResolution; label: Translations }[] = [
    { value: StudioExportResolution.$2160P, label: 'frameleaf_studio_export_resolution_2160' },
    { value: StudioExportResolution.$1440P, label: 'frameleaf_studio_export_resolution_1440' },
    { value: StudioExportResolution.$1080P, label: 'frameleaf_studio_export_resolution_1080' },
    { value: StudioExportResolution.$720P, label: 'frameleaf_studio_export_resolution_720' },
  ];
  const destinations: { value: MediaOperationDestination; label: Translations }[] = [
    { value: MediaOperationDestination.Local, label: 'frameleaf_activity_destination_local' },
    { value: MediaOperationDestination.Lan, label: 'frameleaf_activity_destination_lan' },
  ];
  const qualities: { value: StudioExportQuality; label: Translations }[] = [
    { value: StudioExportQuality.Low, label: 'frameleaf_studio_export_quality_low' },
    { value: StudioExportQuality.Medium, label: 'frameleaf_studio_export_quality_medium' },
    { value: StudioExportQuality.High, label: 'frameleaf_studio_export_quality_high' },
    { value: StudioExportQuality.Ultra, label: 'frameleaf_studio_export_quality_ultra' },
  ];

  let format = $state(StudioExportFormat.Mp4HevcMain10);
  let color = $state<StudioExportColor>(StudioExportColor.Preserve);
  let resolution = $state(StudioExportResolution.$2160P);
  let quality = $state(StudioExportQuality.High);
  let declarePqMastering = $state(false);
  let maxNits = $state<number | undefined>();
  let minNits = $state<number | undefined>();
  let subtitleMode = $state(StudioExportSubtitleMode.Burn);
  let rangeMode = $state('all');
  let inPoint = $state<number | undefined>(0);
  let outPoint = $state<number | undefined>(1);
  let destination = $state(MediaOperationDestination.Local);
  const fieldId = $props.id();

  /* Smooth motion after export (FL-162; prototype ExportDialog frame-rate conversion and FrameMethod). */
  const SMOOTH_FACTORS = [2, 4, 8] as const;
  let smoothFactor = $state<2 | 4 | 8 | null>(null);
  let smoothModelId = $state<string | null>(null);
  let smoothRunsOn = $state<'local' | 'cloud' | null>(null);
  let interpolationDestinations = $state<MlCapabilityDestinationDto[] | null>(null);
  let capabilitiesFailed = $state(false);

  const smoothLocal = $derived(
    interpolationDestinations?.find(
      (candidate) => candidate.kind !== MlDestinationKind.FrameleafCloud && candidate.available,
    ) ?? null,
  );
  const smoothCloud = $derived(
    interpolationDestinations?.find(
      (candidate) => candidate.kind === MlDestinationKind.FrameleafCloud && candidate.available,
    ) ?? null,
  );
  const smoothGpu = $derived<DetectedGpu | null>(
    smoothLocal?.gpuMemoryBytes
      ? { name: smoothLocal.name, vramGb: smoothLocal.gpuMemoryBytes / 1024 ** 3, backend: 'CUDA', profile: null }
      : null,
  );
  /** What can run the work right now decides the slider's route; the server still decides each job. */
  const smoothRoute = $derived<RouteMode>(smoothLocal && smoothCloud ? 'both' : smoothCloud ? 'cloud' : 'local');
  const smoothDestination = $derived(
    smoothRunsOn === 'cloud' ? smoothCloud : smoothRunsOn === 'local' ? smoothLocal : null,
  );

  // The destinations are read once Smooth motion is asked for, and the slider starts where it fits.
  $effect(() => {
    if (smoothFactor === null || interpolationDestinations !== null || capabilitiesFailed) {
      return;
    }
    void getMlCapabilities()
      .then((capabilities) => {
        interpolationDestinations =
          capabilities.workloads.find((row) => row.workload === MlWorkload.Interpolation)?.destinations ?? [];
      })
      .catch(() => {
        capabilitiesFailed = true;
      });
  });
  $effect(() => {
    if (!interpolationDestinations || smoothModelId) {
      return;
    }
    const start = resolvePosition('interpolation', null, { gpu: smoothGpu, route: smoothRoute });
    if (start) {
      smoothModelId = start.item.id;
      smoothRunsOn = start.runsOn;
    }
  });

  // Every opening starts from the prototype's defaults.
  $effect(() => {
    if (!open) {
      return;
    }

    format = StudioExportFormat.Mp4HevcMain10;
    color = StudioExportColor.Preserve;
    resolution = StudioExportResolution.$2160P;
    quality = StudioExportQuality.High;
    declarePqMastering = false;
    maxNits = undefined;
    minNits = undefined;
    subtitleMode = StudioExportSubtitleMode.Burn;
    rangeMode = 'all';
    inPoint = 0;
    outPoint = 1;
    destination = MediaOperationDestination.Local;
    smoothFactor = null;
  });

  const choices = $derived(studioRenderChoices(renderEvidence, destination, { format, color, resolution }));
  const availableChoices = $derived(
    studioRenderChoices(renderEvidence, destination, {
      format,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$720P,
    }),
  );
  const verdict = $derived(evaluateStudioRender(renderEvidence, destination, { format, color, resolution }));
  const needsMastering = $derived(
    color === StudioExportColor.Hdr10 || (color === StudioExportColor.Preserve && declarePqMastering),
  );
  const mastering = $derived<StudioExportMastering | null>(
    needsMastering &&
      typeof maxNits === 'number' &&
      typeof minNits === 'number' &&
      [maxNits, minNits].every((nits) => Number.isFinite(nits) && Number(nits.toFixed(4)) === nits) &&
      maxNits <= 10_000 &&
      minNits >= 0 &&
      maxNits > minNits
      ? { primaries: Primaries.Bt2020, maxNits, minNits }
      : null,
  );
  const selectedRange = $derived(
    rangeMode === 'frames' &&
      typeof inPoint === 'number' &&
      typeof outPoint === 'number' &&
      Number.isSafeInteger(inPoint) &&
      Number.isSafeInteger(outPoint) &&
      inPoint >= 0 &&
      outPoint > inPoint
      ? { inPoint, outPoint }
      : null,
  );
  const canExport = $derived(
    !busy &&
      verdict.supported &&
      (!needsMastering || mastering !== null) &&
      (rangeMode === 'all' || selectedRange !== null) &&
      (smoothFactor === null || !!smoothDestination),
  );
  const unsupported = (list: { value: string; verdict: StudioRenderVerdict }[], value: string) =>
    list.find((entry) => entry.value === value)?.verdict.supported === false;

  const submit = () => {
    if (canExport) {
      onExport({
        format,
        color,
        resolution,
        quality,
        ...(mastering && { mastering }),
        subtitleMode,
        ...(selectedRange && { range: selectedRange }),
        destination,
        ...(smoothFactor !== null &&
          smoothDestination && { smoothMotion: { factor: smoothFactor, destinationId: smoothDestination.id } }),
      });
    }
  };
</script>

<Dialog
  bind:open
  title={$t('frameleaf_studio_export_title', { values: { name: sequenceName } })}
  closeLabel={$t('close')}
>
  <div class="export" data-testid="studio-export-dialog">
    <div class="grid">
      <label class="field" for="{fieldId}-format">
        <span>{$t('frameleaf_studio_export_format')}</span>
        <select id="{fieldId}-format" bind:value={format}>
          {#each formats as item (item.value)}
            <option value={item.value} disabled={unsupported(availableChoices.formats, item.value)}
              >{$t(item.label)}</option
            >
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-color">
        <span>{$t('frameleaf_studio_export_color')}</span>
        <select id="{fieldId}-color" bind:value={color}>
          {#each colors as item (item.value)}
            <option value={item.value} disabled={unsupported(availableChoices.colors, item.value)}
              >{$t(item.label)}</option
            >
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-resolution">
        <span>{$t('frameleaf_studio_export_resolution')}</span>
        <select id="{fieldId}-resolution" bind:value={resolution}>
          {#each resolutions as item (item.value)}
            <option value={item.value} disabled={unsupported(choices.resolutions, item.value)}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-destination">
        <span>{$t('frameleaf_studio_export_destination')}</span>
        <select id="{fieldId}-destination" bind:value={destination}>
          {#each destinations as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-quality">
        <span>{$t('frameleaf_studio_export_quality')}</span>
        <select id="{fieldId}-quality" bind:value={quality}>
          {#each qualities as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-subtitles">
        <span>{$t('frameleaf_studio_export_subtitles')}</span>
        <select id="{fieldId}-subtitles" bind:value={subtitleMode}>
          <option value={StudioExportSubtitleMode.Burn}>{$t('frameleaf_studio_export_subtitles_burn')}</option>
          <option value={StudioExportSubtitleMode.Off}>{$t('frameleaf_studio_export_subtitles_off')}</option>
        </select>
      </label>
      <label class="field" for="{fieldId}-range">
        <span>{$t('frameleaf_studio_export_range')}</span>
        <select id="{fieldId}-range" bind:value={rangeMode}>
          <option value="all">{$t('frameleaf_studio_export_range_all')}</option>
          <option value="frames">{$t('frameleaf_studio_export_range_frames')}</option>
        </select>
      </label>
      {#if rangeMode === 'frames'}
        <label class="field" for="{fieldId}-in-point">
          <span>{$t('frameleaf_studio_export_range_start')}</span>
          <input id="{fieldId}-in-point" type="number" min="0" step="1" bind:value={inPoint} />
        </label>
        <label class="field" for="{fieldId}-out-point">
          <span>{$t('frameleaf_studio_export_range_end')}</span>
          <input id="{fieldId}-out-point" type="number" min="1" step="1" bind:value={outPoint} />
        </label>
      {/if}
    </div>
    {#if rangeMode === 'frames' && selectedRange === null}
      <p class="note warning" role="status">{$t('frameleaf_studio_export_range_invalid')}</p>
    {/if}

    {#if color === StudioExportColor.Preserve}
      <label class="note">
        <input type="checkbox" bind:checked={declarePqMastering} />
        {$t('frameleaf_studio_export_mastering_preserve')}
      </label>
    {/if}
    {#if needsMastering}
      <fieldset class="smooth">
        <legend>{$t('frameleaf_studio_export_mastering_title')}</legend>
        <p class="note">{$t('frameleaf_studio_export_mastering_hint')}</p>
        <div class="grid">
          <label class="field" for="{fieldId}-mastering-max">
            <span>{$t('frameleaf_studio_export_mastering_max')}</span>
            <input
              id="{fieldId}-mastering-max"
              type="number"
              min="0"
              max="10000"
              step="0.0001"
              required
              bind:value={maxNits}
            />
          </label>
          <label class="field" for="{fieldId}-mastering-min">
            <span>{$t('frameleaf_studio_export_mastering_min')}</span>
            <input
              id="{fieldId}-mastering-min"
              type="number"
              min="0"
              max="10000"
              step="0.0001"
              required
              bind:value={minNits}
            />
          </label>
        </div>
        {#if mastering === null}
          <p class="note warning" role="status">{$t('frameleaf_studio_export_mastering_invalid')}</p>
        {/if}
      </fieldset>
    {/if}

    {#if color === StudioExportColor.DolbyVision}
      <p class="note warning">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_studio_export_dolby_note')}
      </p>
    {/if}

    {#if !verdict.supported}
      <p class="note warning" role="status">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t(studioRenderRefusalKey(verdict.refusal))}
      </p>
    {/if}
    <p class="note">{$t('frameleaf_studio_export_on_network')}</p>

    <!-- FL-162: Smooth motion is its own job on the exported video; the export itself renders at home. -->
    <fieldset class="smooth" data-testid="studio-export-smooth-motion">
      <legend>{$t('frameleaf_studio_export_smooth_motion')}</legend>
      <div class="segmented" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_studio_export_smooth_motion')}>
        <button type="button" role="radio" aria-checked={smoothFactor === null} onclick={() => (smoothFactor = null)}>
          {$t('frameleaf_studio_export_smooth_motion_off')}
        </button>
        {#each SMOOTH_FACTORS as factor (factor)}
          <button
            type="button"
            role="radio"
            aria-checked={smoothFactor === factor}
            onclick={() => (smoothFactor = factor)}
          >
            {$t('frameleaf_restoration_smooth_motion_factor', { values: { factor } })}
          </button>
        {/each}
      </div>
      {#if smoothFactor !== null}
        {#if interpolationDestinations}
          <ModelSlider
            workload="interpolation"
            value={smoothModelId}
            gpu={smoothGpu}
            route={smoothRoute}
            label={$t('frameleaf_restoration_smooth_motion_model')}
            hideLegend
            localDisabledReason={smoothLocal ? '' : $t('frameleaf_restoration_smooth_motion_no_local')}
            onChange={(id, state) => {
              smoothModelId = id;
              smoothRunsOn = state.runsOn;
            }}
          />
          <p class="note" role="status">
            {#if smoothRunsOn === 'cloud' && smoothCloud}
              {$t('frameleaf_studio_export_smooth_motion_cloud')}
            {:else if smoothRunsOn === 'local' && smoothLocal}
              {$t('frameleaf_studio_export_smooth_motion_local', { values: { name: smoothLocal.name } })}
            {:else}
              {$t('frameleaf_studio_export_smooth_motion_unavailable')}
            {/if}
          </p>
        {:else if capabilitiesFailed}
          <p class="note warning" role="status">{$t('frameleaf_studio_export_smooth_motion_unavailable')}</p>
        {:else}
          <p class="note" aria-busy="true">{$t('loading')}</p>
        {/if}
      {/if}
    </fieldset>

    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!canExport} onclick={submit}>
        <Icon icon={mdiExportVariant} size="16" aria-hidden={true} />
        {$t('frameleaf_studio_export_start')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  /* studio.css `.fls-dialog-grid`, `.fls-field`, `.fls-note`. */
  .export {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(30rem, 100%);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .field {
    display: grid;
    gap: 0.3rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field select,
  .field input {
    min-height: 34px;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .note.warning {
    color: var(--fl-warning);
  }
  .smooth {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .smooth legend {
    margin-bottom: 0.3rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  /* studio.css `.fls-segmented` */
  .segmented {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-canvas);
    justify-self: start;
  }
  .segmented button {
    min-height: 28px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .segmented button[aria-checked='true'] {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  @media (max-width: 520px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
