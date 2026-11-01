/**
 * Which Studio export settings a qualified render worker can produce (FL-42).
 *
 * The server refuses an export up front (`409 studio_export_unsupported`) unless a live, qualified
 * render session for the chosen destination verified the GPU memory the resolution needs, an encoder
 * for the format and the colour precision (`server/src/utils/render-admission.ts`,
 * `evaluateRenderOutput`). The capability snapshot publishes that evidence per destination
 * (`studio.render`). This module applies the same rules to it so the export choices can be shown
 * disabled, each with the reason the server would give, before anything is submitted. It never
 * enables a choice the evidence does not support; the server still decides at submission.
 */
import {
  StudioExportColor,
  StudioExportFormat,
  StudioExportResolution,
  StudioExportShape,
  StudioExportSubtitleMode,
  StudioExportQuality,
  type StudioRenderCandidateDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { StudioRenderEvidence } from './host-contract';

export type StudioRenderRefusal =
  'no-qualified-worker' | 'insufficient-memory' | 'codec-unavailable' | 'incompatible-color';

export type StudioRenderSettings = {
  format: StudioExportFormat;
  color: StudioExportColor;
  resolution: StudioExportResolution;
  subtitleMode?: StudioExportSubtitleMode;
  quality?: StudioExportQuality;
  /** FL-563: vertical and square need SDR video and a session that reframes (`reframe-v1`). */
  shape?: StudioExportShape;
  /**
   * FL-674: the project keeps an HDR picture. Without it the picture is SDR, and a 10-bit video
   * format needs a session that writes one for SDR (`sdrTenBit`), not only HDR masters.
   */
  hdrPicture?: boolean;
};

export type StudioRenderVerdict = { supported: true } | { supported: false; refusal: StudioRenderRefusal };

/** GPU memory each resolution needs (mirrors `RENDER_MEMORY_BY_RESOLUTION`). */
const MEMORY_BY_RESOLUTION: Readonly<Record<StudioExportResolution, number>> = {
  [StudioExportResolution.Original]: 8 * 1024 ** 3,
  [StudioExportResolution.$720P]: 2 * 1024 ** 3,
  [StudioExportResolution.$1080P]: 4 * 1024 ** 3,
  [StudioExportResolution.$1440P]: 6 * 1024 ** 3,
  [StudioExportResolution.$2160P]: 8 * 1024 ** 3,
};

/** The picture precision each format promises (mirrors `STUDIO_EXPORT_FORMAT_SPECS.bitDepth`). */
const FORMAT_BIT_DEPTH: Readonly<Record<StudioExportFormat, number>> = {
  [StudioExportFormat.SdrJpeg]: 8,
  [StudioExportFormat.HdrJpeg]: 10,
  [StudioExportFormat.HdrHeic]: 10,
  [StudioExportFormat.Mp4HevcMain10]: 10,
  [StudioExportFormat.Mp4H264]: 8,
  [StudioExportFormat.WebmAv1]: 10,
  [StudioExportFormat.Prores422Hq]: 10,
  [StudioExportFormat.Mp4Hevc]: 8,
  [StudioExportFormat.Mp4Av1]: 8,
  [StudioExportFormat.MovH264]: 8,
  [StudioExportFormat.MovHevc]: 8,
  [StudioExportFormat.MovProres422]: 8,
  [StudioExportFormat.MkvH264]: 8,
  [StudioExportFormat.MkvHevc]: 8,
  [StudioExportFormat.MkvVp8]: 8,
  [StudioExportFormat.MkvVp9]: 8,
  [StudioExportFormat.MkvAv1]: 8,
  [StudioExportFormat.WebmVp8]: 8,
  [StudioExportFormat.WebmVp9]: 8,
  [StudioExportFormat.WebmAv1Sdr]: 8,
  [StudioExportFormat.AudioMp3]: 8,
  [StudioExportFormat.AudioAac]: 8,
  [StudioExportFormat.AudioWav]: 8,
};

export const STUDIO_STILL_FORMATS: readonly StudioExportFormat[] = [
  StudioExportFormat.SdrJpeg,
  StudioExportFormat.HdrJpeg,
  StudioExportFormat.HdrHeic,
];

/** FL-105: the project's sound alone. No picture, no captions; it stays with its project. */
export const STUDIO_AUDIO_FORMATS: readonly StudioExportFormat[] = [
  StudioExportFormat.AudioMp3,
  StudioExportFormat.AudioAac,
  StudioExportFormat.AudioWav,
];

const isVideoFormat = (format: StudioExportFormat) =>
  !STUDIO_STILL_FORMATS.includes(format) && !STUDIO_AUDIO_FORMATS.includes(format);

/** SDR video formats: the only ones that can carry captions as a file or a track. */
const isSdrVideoFormat = (format: StudioExportFormat) => isVideoFormat(format) && FORMAT_BIT_DEPTH[format] === 8;

const colorSupported = (settings: StudioRenderSettings, evidence: StudioRenderCandidateDto) => {
  const depth = Math.max(FORMAT_BIT_DEPTH[settings.format], settings.color === StudioExportColor.Preserve ? 8 : 10);
  if (evidence.maxBitDepth < depth) {
    return false;
  }
  if (
    settings.color === StudioExportColor.Preserve &&
    !settings.hdrPicture &&
    isVideoFormat(settings.format) &&
    FORMAT_BIT_DEPTH[settings.format] > 8 &&
    evidence.sdrTenBit !== true
  ) {
    return false;
  }
  if (settings.format === StudioExportFormat.HdrJpeg || settings.format === StudioExportFormat.HdrHeic) {
    return settings.color === StudioExportColor.Preserve && evidence.hdr10;
  }
  if (settings.color === StudioExportColor.Hdr10) {
    return evidence.hdr10;
  }
  if (settings.color === StudioExportColor.DolbyVision) {
    return evidence.dolbyVision;
  }
  return true;
};

/** The server's verdict for one combination on one destination, from the published evidence. */
export const evaluateStudioRender = (
  evidence: readonly StudioRenderEvidence[],
  destination: string,
  settings: StudioRenderSettings,
): StudioRenderVerdict => {
  const candidates = evidence
    .filter((entry) => entry.destination === destination && entry.sessions > 0)
    .flatMap((entry) => entry.candidates ?? []);
  if (candidates.length === 0) {
    return { supported: false, refusal: 'no-qualified-worker' };
  }
  const withMemory = candidates.filter(
    (candidate) =>
      candidate.gpuMemoryBytes !== null && candidate.gpuMemoryBytes >= MEMORY_BY_RESOLUTION[settings.resolution],
  );
  if (withMemory.length === 0) {
    return { supported: false, refusal: 'insufficient-memory' };
  }
  // The API derives this list with requiredOutput/provesOutput, including exact writer/container proof.
  const sidecar = settings.subtitleMode === StudioExportSubtitleMode.Sidecar;
  const embedded = settings.subtitleMode === StudioExportSubtitleMode.Embedded;
  if ((sidecar || embedded) && (!isSdrVideoFormat(settings.format) || settings.color !== StudioExportColor.Preserve)) {
    return { supported: false, refusal: 'codec-unavailable' };
  }
  if (
    STUDIO_AUDIO_FORMATS.includes(settings.format) &&
    settings.subtitleMode !== undefined &&
    settings.subtitleMode !== StudioExportSubtitleMode.Off
  ) {
    return { supported: false, refusal: 'codec-unavailable' };
  }
  const reshaped = settings.shape !== undefined && settings.shape !== StudioExportShape.Original;
  if (reshaped && (!isSdrVideoFormat(settings.format) || settings.color !== StudioExportColor.Preserve)) {
    return { supported: false, refusal: 'codec-unavailable' };
  }
  const withOutput = withMemory.filter(
    (candidate) =>
      candidate.outputFormats.includes(settings.format) &&
      (!reshaped || candidate.reframe === true) &&
      (settings.shape !== StudioExportShape.Landscape || candidate.landscapeReframe === true) &&
      (!sidecar || candidate.sidecarOutputFormats?.includes(settings.format)) &&
      (!embedded || candidate.embeddedOutputFormats?.includes(settings.format)),
  );
  if (withOutput.length === 0) {
    return { supported: false, refusal: 'codec-unavailable' };
  }
  if (withOutput.every((candidate) => !colorSupported(settings, candidate))) {
    return { supported: false, refusal: 'incompatible-color' };
  }
  return { supported: true };
};

/**
 * FL-674, FL-689: whether an export that keeps the source colour keeps an HDR picture. The server
 * seals one only when every placed video shares one HDR transfer, whatever the project's working
 * range: all PQ (`resources.pqSources`) or all HLG (`resources.hlgSources`). Anything less, such as
 * PQ mixed with HLG, SDR, or Dolby Vision without either transfer, is judged as SDR.
 */
export const studioKeepsHdrPicture = (
  graph: unknown,
  resources: { pqSources?: readonly string[]; hlgSources?: readonly string[] } | null | undefined,
): boolean => {
  const videos = new Set<string>();
  let budget = 100_000;
  const visit = (value: unknown, depth: number) => {
    if (--budget < 0 || depth > 64 || !value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'video' && typeof node.mediaId === 'string') {
      videos.add(node.mediaId.toLowerCase());
    }
    for (const item of Object.values(node)) {
      visit(item, depth + 1);
    }
  };
  visit((graph as { timeline?: unknown } | null)?.timeline, 0);
  const sharesTransfer = (sources: readonly string[] | undefined) => {
    const transfer = new Set((sources ?? []).map((id) => id.toLowerCase()));
    for (const id of videos) {
      if (!transfer.has(id)) {
        return false;
      }
    }
    return true;
  };
  return videos.size > 0 && (sharesTransfer(resources?.pqSources) || sharesTransfer(resources?.hlgSources));
};

export type StudioRenderChoice<T> = { value: T; verdict: StudioRenderVerdict };

export type StudioRenderChoices = {
  formats: StudioRenderChoice<StudioExportFormat>[];
  colors: StudioRenderChoice<StudioExportColor>[];
  resolutions: StudioRenderChoice<StudioExportResolution>[];
};

/**
 * Each choice of the export sheet, judged with the other two settings as currently chosen, so a
 * disabled option always names the reason that exact export would be refused.
 */
export const studioRenderChoices = (
  evidence: readonly StudioRenderEvidence[],
  destination: string,
  current: StudioRenderSettings,
): StudioRenderChoices => ({
  formats: Object.values(StudioExportFormat).map((format) => ({
    value: format,
    verdict: evaluateStudioRender(evidence, destination, {
      ...current,
      format,
      ...(STUDIO_STILL_FORMATS.includes(format) && {
        resolution: StudioExportResolution.Original,
        color: StudioExportColor.Preserve,
      }),
      ...(STUDIO_AUDIO_FORMATS.includes(format) && {
        resolution: StudioExportResolution.$720P,
        color: StudioExportColor.Preserve,
        subtitleMode: undefined,
      }),
    }),
  })),
  colors: Object.values(StudioExportColor).map((color) => ({
    value: color,
    verdict: evaluateStudioRender(evidence, destination, { ...current, color }),
  })),
  resolutions: Object.values(StudioExportResolution).map((resolution) => ({
    value: resolution,
    verdict: evaluateStudioRender(evidence, destination, { ...current, resolution }),
  })),
});

export const studioRenderRefusalKey = (refusal: StudioRenderRefusal): Translations => {
  switch (refusal) {
    case 'no-qualified-worker': {
      return 'frameleaf_studio_render_refusal_no_qualified_worker';
    }
    case 'insufficient-memory': {
      return 'frameleaf_studio_render_refusal_insufficient_memory';
    }
    case 'codec-unavailable': {
      return 'frameleaf_studio_render_refusal_codec_unavailable';
    }
    case 'incompatible-color': {
      return 'frameleaf_studio_render_refusal_incompatible_color';
    }
  }
};

const REFUSALS: ReadonlySet<string> = new Set<StudioRenderRefusal>([
  'no-qualified-worker',
  'insufficient-memory',
  'codec-unavailable',
  'incompatible-color',
]);

/** The refusal a `409 studio_export_unsupported` answer carries, when it is one the host knows. */
export const studioRenderRefusalFromError = (body: unknown): StudioRenderRefusal | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const { code, reason } = body as { code?: unknown; reason?: unknown };
  if (code !== 'studio_export_unsupported') {
    return null;
  }
  return typeof reason === 'string' && REFUSALS.has(reason) ? (reason as StudioRenderRefusal) : null;
};
