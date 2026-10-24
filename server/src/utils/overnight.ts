/**
 * FL-363: the server's own night work runs from one schedule, one step after another: empty Trash
 * and tidy up, check added folders, bring in new iCloud photos, check files. Each step starts when the
 * one before it has finished; a step that is switched off or not set up is left out. This module is
 * the order and the rules; `OvernightService` does the work.
 *
 * Backups keep a schedule of their own (FL-362). The two are independent, as the owner decided.
 */
import { DateTime } from 'luxon';
import { OvernightStepTiming } from 'src/enum.js';

/** The steps in the order a night runs them. Tidy-up is first (owner, 2026-10-10). */
export const OVERNIGHT_STEPS = ['cleanup', 'folders', 'icloud', 'fileChecks'] as const;
export type OvernightStep = (typeof OVERNIGHT_STEPS)[number];

/**
 * FL-540: the steps that compete with a running backup for the disk or the internet, so they wait for
 * it to finish when the two schedules overlap. Emptying Trash and tidying up does not, so a long first
 * backup never holds it back.
 */
export const OVERNIGHT_STEPS_COMPETING_WITH_BACKUP: ReadonlySet<OvernightStep> = new Set([
  'folders',
  'icloud',
  'fileChecks',
]);

/**
 * What a step did. `off`: switched off or not set up. `skipped`: not its night (weekly, or only when
 * started by hand). `stopped`: the stop time came first, so it carries on the next night.
 * `unfinished`: it was still running when the run moved on.
 */
export type OvernightStepResult = 'done' | 'off' | 'skipped' | 'stopped' | 'failed' | 'unfinished';

export type OvernightRun = {
  startedAt: string;
  /** Started with "Run now": every step that is on runs, whatever its own timing. */
  manual: boolean;
  /** The step the run has reached. */
  step: OvernightStep;
  /** When the step was begun; the run waits for it to finish before moving on. */
  begunAt: string | null;
  results: Partial<Record<OvernightStep, OvernightStepResult>>;
  /** FL-518: items in Trash already past their keep time when the run started, and that cut-off. */
  trashDue?: { cutoff: string; count: number };
  /** FL-540: when the step began waiting for a running backup to finish; absent while it does not wait. */
  waitingForBackupSince?: string | null;
};

export type OvernightNight = {
  startedAt: string;
  finishedAt: string;
  manual: boolean;
  results: Partial<Record<OvernightStep, OvernightStepResult>>;
  /** FL-518: items that left Trash for good during the run; null when not measured. */
  removedFromTrash?: number | null;
  /** FL-518: photos and videos that came in during the run (folders, iCloud, phones). */
  newFiles?: number | null;
};

export type OvernightState = {
  run: OvernightRun | null;
  /** The most recent runs, newest first. */
  nights: OvernightNight[];
};

/** How many past runs are kept for "Recent nights". */
export const OVERNIGHT_NIGHTS_KEPT = 7;

/** A step still running after this long is left to finish on its own while the run moves on. */
export const OVERNIGHT_STEP_LIMIT_MS = 3 * 60 * 60 * 1000;

export const nextOvernightStep = (step: OvernightStep): OvernightStep | null =>
  OVERNIGHT_STEPS[OVERNIGHT_STEPS.indexOf(step) + 1] ?? null;

/** The schedule as a cron expression: the start time, on the chosen days of the week. */
export const overnightCron = ({ startTime, days }: { startTime: string; days: number[] }): string => {
  const [hours, minutes] = startTime.split(':').map(Number);
  const chosen = [...new Set(days)].filter((day) => day >= 0 && day <= 6).toSorted((a, b) => a - b);
  const dayField = chosen.length === 0 || chosen.length === 7 ? '*' : chosen.join(',');
  return `${minutes} ${hours} * * ${dayField}`;
};

/**
 * Whether a step with this timing runs in a run started at `startedAt` (in `zone`). "Run now" runs
 * every step that is on; a scheduled run leaves out weekly steps on other days and steps that run
 * only when started by hand.
 */
export const isStepDue = (
  timing: OvernightStepTiming,
  { manual, startedAt, weeklyDay, zone }: { manual: boolean; startedAt: string; weeklyDay: number; zone: string },
): boolean => {
  if (manual) {
    return true;
  }
  switch (timing) {
    case OvernightStepTiming.Nightly: {
      return true;
    }
    case OvernightStepTiming.Weekly: {
      // luxon numbers Monday 1 … Sunday 7; the setting numbers Sunday 0 … Saturday 6, as cron does
      return DateTime.fromISO(startedAt, { zone }).weekday % 7 === weeklyDay;
    }
    case OvernightStepTiming.Manual: {
      return false;
    }
  }
};

/**
 * When a run started at `startedAt` must stop starting new steps: the first `stopTime` after the
 * start, in `zone`. An empty stop time never stops.
 */
export const overnightStopAt = (startedAt: string, stopTime: string, zone: string): DateTime | null => {
  if (!stopTime) {
    return null;
  }
  const [hour, minute] = stopTime.split(':').map(Number);
  const start = DateTime.fromISO(startedAt, { zone });
  let stop = start.set({ hour, minute, second: 0, millisecond: 0 });
  if (stop <= start) {
    stop = stop.plus({ days: 1 });
  }
  return stop;
};

/** Adds a finished run to the front of the kept nights. */
export const keepNight = (nights: OvernightNight[], night: OvernightNight): OvernightNight[] =>
  [night, ...nights].slice(0, OVERNIGHT_NIGHTS_KEPT);
