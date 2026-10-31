/**
 * FL-363: the server's own night work runs from one schedule, one step after another: empty Trash
 * and tidy up, check added folders, bring in new iCloud photos, check files. Each step starts when the
 * one before it has finished; a step that is switched off or not set up is left out. This module is
 * the order and the rules; `OvernightService` does the work.
 *
 * Backups keep a schedule of their own (FL-362). The two are independent, as the owner decided.
 */
import { CronTime } from 'cron';
import { DateTime } from 'luxon';
import { OvernightStepTiming, QueueName } from 'src/enum.js';

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

/** FL-577: quiet hours. `holding`: the heavy queues this server paused; null while heavy work may run. */
export type OvernightQuiet = {
  holding: QueueName[] | null;
  /** With no stop time, when the heavy work last caught up; it waits again until the next start. */
  caughtUpAt?: string;
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
  quiet?: OvernightQuiet;
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

/**
 * FL-577: quiet hours. With "Save heavy background work for the night" on, these queues wait for the
 * overnight window: everything beyond thumbnails (owner, 2026-10-27). Uploads, metadata and thumbnails
 * never wait, so a phone upload shows up at any time. Sensitive-content detection never waits either:
 * it keeps sensitive items hidden.
 */
export const QUIET_HOURS_QUEUES: readonly QueueName[] = [
  QueueName.VideoConversion,
  QueueName.FaceDetection,
  QueueName.FacialRecognition,
  QueueName.SmartSearch,
  QueueName.DuplicateDetection,
  QueueName.VideoDuplicateDetection,
  QueueName.Ocr,
  QueueName.ImageEnrichment,
  QueueName.ImageDescription,
  QueueName.PetRecognition,
];

/** The most recent scheduled start at or before `now`, in `zone`; null if none in the last week. */
export const lastOvernightStart = (
  now: DateTime,
  { startTime, days }: { startTime: string; days: number[] },
  zone: string,
): DateTime | null => {
  const [hour, minute] = startTime.split(':').map(Number);
  const today = now.setZone(zone).set({ hour, minute, second: 0, millisecond: 0 });
  // No chosen day means every day, as in `overnightCron`.
  const everyDay = days.every((day) => day < 0 || day > 6);
  for (let back = 0; back <= 7; back++) {
    const start = today.minus({ days: back });
    if (start <= now && (everyDay || days.includes(start.weekday % 7))) {
      return start;
    }
  }
  return null;
};

/**
 * Whether heavy work may run now: inside the overnight window, from the start time to the stop time.
 * With no stop time it runs from the start time until it has caught up (`caughtUpAt`).
 */
export const isHeavyWorkWindow = (
  now: DateTime,
  nightly: { startTime: string; stopTime: string; days: number[] },
  zone: string,
  caughtUpAt?: string,
): boolean => {
  const start = lastOvernightStart(now, nightly, zone);
  if (!start) {
    return false;
  }
  if (!nightly.stopTime) {
    return !caughtUpAt || DateTime.fromISO(caughtUpAt) < start;
  }
  return now < overnightStopAt(start.toISO()!, nightly.stopTime, zone)!;
};

/**
 * FL-711: the heavy queues quiet hours hold now, each with when the overnight window opens and they
 * start again by themselves (null when the schedule never fires). Callers check the queue is still
 * paused: one an administrator resumed during the day is no longer held. Such a pause lifts on its
 * own, so it is said as "saved for tonight", never as work that waits until someone starts it again.
 */
export const quietHoursHolds = (
  state: Pick<OvernightState, 'quiet'> | null | undefined,
  nightly: { startTime: string; days: number[] },
  zone: string,
  now: Date = new Date(),
): Map<QueueName, string | null> => {
  const holding = state?.quiet?.holding ?? [];
  if (holding.length === 0) {
    return new Map();
  }
  let resumesAt: string | null = null;
  try {
    resumesAt = new CronTime(overnightCron(nightly), zone).getNextDateFrom(now, zone).toUTC().toISO();
  } catch {
    // a schedule that never fires has no next start
  }
  return new Map(holding.map((name) => [name, resumesAt]));
};
