import { type DurableRunningJobs, QueueName } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import {
  isRunSettled,
  matchesRunFilter,
  runBlockers,
  runFailedQueues,
  settledItems,
} from '$lib/frameleaf/durable-runs';
import { buildRunningJobRows, durableRunRow, queueRow } from '$lib/frameleaf/running-jobs';

describe('durable run views', () => {
  it('counts photos once rather than each of their tasks for progress', () => {
    const run = durableRun();
    expect(settledItems(run)).toBe(14_992);
    expect(durableRunRow(run)).toMatchObject({ total: 15_000, done: 14_992, percent: 99, live: true });
    expect(durableRunRow(durableRun({ enumerationDone: false })).percent).toBeNull();
  });
  it('says what holds a run up in plain words, and nothing once it has finished (FL-1265)', () => {
    expect(runBlockers(durableRun({ state: 'paused', reasons: [] }))).toEqual(['frameleaf_job_runs_why_paused']);
    expect(runBlockers(durableRun({ state: 'blocked', reasons: ['first_setup_pending'] }))).toEqual([
      'frameleaf_job_runs_why_setup',
    ]);
    expect(runBlockers(durableRun({ state: 'blocked', reasons: [], held: 3 }))).toEqual([
      'frameleaf_job_runs_why_setup',
    ]);
    expect(runBlockers(durableRun({ state: 'delayed', reasons: ['scheduled_delay', 'local-capacity'] }))).toEqual([
      'frameleaf_job_runs_why_night',
      'frameleaf_job_runs_why_ml',
    ]);
    expect(runBlockers(durableRun({ state: 'completed', reasons: ['queue_paused'] }))).toEqual([]);
  });
  it('links failures to the queues the server names, else to the run’s own queue', () => {
    expect(
      runFailedQueues(durableRun({ failedQueues: [QueueName.FaceDetection] }), QueueName.ThumbnailGeneration),
    ).toEqual([QueueName.FaceDetection]);
    expect(runFailedQueues(durableRun(), QueueName.ThumbnailGeneration)).toEqual([QueueName.ThumbnailGeneration]);
    expect(runFailedQueues(durableRun(), undefined)).toEqual([]);
  });
  it('shows partial failures on the failed filter without treating active work as settled', () => {
    const run = durableRun();
    expect(isRunSettled(run)).toBe(false);
    expect(matchesRunFilter(run, 'running')).toBe(true);
    expect(matchesRunFilter(run, 'failed')).toBe(true);
    expect(matchesRunFilter(run, 'done')).toBe(false);
  });
  it.each(['paused', 'delayed', 'retrying', 'blocked', 'unavailable'] as const)('keeps %s runs unfinished', (state) => {
    const run = durableRun({ state });
    expect(isRunSettled(run)).toBe(false);
    expect(matchesRunFilter(run, 'running')).toBe(true);
    expect(durableRunRow(run).paused).toBe(state === 'paused');
  });
  it('settles a library scan that needs attention and files it under failed (FL-588)', () => {
    const run = durableRun({ state: 'needs_attention', enumerationDone: false, active: 0, failed: 0 });
    expect(isRunSettled(run)).toBe(true);
    expect(matchesRunFilter(run, 'running')).toBe(false);
    expect(matchesRunFilter(run, 'done')).toBe(false);
    expect(matchesRunFilter(run, 'failed')).toBe(true);
  });
  it('shows completed with errors as settled failure rather than a clean completed run', () => {
    const run = durableRun({ state: 'completed_with_errors', active: 0, failed: 9 });
    expect(isRunSettled(run)).toBe(true);
    expect(matchesRunFilter(run, 'failed')).toBe(true);
    expect(matchesRunFilter(run, 'running')).toBe(false);
    expect(matchesRunFilter(run, 'done')).toBe(false);
  });
  it('does not display operational runs when the server withholds JobRead authority', () => {
    const summary: DurableRunningJobs = {
      operations: [],
      memoryExports: [],
      queues: [],
      canManageQueues: true,
      canReadJobRuns: false,
      durableRuns: [durableRun()],
    };
    expect(buildRunningJobRows(summary)).toEqual([]);
    expect(buildRunningJobRows({ ...summary, canReadJobRuns: true })).toHaveLength(1);
  });
  it('keeps an explicit unavailable queue indeterminate with a disabled control', () => {
    expect(
      queueRow({
        name: QueueName.Ocr,
        isPaused: false,
        canPause: false,
        active: 0,
        waiting: 0,
        processed: 0,
        total: 0,
        startedAt: null,
        unavailable: true,
        state: 'unavailable',
      }),
    ).toMatchObject({
      done: null,
      total: null,
      percent: null,
      statusKey: 'frameleaf_job_runs_state_unavailable',
      control: { kind: 'unavailable' },
    });
  });
});
