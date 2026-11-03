/**
 * Overnight schedule (FL-363) in plain words: the pieces of the page that are not drawing, kept apart
 * so they can be tested on their own.
 */
import type { OvernightResultsDto } from '@frameleaf/sdk';

/** The steps in the order a night runs them (the server's `OVERNIGHT_STEPS`). */
export const OVERNIGHT_STEP_IDS = ['cleanup', 'folders', 'icloud', 'fileChecks'] as const;
export type OvernightStepId = (typeof OVERNIGHT_STEP_IDS)[number];

const NOT_FINISHED: ReadonlySet<string> = new Set(['stopped', 'failed', 'unfinished']);

/**
 * How one night went: the steps that ran to the end, and the ones that did not (stopped by the stop
 * time, failed to start, or still running when the night moved on). Steps that were off or not due
 * are neither.
 */
export const nightOutcome = (results: OvernightResultsDto) => {
  const ran = OVERNIGHT_STEP_IDS.filter((id) => results[id] === 'done');
  const notFinished = OVERNIGHT_STEP_IDS.filter((id) => NOT_FINISHED.has(results[id] ?? 'off'));
  return { ran, notFinished, problem: notFinished.length > 0 };
};

/** The sentence that says the schedule back: which message, by whether it runs some days and stops. */
export const overnightWords = ({ someDays, stop }: { someDays: boolean; stop: boolean }) =>
  someDays
    ? stop
      ? 'frameleaf_overnight_words_days_stop'
      : 'frameleaf_overnight_words_days'
    : stop
      ? 'frameleaf_overnight_words_night_stop'
      : 'frameleaf_overnight_words_night';

const minutes = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
};

/**
 * Whether the night's work starts within an hour either side of the backups. The two schedules are
 * independent, so starting together means both read the disk at once.
 */
export const startsNearBackups = (start: string, backup: string) => {
  const gap = Math.abs(minutes(start) - minutes(backup));
  return Math.min(gap, 1440 - gap) < 60;
};
