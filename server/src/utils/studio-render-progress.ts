import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';

export type StudioRenderStage = 'preparing' | 'rendering' | 'finalising';
export type StudioRenderReport = { stage: StudioRenderStage; unit?: 'frames' };
type Sample = { at: number; frames: number };
export type StudioRenderMeasurement = {
  attempt: number;
  stage: StudioRenderStage;
  unit: 'frames' | null;
  processed: number;
  total: number | null;
  lastProgressAt: number;
  samples: Sample[];
};
const STAGES: StudioRenderStage[] = ['preparing', 'rendering', 'finalising'];
const finiteCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const measurementOf = (value: unknown): StudioRenderMeasurement | undefined => {
  const stored = value as StudioRenderMeasurement | undefined;
  return stored &&
    finiteCount(stored.attempt) &&
    STAGES.includes(stored.stage) &&
    finiteCount(stored.processed) &&
    (stored.total === null || finiteCount(stored.total)) &&
    (stored.unit === 'frames' || stored.unit === null) &&
    Number.isFinite(stored.lastProgressAt) &&
    Math.abs(stored.lastProgressAt) <= 8.64e15 &&
    Array.isArray(stored.samples) &&
    stored.samples.length <= 8 &&
    stored.samples.every(
      (sample, index) =>
        sample &&
        Number.isFinite(sample.at) &&
        Math.abs(sample.at) <= 8.64e15 &&
        finiteCount(sample.frames) &&
        (index === 0 || (sample.at > stored.samples[index - 1].at && sample.frames > stored.samples[index - 1].frames)),
    )
    ? stored
    : undefined;
};

/** A claim attempt owns its measurements; duplicates cannot refresh the last meaningful progress. */
export const advanceStudioRenderProgress = (
  previous: unknown,
  attempt: number,
  report: StudioRenderReport,
  processed: number,
  total: number | null,
  now: number,
): StudioRenderMeasurement | null => {
  if (!finiteCount(processed) || (total !== null && (!finiteCount(total) || processed > total))) return null;
  const stored = measurementOf(previous);
  const prior = stored?.attempt === attempt ? stored : undefined;
  const unit = report.unit ?? null;
  const sameCursor = prior?.stage === report.stage && prior?.unit === unit;
  if (
    prior &&
    (STAGES.indexOf(report.stage) < STAGES.indexOf(prior.stage) ||
      now < prior.lastProgressAt ||
      (sameCursor &&
        (processed < prior.processed || (total !== null && prior.total !== null && total !== prior.total))) ||
      (prior.stage === report.stage && prior.unit === 'frames' && unit !== 'frames'))
  )
    return null;
  const changed = !prior || !sameCursor || processed > prior.processed;
  const samples = sameCursor && prior.total === total ? [...prior.samples] : [];
  if (
    report.stage === 'rendering' &&
    unit === 'frames' &&
    (samples.length === 0 || (processed > samples.at(-1)!.frames && now > samples.at(-1)!.at))
  ) {
    samples.push({ at: now, frames: processed });
  }
  return {
    attempt,
    stage: report.stage,
    unit,
    processed,
    total,
    lastProgressAt: changed ? now : prior!.lastProgressAt,
    samples: samples.slice(-8),
  };
};

export const studioRenderProgressOf = (operation: {
  kind: string;
  status: string;
  attempt: number;
  result: Record<string, unknown> | null;
}) => {
  if (operation.kind !== MediaOperationKind.StudioExport) return null;
  const stored = measurementOf(operation.result?.studioRenderProgress);
  const measurement = stored?.attempt === operation.attempt ? stored : undefined;
  const stage: StudioRenderStage =
    operation.status === MediaOperationStatus.Validating
      ? 'finalising'
      : [MediaOperationStatus.Preparing, MediaOperationStatus.Queued].includes(operation.status as MediaOperationStatus)
        ? 'preparing'
        : (measurement?.stage ?? 'rendering');
  const first = measurement?.samples[0];
  const last = measurement?.samples.at(-1);
  const rate =
    operation.status === MediaOperationStatus.Rendering &&
    stage === 'rendering' &&
    measurement &&
    measurement.samples.length >= 3 &&
    first &&
    last &&
    last.at - first.at >= 2000 &&
    last.frames > first.frames
      ? (last.frames - first.frames) / ((last.at - first.at) / 1000)
      : null;
  return {
    stage,
    lastProgressAt: measurement ? new Date(measurement.lastProgressAt).toISOString() : null,
    framesPerSecond: rate,
    remainingRenderSeconds:
      rate && measurement?.total !== null && measurement?.total !== undefined
        ? Math.max(0, (measurement.total - measurement.processed) / rate)
        : null,
  };
};

const BUNDLED_EXPORT_FAILURE_GUIDANCE = new Map([
  [
    'bundled_effects_need_gpu',
    'Give the machine-learning container a GPU, or remove the enabled effects, then export again from Studio.',
  ],
  ['bundled_missing_media', 'Relink the missing media in Studio and confirm source access, then export again.'],
  [
    'bundled_no_audio',
    'Check the timeline audio and mute settings. Add audible audio, or choose a video export, then export again from Studio.',
  ],
  ['bundled_empty_timeline', 'Add a clip to the timeline before exporting again from Studio.'],
  ['bundled_invalid_range', 'Choose an export range within the timeline, then export again from Studio.'],
  [
    'bundled_captions_changed',
    'The captions changed after this export was queued. Save the project, review the captions, then export again from Studio.',
  ],
  [
    'bundled_captions_unsupported',
    'Review the caption mode and format. Use burned-in captions or a supported SDR video format, then export again from Studio.',
  ],
  [
    'bundled_subtitles_unsupported',
    'Review the caption mode and format. Use burned-in captions or a supported SDR video format, then export again from Studio.',
  ],
  [
    'bundled_hdr_unsupported',
    'For an HDR picture, choose MP4 with HEVC Main10 on a qualified HDR worker, then export again from Studio.',
  ],
  [
    'bundled_hdr_resolution',
    'Export an HDR master at the project size and original shape, or choose an SDR video format for a different size or shape.',
  ],
  [
    'bundled_invalid_mastering',
    'Review the HDR mastering display settings used to grade the project, then export again from Studio.',
  ],
  [
    'bundled_hdr_mastering_exceeded',
    'The picture exceeds the declared HDR mastering display. Review the grading and mastering display settings, then export again.',
  ],
  [
    'bundled_hdr_master_failed',
    'The HDR master could not be completed or verified. Check the worker’s HDR encoder support and export settings, then export again from Studio.',
  ],
  [
    'bundled_inputs_too_large',
    'Choose a worker with a larger input size limit, or reduce the project’s source media, then export again from Studio.',
  ],
]);

/** Worker error text can contain paths or credentials. Only fixed, actionable copy leaves the server. */
export const studioExportFailure = (code: string | null): string => {
  const bundledGuidance = BUNDLED_EXPORT_FAILURE_GUIDANCE.get(code ?? '');
  if (bundledGuidance) return bundledGuidance;
  if (code && /(?:source|input|media|project).*(?:changed|unavailable|missing|access)/.test(code)) {
    return 'Check that the project and its sources are still available, then export again from Studio.';
  }
  if (code && /(?:too_large|storage|output_limit|quota)/.test(code)) {
    return 'Check available storage and the export size limits, then export again from Studio.';
  }
  return 'Check the render worker connection and supported export settings, then export again from Studio.';
};
