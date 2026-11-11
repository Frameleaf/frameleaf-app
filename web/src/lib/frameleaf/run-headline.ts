import type { DurableJobReason, DurableJobRun } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { isRunSettled, runStateKey } from '$lib/frameleaf/durable-runs';
import { leftOver } from '$lib/frameleaf/run-failures';

/** The kit Pill's tones (`Pill.svelte` `KitTone`; plain tsc can't read a type out of a .svelte module). */
type KitTone = 'good' | 'warn' | 'bad' | 'off';

/**
 * A run's one state and its one reason (FL-1349): the status pill, its tone, the sentence under it (or none), and
 * the one thing to do from the card. `values` fill the sentence.
 */
export type Headline = {
  status: Translations;
  tone: KitTone;
  why: Translations | null;
  values?: Record<string, string | number>;
  /** Resume its paused steps, release its held setup, or (paused where the card can't resume it) the task list. */
  action: 'resume' | 'release' | 'tasks' | null;
};

const ML_WAITS: readonly DurableJobReason[] = [
  'dependency_unavailable',
  'destination-unavailable',
  'destination-configuration',
  'destination-consent',
  'destination-budget',
  'local-capacity',
];

/** Any of the run's remaining work is paused: it waits on Resume, whatever else is still going. */
const isPaused = (run: DurableJobRun) =>
  run.state === 'paused' ||
  run.reasons.includes('queue_paused') ||
  (run.pausedQueues?.length ?? 0) > 0 ||
  run.stageTotals.paused > 0;

/**
 * The single state, in this order: settled (stopped, needs attention, left over or finished), paused, waiting for a drive, held
 * for setup, machine learning off, waiting on machine learning, the night window, not started yet, and running.
 */
export const runHeadline = (run: DurableJobRun): Headline => {
  const has = (reason: DurableJobReason) => run.reasons.includes(reason);
  const photos = run.countsPhotos !== false;

  if (isRunSettled(run)) {
    const streak = run.leftOverStreak && run.leftOverStreak.nights >= 2 ? run.leftOverStreak : undefined;
    const why = streak
      ? {
          why: (streak.capped ? 'frameleaf_job_runs_streak_capped' : 'frameleaf_job_runs_streak') as Translations,
          values: { count: streak.photos, nights: streak.nights },
        }
      : { why: null };
    // A stopped run, or one that needs attention, says so first; its left-over photos still show beneath.
    if (run.state === 'cancelled') {
      return { status: 'frameleaf_job_runs_status_stopped', tone: 'off', why: null, action: null };
    }
    if (run.state === 'needs_attention') {
      return {
        status: 'frameleaf_job_runs_state_needs_attention',
        tone: 'warn',
        why: 'frameleaf_job_runs_why_needs_attention',
        action: null,
      };
    }
    if (leftOver(run) > 0) {
      return {
        status: photos ? 'frameleaf_job_runs_status_left_over' : 'frameleaf_job_runs_status_left_over_tasks',
        tone: 'warn',
        ...why,
        action: null,
      };
    }
    return { status: 'frameleaf_job_runs_status_finished', tone: 'good', why: null, action: null };
  }

  if (isPaused(run)) {
    const paused = { status: 'frameleaf_job_runs_state_paused' as Translations, tone: 'warn' as const };
    if ((run.pausedQueues?.length ?? 0) > 0) {
      return { ...paused, why: 'frameleaf_job_runs_why_paused', action: 'resume' };
    }
    return run.canRelease
      ? { ...paused, why: 'frameleaf_job_runs_why_paused_hold', action: 'release' }
      : { ...paused, why: 'frameleaf_job_runs_why_paused_elsewhere', action: 'tasks' };
  }

  if (has('source-unavailable')) {
    const name = run.unreachableLibraries?.[0];
    return name
      ? {
          status: 'frameleaf_job_runs_status_waiting_drive',
          tone: 'warn',
          why: 'frameleaf_job_runs_why_drive',
          values: { name },
          action: null,
        }
      : {
          status: 'frameleaf_job_runs_state_waiting',
          tone: 'warn',
          why: 'frameleaf_job_runs_why_source',
          action: null,
        };
  }

  if (has('first_setup_pending') || (run.held ?? 0) > 0) {
    const action = run.canRelease ? 'release' : null;
    return (run.held ?? 0) > 0
      ? {
          status: 'frameleaf_job_runs_status_waiting_setup',
          tone: 'warn',
          why: photos ? 'frameleaf_job_runs_why_setup_photos' : 'frameleaf_job_runs_why_setup_tasks',
          values: { count: run.held ?? 0 },
          action,
        }
      : {
          status: 'frameleaf_job_runs_status_waiting_setup',
          tone: 'warn',
          why: 'frameleaf_job_runs_why_setup',
          action,
        };
  }

  if (has('workload-disabled')) {
    return {
      status: 'frameleaf_job_runs_status_ml_off',
      tone: 'off',
      why: 'frameleaf_job_runs_why_ml_off',
      action: null,
    };
  }
  if (ML_WAITS.some((reason) => has(reason))) {
    return {
      status: 'frameleaf_job_runs_status_waiting_ml',
      tone: 'warn',
      why: 'frameleaf_job_runs_why_ml',
      action: null,
    };
  }
  if (has('scheduled_delay')) {
    return {
      status: 'frameleaf_job_runs_state_delayed',
      tone: 'off',
      why: 'frameleaf_job_runs_why_night',
      action: null,
    };
  }
  if (run.state === 'unavailable' || has('worker_unavailable') || has('no_dispatch_backlog')) {
    return {
      status: 'frameleaf_job_runs_state_unavailable',
      tone: 'off',
      why: has('no_dispatch_backlog')
        ? 'frameleaf_job_runs_reason_no_dispatch_backlog'
        : has('worker_unavailable')
          ? 'frameleaf_job_runs_reason_worker_unavailable'
          : 'frameleaf_job_runs_why_not_started',
      action: null,
    };
  }

  if (has('dependency_wait')) {
    return { status: 'frameleaf_job_runs_state_blocked', tone: 'off', why: null, action: null };
  }
  if (has('retry_backoff')) {
    return {
      status: 'frameleaf_job_runs_state_retrying',
      tone: 'good',
      why: 'frameleaf_job_runs_why_retry',
      action: null,
    };
  }
  return {
    status: run.state === 'waiting' ? runStateKey(run.state) : 'frameleaf_job_runs_state_running',
    tone: 'good',
    // FL-1430: work still finding what to do says so, rather than standing at Running with nothing to show
    why: has('enumerating')
      ? run.kind === 'library_scan'
        ? 'frameleaf_job_runs_why_enumerating_scan'
        : 'frameleaf_job_runs_why_enumerating'
      : null,
    action: null,
  };
};
