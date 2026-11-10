import { JobRunFailureCause, QueueName } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { runHeadline } from '$lib/frameleaf/run-headline';

const settled = { active: 0, failed: 0, needsAttention: 0, reasons: [] };

describe('one state and one reason per piece of work (FL-1349)', () => {
  it('running with a paused step reads Paused, with Resume, and only that', () => {
    const headline = runHeadline(
      durableRun({
        state: 'running',
        reasons: ['queue_paused', 'scheduled_delay'],
        pausedQueues: [QueueName.MetadataExtraction],
      }),
    );
    expect(headline).toEqual({
      status: 'frameleaf_job_runs_state_paused',
      tone: 'warn',
      why: 'frameleaf_job_runs_why_paused',
      action: 'resume',
    });
  });
  it('a paused hold resumes by releasing it', () => {
    expect(runHeadline(durableRun({ state: 'paused', reasons: [], canRelease: true })).action).toBe('release');
    expect(runHeadline(durableRun({ state: 'paused', reasons: [] })).action).toBeNull();
  });
  it('a source-unavailable import reads Waiting for a drive with the library name', () => {
    const headline = runHeadline(
      durableRun({ state: 'blocked', reasons: ['source-unavailable'], unreachableLibraries: ['Archive', 'Old'] }),
    );
    expect(headline).toMatchObject({
      status: 'frameleaf_job_runs_status_waiting_drive',
      why: 'frameleaf_job_runs_why_drive',
      values: { name: 'Archive' },
      action: null,
    });
    // Without a library to name, it says what it can.
    expect(runHeadline(durableRun({ state: 'blocked', reasons: ['source-unavailable'] }))).toMatchObject({
      status: 'frameleaf_job_runs_state_waiting',
      why: 'frameleaf_job_runs_why_source',
    });
  });
  it('a finished run with failures reads Finished, with photos left over', () => {
    const run = durableRun({
      ...settled,
      state: 'completed_with_errors',
      failureCauses: [{ cause: JobRunFailureCause.Damaged, count: 3 }],
    });
    expect(runHeadline(run)).toEqual({
      status: 'frameleaf_job_runs_status_left_over',
      tone: 'warn',
      why: null,
      action: null,
    });
    expect(runHeadline(durableRun({ ...settled, state: 'completed' })).status).toBe(
      'frameleaf_job_runs_status_finished',
    );
    // Every left-over photo was stopped: nothing needs a look.
    expect(runHeadline(durableRun({ ...settled, state: 'completed_with_errors', failureCauses: [] })).status).toBe(
      'frameleaf_job_runs_status_finished',
    );
    expect(runHeadline(durableRun({ ...settled, state: 'cancelled' })).status).toBe(
      'frameleaf_job_runs_state_cancelled',
    );
  });
  it('a nightly run that leaves the same photos over two nights says so', () => {
    const run = durableRun({
      ...settled,
      state: 'completed_with_errors',
      failureCauses: [{ cause: JobRunFailureCause.Damaged, count: 863 }],
      leftOverStreak: { photos: 863, nights: 2 },
    });
    expect(runHeadline(run)).toMatchObject({
      why: 'frameleaf_job_runs_streak',
      values: { count: 863, nights: 2 },
    });
    expect(runHeadline({ ...run, leftOverStreak: { photos: 863, nights: 1 } }).why).toBeNull();
  });
  it('setup holds offer Release, and say how many photos wait', () => {
    expect(
      runHeadline(durableRun({ state: 'blocked', reasons: ['first_setup_pending'], held: 1200, canRelease: true })),
    ).toEqual({
      status: 'frameleaf_job_runs_status_waiting_setup',
      tone: 'warn',
      why: 'frameleaf_job_runs_why_setup_photos',
      values: { count: 1200 },
      action: 'release',
    });
  });
  it('exactly one why per state', () => {
    const cases = [
      [
        durableRun({ state: 'blocked', reasons: ['workload-disabled', 'local-capacity'] }),
        'frameleaf_job_runs_why_ml_off',
      ],
      [durableRun({ state: 'blocked', reasons: ['local-capacity', 'scheduled_delay'] }), 'frameleaf_job_runs_why_ml'],
      [durableRun({ state: 'delayed', reasons: ['scheduled_delay'] }), 'frameleaf_job_runs_why_night'],
      [durableRun({ state: 'unavailable', reasons: [] }), 'frameleaf_job_runs_why_not_started'],
      [
        durableRun({ state: 'running', reasons: ['no_dispatch_backlog'] }),
        'frameleaf_job_runs_reason_no_dispatch_backlog',
      ],
      [durableRun({ state: 'running', reasons: ['retry_backoff'] }), 'frameleaf_job_runs_why_retry'],
      [durableRun({ state: 'running', reasons: ['stage_failed'] }), null],
    ] as const;
    for (const [run, why] of cases) {
      const headline = runHeadline(run);
      expect(headline.why).toBe(why);
      expect(Object.keys(en)).toContain(headline.status);
    }
    expect(runHeadline(durableRun({ state: 'running', reasons: [] }))).toEqual({
      status: 'frameleaf_job_runs_state_running',
      tone: 'good',
      why: null,
      action: null,
    });
  });
  it('no wording says queue, job, checksum or SHA', () => {
    const words = Object.entries(en).filter(([key]) => key.startsWith('frameleaf_job_runs_'));
    expect(words.length).toBeGreaterThan(40);
    for (const [key, value] of words) {
      expect(`${key}: ${value}`).not.toMatch(/: .*(queue|\bjobs?\b|checksum|\bsha\b)/i);
    }
  });
});
