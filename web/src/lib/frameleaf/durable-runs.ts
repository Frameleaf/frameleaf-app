import type { DurableJobCounts, DurableJobRun, DurableJobState, DurableJobReason } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityFilter, ActivityTone } from '$lib/frameleaf/activity';

export const runStateKey = (state: DurableJobState): Translations =>
  `frameleaf_job_runs_state_${state}` as Translations;
export const runReasonKey = (reason: DurableJobReason): Translations =>
  `frameleaf_job_runs_reason_${reason}` as Translations;
/** FL-1177: a Frameleaf Manager import's run. It has no queue of its own: its work runs on the queues it feeds. */
export const isImportRunKind = (kind: string) => kind === 'immich-import-derived' || kind === 'library-import-derived';
/** What a run is called: its queue's name, a Manager import, a folder scan, or plain server processing. */
export const runTitleKey = (kind: string, queueKey: string | undefined, fallback: Translations): Translations =>
  queueKey
    ? (`frameleaf_jobs_queue_${queueKey}` as Translations)
    : isImportRunKind(kind)
      ? 'frameleaf_job_runs_kind_import'
      : kind === 'library_scan'
        ? 'frameleaf_job_runs_kind_library_scan'
        : fallback;
/** A run needs attention only when its library scan failed or was cancelled: nothing more will run in it (FL-588). */
export const isRunSettled = (run: Pick<DurableJobRun, 'state'>) =>
  ['completed', 'completed_with_errors', 'cancelled', 'needs_attention'].includes(run.state);
export const settledItems = (counts: DurableJobCounts) =>
  counts.completed + counts.failed + counts.needsAttention + counts.cancelled;
/** Photos (or tasks) that failed or need a look. */
export const failedItems = (run: DurableJobRun) => run.failed + run.needsAttention;
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
  (filter === 'done' && isRunSettled(run) && !['completed_with_errors', 'needs_attention'].includes(run.state)) ||
  (filter === 'failed' && run.state === 'needs_attention') ||
  (filter === 'failed' &&
    run.failed +
      run.needsAttention +
      run.stageTotals.failed +
      run.stageTotals.needsAttention +
      run.stageTotals.blocked >
      0);
