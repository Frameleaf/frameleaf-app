/**
 * Couldn't process (FL-862, after the approved prototype `settings-v2/care/doctor.jsx` and
 * `library-doctor.mjs`, FL-773): the files Frameleaf could not finish (FL-845), in words.
 *
 * The server lists one row per file and step. A file shows once, with the step that failed last;
 * Try again and Keep as is act on every step of it.
 */
import { getProcessingFailures, ProcessingFailureStep, type ProcessingFailureResponseDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

/** Set aside after this many failed tries at the same step (FL-845). */
export const SET_ASIDE_AFTER = 3;

/** The most rows one read asks for; the server allows 200. */
export const FAILURES_PAGE = 200;
/** Pages read at most, so a huge failure (a drive gone) can't keep the page reading for ever. */
const MAX_PAGES = 25;

const VIDEO = /\.(mov|mp4|m4v|avi|mkv|webm|mts|m2ts|3gp|wmv|mpg|mpeg|insv|lrv)$/i;

export type ProcessingFailureFile = {
  assetId: string;
  fileName: string;
  ownerId: string;
  ownerName: string;
  /** The step that failed most recently, and why. */
  step: ProcessingFailureStep;
  cause: string;
  lastFailedAt: string;
  /** Most tries at any of its steps. */
  attempts: number;
  /** Set aside at any step: it is not tried again until someone chooses Try again. */
  setAside: boolean;
  /** Every step of this file waiting on a decision. */
  steps: ProcessingFailureStep[];
  isVideo: boolean;
};

/** One entry per file, newest failure first, as the server orders the rows. */
export const groupFailures = (rows: ProcessingFailureResponseDto[]): ProcessingFailureFile[] => {
  const files = new Map<string, ProcessingFailureFile>();
  for (const row of rows) {
    const file = files.get(row.assetId);
    if (file) {
      file.steps.push(row.step);
      file.attempts = Math.max(file.attempts, row.attempts);
      file.setAside ||= !!row.quarantinedAt;
      continue;
    }
    files.set(row.assetId, {
      assetId: row.assetId,
      fileName: row.fileName,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      step: row.step,
      cause: row.cause,
      lastFailedAt: row.lastFailedAt,
      attempts: row.attempts,
      setAside: !!row.quarantinedAt,
      steps: [row.step],
      isVideo: VIDEO.test(row.fileName),
    });
  }
  return [...files.values()];
};

/**
 * After Try again the server starts each step afresh (no tries counted) until it works, when the
 * row goes, or fails again.
 */
export const isRetrying = (file: ProcessingFailureFile) => file.attempts === 0;

const CAUSES = new Set(['unreadable', 'unsupported', 'too-large', 'timed-out', 'crashed']);

/** The headline for FL-845's cause, for a photo or a video. */
export const causeWords = (file: Pick<ProcessingFailureFile, 'cause' | 'isVideo'>): Translations => {
  const cause = CAUSES.has(file.cause) ? file.cause.replace('-', '_') : 'other';
  return `frameleaf_processing_failure_${cause}_${file.isVideo ? 'video' : 'photo'}` as Translations;
};

const STEPS: Record<ProcessingFailureStep, Translations> = {
  [ProcessingFailureStep.AssetExtractMetadata]: 'frameleaf_processing_failure_step_metadata',
  [ProcessingFailureStep.AssetGenerateThumbnails]: 'frameleaf_processing_failure_step_previews',
  [ProcessingFailureStep.AssetEncodeVideo]: 'frameleaf_processing_failure_step_video',
  [ProcessingFailureStep.SmartSearch]: 'frameleaf_processing_failure_step_search',
  [ProcessingFailureStep.AssetDetectFaces]: 'frameleaf_processing_failure_step_faces',
  [ProcessingFailureStep.Ocr]: 'frameleaf_processing_failure_step_text',
};

/** The row's second line: what Frameleaf was doing, and that the original is fine. */
export const stepWords = (step: ProcessingFailureStep): Translations =>
  STEPS[step] ?? 'frameleaf_processing_failure_step_other';

/** The items an action sends for these files: every waiting step of each. */
export const actionItems = (files: ProcessingFailureFile[]) =>
  files.flatMap((file) => file.steps.map((step) => ({ assetId: file.assetId, step })));

/**
 * Every row the reader may see, page by page, so one file's rows are never split and the count
 * matches the server's own (the Overview's).
 */
export const readFailures = async () => {
  const rows: ProcessingFailureResponseDto[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = await getProcessingFailures({ skip: page * FAILURES_PAGE, take: FAILURES_PAGE });
    rows.push(...next);
    if (next.length < FAILURES_PAGE) {
      break;
    }
  }
  return rows;
};

/**
 * How many files the reader may see wait on a decision, and how many are set aside: the list's own
 * count, so a row and the page it opens agree. Nothing when the list can't be read.
 */
export const processingFailureCounts = async () => {
  try {
    const files = groupFailures(await readFailures());
    return { count: files.length, setAside: files.filter((file) => file.setAside && !isRetrying(file)).length };
  } catch {
    return undefined;
  }
};
