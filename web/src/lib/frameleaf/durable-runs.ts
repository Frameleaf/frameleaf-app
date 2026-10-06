import type {
  DurableJobCounts,
  DurableJobRun,
  DurableJobState,
  DurableJobOutcome,
  DurableJobReason,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityFilter, ActivityTone } from '$lib/frameleaf/activity';

export const DURABLE_OUTCOMES: readonly DurableJobOutcome[] = [
  'completed',
  'failed',
  'needsAttention',
  'cancelled',
  'active',
  'retrying',
  'delayed',
  'paused',
  'waiting',
  'blocked',
];
export const runStateKey = (state: DurableJobState): Translations =>
  `frameleaf_job_runs_state_${state}` as Translations;
export const runOutcomeKey = (state: DurableJobOutcome): Translations =>
  `frameleaf_job_runs_outcome_${state === 'needsAttention' ? 'needs_attention' : state}` as Translations;
export const runReasonKey = (reason: DurableJobReason): Translations =>
  `frameleaf_job_runs_reason_${reason}` as Translations;
export const isRunSettled = (run: Pick<DurableJobRun, 'state'>) =>
  ['completed', 'completed_with_errors', 'cancelled'].includes(run.state);
export const settledItems = (counts: DurableJobCounts) =>
  counts.completed + counts.failed + counts.needsAttention + counts.cancelled;
export const runTone = (state: DurableJobState): ActivityTone =>
  state === 'completed'
    ? 'success'
    : ['completed_with_errors', 'needs_attention', 'blocked', 'paused', 'unavailable'].includes(state)
      ? 'warning'
      : ['running', 'retrying'].includes(state)
        ? 'info'
        : 'neutral';
export const matchesRunFilter = (run: DurableJobRun, filter: ActivityFilter) =>
  filter === 'all' ||
  (filter === 'running' && !isRunSettled(run)) ||
  (filter === 'done' && isRunSettled(run) && run.state !== 'completed_with_errors') ||
  (filter === 'failed' &&
    run.failed +
      run.needsAttention +
      run.stageTotals.failed +
      run.stageTotals.needsAttention +
      run.stageTotals.blocked >
      0);
