<script lang="ts" module>
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  export type StudioExportChoice = {
    format: StudioExportFormat;
    color: StudioExportColor;
    resolution: StudioExportResolution;
    quality: StudioExportQuality;
    mastering?: StudioExportMastering;
    subtitleMode?: StudioExportSubtitleMode;
    range?: { inPoint: number; outPoint: number };
    destination: MediaOperationDestination;
    /**
     * FL-162 Smooth motion of the exported video, as its own job once it is in the library. The export
     * still renders at home; a Frameleaf Cloud Smooth motion is confirmed and billed separately.
     */
    smoothMotion?: { factor: 2 | 4 | 8; destinationId: string };
    /** FL-563: a vertical or square picture; absent keeps the project's own shape. */
    shape?: StudioExportShape;
    /** FL-563: the crop path of each shot as shown, for a vertical or square export. */
    framing?: StudioExportFramingDto[];
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
  import { untrack } from 'svelte';
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
    StudioExportShape,
    StudioExportSubtitleMode,
    getMlCapabilities,
    getStudioFraming,
    type MlCapabilityDestinationDto,
    type StudioExportFramingDto,
    type StudioExportMastering,
    type StudioReframeResponseDto,
  } from '@frameleaf/sdk';
  import StudioExportReframe from '$lib/components/frameleaf/StudioExportReframe.svelte';
  import { cropPath, cropShare, isReshaped, shapedSize, sizeLabel } from '$lib/frameleaf/studio/reframe';
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import { resolvePosition, type DetectedGpu, type RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertOutline, mdiExportVariant } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';
  import {
    STUDIO_AUDIO_FORMATS,
    STUDIO_STILL_FORMATS,
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
    outputIntent = 'sdr',
    hdrEnabled = false,
    projectId = null,
    captionLanguages = [],
    empty = false,
    hdrPicture = false,
    onExport,
  }: {
    /**
     * FL-674: an export that keeps the source colour keeps an HDR picture (every placed video is an
     * HDR original). Otherwise it is SDR, whatever the working range, and a 10-bit format needs a
     * render worker that writes 10-bit SDR.
     */
    hdrPicture?: boolean;
    /** FL-677: nothing is placed on the timeline, so there is nothing to export yet. */
    empty?: boolean;
    /** FL-641: other caption languages that go with the export as subtitle files, already named. */
    captionLanguages?: readonly string[];
    open?: boolean;
    sequenceName: string;
    /**
     * FL-563: the saved project, which offers Vertical 9:16 and Square 1:1 with automatic framing.
     * Without one the export keeps the project's own shape.
     */
    projectId?: string | null;
    outputIntent?: 'sdr' | 'hdr';
    hdrEnabled?: boolean;
    busy?: boolean;
    /** What the qualified render workers verified, per destination (FL-42). */
    renderEvidence?: readonly StudioRenderEvidence[];
    onExport: (choice: StudioExportChoice) => void;
  } = $props();

  // A film is exported as a video far more often than as one frame of it, so video comes first.
  const videoFormats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.Mp4HevcMain10, label: 'frameleaf_studio_export_format_hevc' },
    { value: StudioExportFormat.Mp4H264, label: 'frameleaf_studio_export_format_h264' },
    { value: StudioExportFormat.WebmAv1, label: 'frameleaf_studio_export_format_av1' },
    { value: StudioExportFormat.Prores422Hq, label: 'frameleaf_studio_export_format_prores' },
  ];
  // FL-105: every other container and codec the render workers can write, by container.
  const moreVideoFormats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.Mp4Hevc, label: 'frameleaf_studio_export_format_mp4_hevc' },
    { value: StudioExportFormat.Mp4Av1, label: 'frameleaf_studio_export_format_mp4_av1' },
    { value: StudioExportFormat.MovH264, label: 'frameleaf_studio_export_format_mov_h264' },
    { value: StudioExportFormat.MovHevc, label: 'frameleaf_studio_export_format_mov_hevc' },
    { value: StudioExportFormat.MovProres422, label: 'frameleaf_studio_export_format_mov_prores_422' },
    { value: StudioExportFormat.WebmVp9, label: 'frameleaf_studio_export_format_webm_vp9' },
    { value: StudioExportFormat.WebmVp8, label: 'frameleaf_studio_export_format_webm_vp8' },
    { value: StudioExportFormat.WebmAv1Sdr, label: 'frameleaf_studio_export_format_webm_av1_sdr' },
    { value: StudioExportFormat.MkvH264, label: 'frameleaf_studio_export_format_mkv_h264' },
    { value: StudioExportFormat.MkvHevc, label: 'frameleaf_studio_export_format_mkv_hevc' },
    { value: StudioExportFormat.MkvVp9, label: 'frameleaf_studio_export_format_mkv_vp9' },
    { value: StudioExportFormat.MkvVp8, label: 'frameleaf_studio_export_format_mkv_vp8' },
    { value: StudioExportFormat.MkvAv1, label: 'frameleaf_studio_export_format_mkv_av1' },
  ];
  const audioFormats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.AudioAac, label: 'frameleaf_studio_export_format_audio_aac' },
    { value: StudioExportFormat.AudioMp3, label: 'frameleaf_studio_export_format_audio_mp3' },
    { value: StudioExportFormat.AudioWav, label: 'frameleaf_studio_export_format_audio_wav' },
  ];
  const stillFormats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.SdrJpeg, label: 'frameleaf_studio_export_format_sdr_jpeg' },
    { value: StudioExportFormat.HdrJpeg, label: 'frameleaf_studio_export_format_hdr_jpeg' },
    { value: StudioExportFormat.HdrHeic, label: 'frameleaf_studio_export_format_hdr_heic' },
  ];
  const formatGroups: { label: Translations; items: typeof videoFormats }[] = [
    { label: 'frameleaf_studio_export_video_group', items: videoFormats },
    { label: 'frameleaf_studio_export_more_video_group', items: moreVideoFormats },
    { label: 'frameleaf_studio_export_audio_group', items: audioFormats },
    { label: 'frameleaf_studio_export_stills_group', items: stillFormats },
  ];
  /** Three places to start from; every choice below can still be changed afterwards. */
  const presets: {
    id: string;
    label: Translations;
    format: StudioExportFormat;
    resolution: StudioExportResolution;
    quality: StudioExportQuality;
  }[] = [
    {
      id: 'share',
      label: 'frameleaf_studio_export_preset_share',
      format: StudioExportFormat.Mp4H264,
      resolution: StudioExportResolution.$1080P,
      quality: StudioExportQuality.High,
    },
    {
      id: 'best',
      label: 'frameleaf_studio_export_preset_best',
      format: StudioExportFormat.Mp4HevcMain10,
      resolution: StudioExportResolution.$2160P,
      quality: StudioExportQuality.High,
    },
    {
      id: 'archive',
      label: 'frameleaf_studio_export_preset_archive',
      format: StudioExportFormat.Prores422Hq,
      resolution: StudioExportResolution.$2160P,
      quality: StudioExportQuality.Ultra,
    },
  ];
  const colors: { value: StudioExportColor; label: Translations }[] = [
    { value: StudioExportColor.Preserve, label: 'frameleaf_studio_export_color_preserve' },
    { value: StudioExportColor.Hdr10, label: 'frameleaf_studio_export_color_hdr10' },
    { value: StudioExportColor.DolbyVision, label: 'frameleaf_studio_export_color_dolby' },
  ];
  // Largest first, as in the prototype. A still keeps the size of its frame; a video is given one.
  const stillResolutions: { value: StudioExportResolution; label: Translations }[] = [
    { value: StudioExportResolution.Original, label: 'original' },
  ];
  const videoResolutions: { value: StudioExportResolution; label: Translations }[] = [
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

  const photo = $derived(STUDIO_STILL_FORMATS.includes(format));
  /** FL-105: the project's sound alone; it has no picture settings and no captions. */
  const audioOnly = $derived(STUDIO_AUDIO_FORMATS.includes(format));
  $effect(() => {
    if (photo) {
      color = StudioExportColor.Preserve;
      resolution = StudioExportResolution.Original;
      quality = StudioExportQuality.High;
      declarePqMastering = false;
      smoothFactor = null;
    } else if (audioOnly) {
      color = StudioExportColor.Preserve;
      resolution = StudioExportResolution.$720P;
      declarePqMastering = false;
      smoothFactor = null;
    } else if (resolution === StudioExportResolution.Original) {
      resolution = StudioExportResolution.$2160P;
    }
  });
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
  let advancedOpen = $state(false);
  const fieldId = $props.id();
  const resolutions = $derived(photo ? stillResolutions : videoResolutions);

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

  /** FL-674: the export's picture, which decides whether a 10-bit format is an HDR master or SDR. */
  const picture = $derived({ hdrPicture });

  /**
   * FL-674: where an opening starts. The prototype's defaults (HEVC Main10 at 2160p) when the render
   * workers can produce them; otherwise the first video format in the list they can produce, at the
   * largest resolution they can produce it, so the dialog never opens on a choice that is refused.
   * With nothing supported it keeps the prototype's defaults and says why.
   */
  const startingChoice = (): { format: StudioExportFormat; resolution: StudioExportResolution } => {
    const fallback = { format: StudioExportFormat.Mp4HevcMain10, resolution: StudioExportResolution.$2160P };
    const evidence = untrack(() => renderEvidence);
    const keepsHdr = untrack(() => hdrPicture);
    for (const { value: candidate } of [...videoFormats, ...moreVideoFormats]) {
      for (const { value: size } of videoResolutions) {
        const supported = evaluateStudioRender(evidence, MediaOperationDestination.Local, {
          format: candidate,
          color: StudioExportColor.Preserve,
          resolution: size,
          quality: StudioExportQuality.High,
          subtitleMode: StudioExportSubtitleMode.Burn,
          hdrPicture: keepsHdr,
        }).supported;
        if (supported) {
          return { format: candidate, resolution: size };
        }
      }
    }
    return fallback;
  };

  /** The person picked a format, resolution, preset or shape in this opening. */
  let chosen = $state(false);

  // Every opening starts from the prototype's defaults, or the best the render workers can produce.
  $effect(() => {
    if (!open) {
      return;
    }

    chosen = false;
    const start = startingChoice();
    format = start.format;
    color = StudioExportColor.Preserve;
    resolution = start.resolution;
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
    advancedOpen = false;
    shape = StudioExportShape.Original;
    nudges = {};
    framing = null;
    framingState = 'idle';
  });

  // FL-674: the render evidence (or which sources are HDR) can arrive after the dialog opens. Until the
  // person picks something, the starting choice follows it rather than staying on a refused default.
  $effect(() => {
    void renderEvidence;
    void hdrPicture;
    if (!untrack(() => open) || untrack(() => chosen)) {
      return;
    }
    const start = startingChoice();
    format = start.format;
    resolution = start.resolution;
  });

  /* Shape (FL-563): Original, Vertical 9:16 or Square 1:1, chosen per export; the project is not changed. */
  const shapes: { value: StudioExportShape; label: Translations }[] = [
    { value: StudioExportShape.Original, label: 'frameleaf_studio_export_shape_original' },
    { value: StudioExportShape.Vertical, label: 'frameleaf_studio_export_shape_vertical' },
    { value: StudioExportShape.Square, label: 'frameleaf_studio_export_shape_square' },
  ];
  let shape = $state(StudioExportShape.Original);
  const reshaped = $derived(isReshaped(shape));
  /** The person's move of each shot, as a share of the frame width; applied to the whole shot. */
  let nudges = $state<Record<string, number>>({});
  let framing = $state<StudioReframeResponseDto | null>(null);
  let framingState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  /** A shaped picture is SDR video; the 10-bit masters, stills and sound alone keep the project's shape. */
  const shapeable = (value: StudioExportFormat) =>
    !STUDIO_STILL_FORMATS.includes(value) &&
    !STUDIO_AUDIO_FORMATS.includes(value) &&
    ![StudioExportFormat.Mp4HevcMain10, StudioExportFormat.WebmAv1, StudioExportFormat.Prores422Hq].includes(value);
  const chooseShape = (value: StudioExportShape) => {
    chosen = true;
    shape = value;
    if (isReshaped(value)) {
      // Vertical and square films are for sharing: an SDR video format, the colour kept as it is.
      if (!shapeable(format)) {
        format = StudioExportFormat.Mp4H264;
      }
      color = StudioExportColor.Preserve;
      declarePqMastering = false;
    }
  };
  // The framing is worked out once a shape is chosen, and kept for this opening of the dialog.
  $effect(() => {
    if (!open || !reshaped || !projectId || framingState !== 'idle') {
      return;
    }
    framingState = 'loading';
    const id = projectId;
    void (async () => {
      try {
        const result = await getStudioFraming({ id });
        if (open && projectId === id) {
          framing = result;
          framingState = 'ready';
        }
      } catch {
        if (open && projectId === id) {
          framingState = 'failed';
        }
      }
    })();
  });
  const projectFrame = $derived(framing ? { width: framing.width, height: framing.height } : undefined);
  const shapedOutput = $derived(reshaped ? shapedSize(shape, resolution, projectFrame) : null);
  const framingPayload = $derived<StudioExportFramingDto[]>(
    framing && reshaped
      ? framing.shots.map((item) => ({
          clipId: item.clipId,
          path: cropPath(item.path, nudges[item.clipId] ?? 0, cropShare(shape, framing!)),
        }))
      : [],
  );

  const choices = $derived(
    studioRenderChoices(renderEvidence, destination, {
      format,
      color,
      resolution,
      ...picture,
      ...(reshaped && { shape }),
    }),
  );
  const availableChoices = $derived(
    studioRenderChoices(renderEvidence, destination, {
      format,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$720P,
      ...picture,
    }),
  );
  const verdict = $derived(
    evaluateStudioRender(renderEvidence, destination, {
      format,
      color,
      resolution,
      ...(!photo && { quality }),
      ...(!photo && !audioOnly && { subtitleMode }),
      ...picture,
      ...(reshaped && { shape }),
    }),
  );
  const sidecarAvailable = $derived(
    evaluateStudioRender(renderEvidence, destination, {
      format,
      color,
      resolution,
      subtitleMode: StudioExportSubtitleMode.Sidecar,
      quality,
      ...picture,
      ...(reshaped && { shape }),
    }).supported,
  );
  const embeddedAvailable = $derived(
    evaluateStudioRender(renderEvidence, destination, {
      format,
      color,
      resolution,
      subtitleMode: StudioExportSubtitleMode.Embedded,
      quality,
      ...picture,
      ...(reshaped && { shape }),
    }).supported,
  );
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
  // A still is the one frame at Start; its End field is hidden, so only video reads outPoint.
  const selectedRange = $derived.by(() => {
    if (rangeMode !== 'frames' || typeof inPoint !== 'number' || !Number.isSafeInteger(inPoint) || inPoint < 0) {
      return null;
    }
    if (photo) {
      return { inPoint, outPoint: inPoint + 1 };
    }
    return typeof outPoint === 'number' && Number.isSafeInteger(outPoint) && outPoint > inPoint
      ? { inPoint, outPoint }
      : null;
  });
  const canExport = $derived(
    !busy &&
      !empty &&
      verdict.supported &&
      (!reshaped || framingState === 'ready' || framingState === 'failed') &&
      (!needsMastering || mastering !== null) &&
      (rangeMode === 'all' || selectedRange !== null) &&
      (smoothFactor === null || !!smoothDestination),
  );
  const unsupported = (list: { value: string; verdict: StudioRenderVerdict }[], value: string) =>
    list.find((entry) => entry.value === value)?.verdict.supported === false;
  /** Why a choice is unavailable, shown on the disabled option so it is explained before any job. */
  const refusalTitle = (list: { value: string; verdict: StudioRenderVerdict }[], value: string) => {
    const verdict = list.find((entry) => entry.value === value)?.verdict;
    return verdict && !verdict.supported ? $t(studioRenderRefusalKey(verdict.refusal)) : undefined;
  };

  const presetSupported = (preset: (typeof presets)[number]) =>
    evaluateStudioRender(renderEvidence, destination, {
      format: preset.format,
      color: StudioExportColor.Preserve,
      resolution: preset.resolution,
      ...picture,
    }).supported;
  const activePreset = $derived(
    presets.find(
      (preset) =>
        preset.format === format &&
        preset.resolution === resolution &&
        preset.quality === quality &&
        color === StudioExportColor.Preserve,
    )?.id ?? null,
  );
  const applyPreset = (preset: (typeof presets)[number]) => {
    chosen = true;
    format = preset.format;
    color = StudioExportColor.Preserve;
    resolution = preset.resolution;
    quality = preset.quality;
  };

  // Something under Advanced that stops the export must not stay folded away with its reason.
  $effect(() => {
    if ((rangeMode === 'frames' && selectedRange === null) || (needsMastering && mastering === null)) {
      advancedOpen = true;
    }
  });

  /** One line of what the person will get, in the same words as the choices above it. */
  const summary = $derived(
    $t('frameleaf_studio_export_summary', {
      values: {
        format: $t(
          formatGroups.flatMap((group) => group.items).find((item) => item.value === format)?.label ?? 'unknown',
        ),
        resolution: audioOnly
          ? $t('frameleaf_studio_export_audio_group')
          : reshaped && shapedOutput
            ? $t('frameleaf_studio_export_shaped_summary', {
                values: {
                  shape: $t(shapes.find((item) => item.value === shape)?.label ?? 'unknown'),
                  ...shapedOutput,
                },
              })
            : $t(
                [...stillResolutions, ...videoResolutions].find((item) => item.value === resolution)?.label ??
                  'unknown',
              ),
        destination: $t(destinations.find((item) => item.value === destination)?.label ?? 'unknown'),
      },
    }),
  );

  const submit = () => {
    if (canExport) {
      onExport({
        format,
        color,
        resolution,
        quality,
        ...(mastering && { mastering }),
        ...(!photo && !audioOnly && { subtitleMode }),
        ...(selectedRange && { range: selectedRange }),
        destination,
        ...(smoothFactor !== null &&
          smoothDestination && { smoothMotion: { factor: smoothFactor, destinationId: smoothDestination.id } }),
        ...(reshaped && { shape, ...(framingPayload.length > 0 && { framing: framingPayload }) }),
      });
    }
  };
</script>

<Dialog
  bind:open
  title={$t('frameleaf_studio_export_title', { values: { name: sequenceName } })}
  closeLabel={$t('close')}
  wide={reshaped}
>
  <div class="export" data-testid="studio-export-dialog">
    {#if projectId}
      <div class="shape-choice">
        <span id="{fieldId}-shape">{$t('frameleaf_studio_export_shape')}</span>
        <div class="shapes" role="radiogroup" use:rovingFocus aria-labelledby="{fieldId}-shape">
          {#each shapes as item (item.value)}
            <button
              type="button"
              role="radio"
              class="shape"
              aria-checked={shape === item.value}
              onclick={() => chooseShape(item.value)}
            >
              <span class="shape-icon {item.value}" aria-hidden="true"></span>
              <span>{$t(item.label)}</span>
            </button>
          {/each}
        </div>
      </div>
      {#if reshaped}
        {#if framingState === 'ready' && framing}
          <StudioExportReframe {framing} {shape} size={shapedOutput} bind:nudges />
        {:else if framingState === 'failed'}
          <p class="note warning reframe-status" role="status">{$t('frameleaf_studio_reframe_failed')}</p>
        {:else}
          <p class="note reframe-status" aria-busy="true">{$t('frameleaf_studio_reframe_loading')}</p>
        {/if}
      {/if}
    {/if}

    <div class="presets">
      <span id="{fieldId}-preset">{$t('frameleaf_studio_export_preset')}</span>
      <div class="segmented" role="radiogroup" use:rovingFocus aria-labelledby="{fieldId}-preset">
        {#each presets as preset (preset.id)}
          <button
            type="button"
            role="radio"
            aria-checked={activePreset === preset.id}
            disabled={!presetSupported(preset) || (reshaped && !shapeable(preset.format))}
            onclick={() => applyPreset(preset)}
          >
            {$t(preset.label)}
          </button>
        {/each}
      </div>
    </div>

    <div class="grid">
      <label class="field" for="{fieldId}-format">
        <span>{$t('frameleaf_studio_export_format')}</span>
        <select id="{fieldId}-format" bind:value={format} onchange={() => (chosen = true)}>
          {#each formatGroups as group (group.label)}
            <optgroup label={$t(group.label)}>
              {#each group.items as item (item.value)}
                <option
                  value={item.value}
                  title={refusalTitle(availableChoices.formats, item.value)}
                  disabled={unsupported(availableChoices.formats, item.value) ||
                    (reshaped && !shapeable(item.value)) ||
                    ((!hdrEnabled || outputIntent !== 'hdr') &&
                      [StudioExportFormat.HdrJpeg, StudioExportFormat.HdrHeic].includes(item.value))}
                  >{$t(item.label)}</option
                >
              {/each}
            </optgroup>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-resolution">
        <span>{$t('frameleaf_studio_export_resolution')}</span>
        <select
          id="{fieldId}-resolution"
          bind:value={resolution}
          disabled={photo || audioOnly}
          onchange={() => (chosen = true)}
        >
          {#each resolutions as item (item.value)}
            <option value={item.value} disabled={unsupported(choices.resolutions, item.value)}
              >{reshaped && shapedSize(shape, item.value)
                ? sizeLabel(shapedSize(shape, item.value)!)
                : $t(item.label)}</option
            >
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
      {#if !photo && !audioOnly}
        <label class="field" for="{fieldId}-subtitles">
          <span>{$t('frameleaf_studio_export_subtitles')}</span>
          <select id="{fieldId}-subtitles" bind:value={subtitleMode}>
            <option value={StudioExportSubtitleMode.Burn}>{$t('frameleaf_studio_export_subtitles_burn')}</option>
            <option value={StudioExportSubtitleMode.Off}>{$t('frameleaf_studio_export_subtitles_off')}</option>
            <option value={StudioExportSubtitleMode.Embedded} disabled={!embeddedAvailable}
              >{$t('frameleaf_studio_export_subtitles_embedded')}</option
            >
            <option value={StudioExportSubtitleMode.Sidecar} disabled={!sidecarAvailable}
              >{$t('frameleaf_studio_export_subtitles_sidecar')}</option
            >
          </select>
        </label>
        {#if captionLanguages.length > 0 && subtitleMode !== StudioExportSubtitleMode.Off}
          <!-- FL-641: the languages ticked "Subtitle track in the export" are saved as their own files. -->
          <p class="note" data-testid="studio-export-caption-languages">
            {$t('frameleaf_studio_export_caption_languages', { values: { languages: captionLanguages.join(', ') } })}
          </p>
        {/if}
      {/if}
    </div>

    <!-- Colour, quality and a partial range are for the occasional export; most never open this. -->
    <details class="advanced" bind:open={advancedOpen}>
      <summary>{$t('frameleaf_studio_export_advanced')}</summary>
      <div class="advanced-body">
        <div class="grid">
          <label class="field" for="{fieldId}-color">
            <span>{$t('frameleaf_studio_export_color')}</span>
            <select id="{fieldId}-color" bind:value={color} disabled={photo || audioOnly || reshaped}>
              {#each colors as item (item.value)}
                <option value={item.value} disabled={unsupported(availableChoices.colors, item.value)}
                  >{$t(item.label)}</option
                >
              {/each}
            </select>
          </label>
          <label class="field" for="{fieldId}-quality">
            <span>{$t('frameleaf_studio_export_quality')}</span>
            <select id="{fieldId}-quality" bind:value={quality} disabled={photo}>
              {#each qualities as item (item.value)}
                <option value={item.value}>{$t(item.label)}</option>
              {/each}
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
            {#if !photo}
              <label class="field" for="{fieldId}-out-point">
                <span>{$t('frameleaf_studio_export_range_end')}</span>
                <input id="{fieldId}-out-point" type="number" min="1" step="1" bind:value={outPoint} />
              </label>
            {/if}
          {/if}
        </div>
        {#if rangeMode === 'frames' && selectedRange === null}
          <p class="note warning" role="status">{$t('frameleaf_studio_export_range_invalid')}</p>
        {/if}

        {#if !photo && !audioOnly && !reshaped && color === StudioExportColor.Preserve}
          <label class="note">
            <input type="checkbox" bind:checked={declarePqMastering} />
            {$t('frameleaf_studio_export_mastering_preserve')}
          </label>
        {/if}
        {#if !photo && !audioOnly && needsMastering}
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
      </div>
    </details>

    {#if color === StudioExportColor.DolbyVision}
      <p class="note warning">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_studio_export_dolby_note')}
      </p>
    {/if}

    {#if empty}
      <p class="note warning" role="status" data-testid="studio-export-empty">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_studio_export_empty')}
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
    {#if !photo && !audioOnly}
      <fieldset class="smooth" data-testid="studio-export-smooth-motion">
        <legend>{$t('frameleaf_studio_export_smooth_motion')}</legend>
        <div
          class="segmented"
          role="radiogroup"
          use:rovingFocus
          aria-label={$t('frameleaf_studio_export_smooth_motion')}
        >
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
    {/if}

    <p class="summary" data-testid="studio-export-summary">
      <span class="sr-only">{$t('frameleaf_studio_export_summary_label')}:</span>
      {summary}
    </p>
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
    padding: 0 var(--fl-space-3);
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
  /* studio-upgrades.css `.flu-export-shape`, `.flu-shapes`, `.flu-shape` */
  .shape-choice {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .shapes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .shape {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 10px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: 13px;
    text-align: start;
    cursor: pointer;
  }
  .shape[aria-checked='true'] {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 1px var(--fl-accent);
  }
  .shape-icon {
    flex-shrink: 0;
    border: 2px solid currentColor;
    border-radius: 3px;
    opacity: 0.8;
  }
  .shape-icon.original {
    width: 24px;
    height: 14px;
  }
  .shape-icon.vertical {
    width: 12px;
    height: 22px;
  }
  .shape-icon.square {
    width: 18px;
    height: 18px;
  }
  .reframe-status {
    padding-bottom: 24px;
    border-bottom: 1px solid var(--fl-border);
  }
  .presets {
    display: grid;
    gap: var(--fl-space-1);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .advanced summary {
    display: inline-flex;
    align-items: center;
    padding-inline: var(--fl-space-2);
    margin-inline-start: calc(var(--fl-space-2) * -1);
    gap: var(--fl-space-2);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  /* `display: inline-flex` drops the native disclosure marker; a chevron keeps "Advanced" reading as something that opens. */
  .advanced summary::after {
    content: '';
    width: 0.4rem;
    height: 0.4rem;
    border-inline-end: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: translateY(-0.1rem) rotate(45deg);
  }
  @media (hover: hover) {
    .advanced summary:hover {
      color: var(--fl-text);
      background: var(--fl-raised);
    }
  }
  .advanced[open] summary {
    color: var(--fl-text);
  }
  .advanced[open] summary::after {
    transform: translateY(0.1rem) rotate(-135deg);
  }
  .advanced-body {
    display: grid;
    gap: var(--fl-space-3);
    padding-top: var(--fl-space-2);
  }
  /* What the person will get, in one line, just above the button that makes it. */
  .summary {
    margin: 0;
    padding-top: var(--fl-space-3);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
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
    border-radius: var(--fl-radius-pill);
    background: var(--fl-canvas);
    justify-self: start;
  }
  .segmented button {
    min-height: 28px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .segmented button:disabled {
    opacity: 0.45;
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
    .grid,
    .shapes {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
