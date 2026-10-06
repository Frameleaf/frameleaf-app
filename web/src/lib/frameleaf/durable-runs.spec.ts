import { type DurableRunningJobs, QueueName } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { isRunSettled, matchesRunFilter, settledItems } from '$lib/frameleaf/durable-runs';
import { buildRunningJobRows, durableRunRow, queueRow } from '$lib/frameleaf/running-jobs';

describe('durable run views', () => {
  it('uses selected items rather than multiple stages for progress', () => {
    const run = durableRun();
    expect(settledItems(run)).toBe(14_992);
    expect(durableRunRow(run)).toMatchObject({ total: 15_000, done: 14_992, percent: 99, live: true });
    expect(durableRunRow(durableRun({ enumerationDone: false })).percent).toBeNull();
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
