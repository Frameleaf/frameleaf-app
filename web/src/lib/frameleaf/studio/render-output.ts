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
import { StudioExportColor, StudioExportFormat, StudioExportResolution } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import type { StudioRenderEvidence } from './host-contract';

export type StudioRenderRefusal =
  'no-qualified-worker' | 'insufficient-memory' | 'codec-unavailable' | 'incompatible-color';

export type StudioRenderSettings = {
  format: StudioExportFormat;
  color: StudioExportColor;
  resolution: StudioExportResolution;
};

export type StudioRenderVerdict = { supported: true } | { supported: false; refusal: StudioRenderRefusal };

/** GPU memory each resolution needs (mirrors `RENDER_MEMORY_BY_RESOLUTION`). */
const MEMORY_BY_RESOLUTION: Readonly<Record<StudioExportResolution, number>> = {
  [StudioExportResolution.$720P]: 2 * 1024 ** 3,
  [StudioExportResolution.$1080P]: 4 * 1024 ** 3,
  [StudioExportResolution.$1440P]: 6 * 1024 ** 3,
  [StudioExportResolution.$2160P]: 8 * 1024 ** 3,
};

/** The encoder each format needs (mirrors `FORMAT_ENCODERS`). */
const FORMAT_ENCODERS: Readonly<Record<StudioExportFormat, RegExp>> = {
  [StudioExportFormat.Mp4HevcMain10]: /hevc|h\.?265|x265/i,
  [StudioExportFormat.Mp4H264]: /h\.?264|avc|x264/i,
  [StudioExportFormat.WebmAv1]: /av1|svt|aom|rav1e/i,
  [StudioExportFormat.Prores422Hq]: /prores/i,
};

/** The bit depth each format writes (mirrors `FORMAT_BIT_DEPTH`). */
const FORMAT_BIT_DEPTH: Readonly<Record<StudioExportFormat, number>> = {
  [StudioExportFormat.Mp4HevcMain10]: 10,
  [StudioExportFormat.Mp4H264]: 8,
  [StudioExportFormat.WebmAv1]: 10,
  [StudioExportFormat.Prores422Hq]: 10,
};

const colorSupported = (settings: StudioRenderSettings, evidence: StudioRenderEvidence) => {
  const depth = Math.max(FORMAT_BIT_DEPTH[settings.format], settings.color === StudioExportColor.Preserve ? 8 : 10);
  if (evidence.maxBitDepth < depth) {
    return false;
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
  const row = evidence.find((entry) => entry.destination === destination);
  if (!row || row.sessions <= 0) {
    return { supported: false, refusal: 'no-qualified-worker' };
  }
  if (row.gpuMemoryBytes === null || row.gpuMemoryBytes < MEMORY_BY_RESOLUTION[settings.resolution]) {
    return { supported: false, refusal: 'insufficient-memory' };
  }
  if (row.codecs.every((codec) => !FORMAT_ENCODERS[settings.format].test(codec))) {
    return { supported: false, refusal: 'codec-unavailable' };
  }
  if (!colorSupported(settings, row)) {
    return { supported: false, refusal: 'incompatible-color' };
  }
  return { supported: true };
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
    verdict: evaluateStudioRender(evidence, destination, { ...current, format }),
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
