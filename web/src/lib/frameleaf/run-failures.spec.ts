import { JobRunFailureCause, type JobRunFailureCauseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { CAUSE_VIEW, causeBody, leftOver, runCauses } from '$lib/frameleaf/run-failures';

const group = (overrides: Partial<JobRunFailureCauseDto> = {}): JobRunFailureCauseDto => ({
  cause: JobRunFailureCause.Drive,
  count: 4,
  stopped: 0,
  repaired: 0,
  libraries: [],
  queues: [],
  message: null,
  samples: [],
  ...overrides,
});

describe('left-over photos by cause (FL-1349)', () => {
  it('counts what needs a look as the sum of the causes shown', () => {
    // Live counts can run ahead of the run's failed count: the line adds up to what it lists.
    const run = durableRun({
      failed: 2,
      needsAttention: 0,
      failureCauses: [
        { cause: JobRunFailureCause.Drive, count: 7 },
        { cause: JobRunFailureCause.Missing, count: 3 },
      ],
    });
    expect(leftOver(run)).toBe(10);
    expect(runCauses(run)).toHaveLength(2);
  });
  it('falls back to the failed count only for a finished run summarised before causes were kept', () => {
    expect(leftOver(durableRun({ state: 'completed_with_errors', failed: 5, needsAttention: 1 }))).toBe(6);
    expect(leftOver(durableRun({ state: 'running', failed: 5 }))).toBe(0);
    expect(leftOver(durableRun({ state: 'completed_with_errors', failed: 5, failureCauses: [] }))).toBe(0);
  });
  it('gives every cause one action that fits it', () => {
    expect(Object.fromEntries(Object.entries(CAUSE_VIEW).map(([cause, view]) => [cause, view.action]))).toEqual({
      drive: 'retry',
      missing: 'care',
      damaged: 'care',
      unsupported: 'stop',
      other: 'retry',
    });
    for (const view of Object.values(CAUSE_VIEW)) {
      expect(Object.keys(en)).toContain(view.title);
      expect(Object.keys(en)).toContain(view.body);
    }
  });
  it('names the drive and what Library care already repaired', () => {
    expect(causeBody(group({ libraries: ['Archive'] }))).toEqual({
      key: 'frameleaf_job_runs_cause_drive_body_named',
      values: { name: 'Archive' },
    });
    expect(causeBody(group())).toEqual({ key: 'frameleaf_job_runs_cause_drive_body', values: {} });
    expect(causeBody(group({ cause: JobRunFailureCause.Damaged, repaired: 598 }))).toEqual({
      key: 'frameleaf_job_runs_cause_damaged_body_repaired',
      values: { count: 598 },
    });
    expect(causeBody(group({ cause: JobRunFailureCause.Damaged }))).toEqual({
      key: 'frameleaf_job_runs_cause_damaged_body',
      values: {},
    });
  });
});
