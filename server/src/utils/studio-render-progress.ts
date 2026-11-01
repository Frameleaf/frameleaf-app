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

/** Worker error text can contain paths or credentials. Only fixed, actionable copy leaves the server. */
export const studioExportFailure = (code: string | null): string => {
  if (code && /(?:source|input|media|project).*(?:changed|unavailable|missing|access)/.test(code)) {
    return 'Check that the project and its sources are still available, then export again from Studio.';
  }
  if (code && /(?:too_large|storage|output_limit|quota)/.test(code)) {
    return 'Check available storage and the export size limits, then export again from Studio.';
  }
  return 'Check the render worker connection and supported export settings, then export again from Studio.';
};
