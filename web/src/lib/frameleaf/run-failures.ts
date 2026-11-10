import {
  JobRunFailureCause,
  type DurableJobRun,
  type JobRunFailureCauseDto,
  type JobRunResponseDto,
} from '@frameleaf/sdk';
import {
  mdiAlertCircleOutline,
  mdiFileDocumentOutline,
  mdiHarddisk,
  mdiImageOutline,
  mdiImageSearchOutline,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { isRunSettled } from '$lib/frameleaf/durable-runs';

/** What a run's left-over photos come to by cause, most telling first (FL-1349). */
export type RunCauseCount = NonNullable<JobRunResponseDto['failureCauses']>[number];

/**
 * One cause in plain words and the one thing to do about it: try again (a drive, or something passing), open
 * Library care (it already looks after missing and damaged originals), or stop trying (a file that can't be read).
 */
export const CAUSE_VIEW: Record<
  JobRunFailureCause,
  {
    icon: string;
    tone: 'wait' | 'care' | 'quiet';
    title: Translations;
    body: Translations;
    action: 'retry' | 'care' | 'stop';
  }
> = {
  [JobRunFailureCause.Drive]: {
    icon: mdiHarddisk,
    tone: 'wait',
    title: 'frameleaf_job_runs_cause_drive_title',
    body: 'frameleaf_job_runs_cause_drive_body',
    action: 'retry',
  },
  [JobRunFailureCause.Missing]: {
    icon: mdiImageSearchOutline,
    tone: 'care',
    title: 'frameleaf_job_runs_cause_missing_title',
    body: 'frameleaf_job_runs_cause_missing_body',
    action: 'care',
  },
  [JobRunFailureCause.Damaged]: {
    icon: mdiImageOutline,
    tone: 'care',
    title: 'frameleaf_job_runs_cause_damaged_title',
    body: 'frameleaf_job_runs_cause_damaged_body',
    action: 'care',
  },
  [JobRunFailureCause.Unsupported]: {
    icon: mdiFileDocumentOutline,
    tone: 'quiet',
    title: 'frameleaf_job_runs_cause_unsupported_title',
    body: 'frameleaf_job_runs_cause_unsupported_body',
    action: 'stop',
  },
  [JobRunFailureCause.Other]: {
    icon: mdiAlertCircleOutline,
    tone: 'wait',
    title: 'frameleaf_job_runs_cause_other_title',
    body: 'frameleaf_job_runs_cause_other_body',
    action: 'retry',
  },
};

/**
 * The server kept this run's causes: always for work since FL-1349, never for a run summarised before it. Without
 * them there is nothing to review by cause, only the per-photo lists.
 */
export const knowsCauses = (run: DurableJobRun) => run.failureCauses !== undefined || run.leftOver !== undefined;

/** The run's left-over photos by cause, as the server counted them (stopped ones aside). */
export const runCauses = (run: DurableJobRun): RunCauseCount[] => run.failureCauses ?? [];

/**
 * How many photos need a look: the server's `leftOver`, which is the sum of the causes shown beside it, so the line
 * always adds up (live counts can run ahead of the run's own failed count). Without it, the causes are summed; a
 * finished run summarised before causes were kept has none, and falls back to its failed count; an unfinished run
 * without causes has nothing failed.
 */
export const leftOver = (run: DurableJobRun) =>
  run.leftOver ??
  (run.failureCauses
    ? run.failureCauses.reduce((sum, { count }) => sum + count, 0)
    : isRunSettled(run)
      ? run.failed + run.needsAttention
      : 0);

/** A cause's sentence in the review sheet: the drive by name, and what Library care already repaired. */
export const causeBody = (
  group: JobRunFailureCauseDto,
): { key: Translations; values: Record<string, string | number> } => {
  if (group.cause === JobRunFailureCause.Drive && group.libraries.length === 1) {
    return { key: 'frameleaf_job_runs_cause_drive_body_named', values: { name: group.libraries[0] } };
  }
  if (group.cause === JobRunFailureCause.Drive && group.libraries.length > 1) {
    return { key: 'frameleaf_job_runs_cause_drive_body_libraries', values: { names: group.libraries.join(', ') } };
  }
  if (group.cause === JobRunFailureCause.Damaged && group.repaired > 0) {
    return { key: 'frameleaf_job_runs_cause_damaged_body_repaired', values: { count: group.repaired } };
  }
  return { key: CAUSE_VIEW[group.cause].body, values: {} };
};
