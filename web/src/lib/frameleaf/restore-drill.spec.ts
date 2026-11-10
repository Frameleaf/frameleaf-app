import { CloudBackupDrillResult, CloudBackupDrillStep } from '@frameleaf/sdk';
import { stepStates } from '$lib/frameleaf/restore-drill';

describe('restore drill steps (FL-900)', () => {
  it('shows a running drill as waiting, never as done', () => {
    expect(stepStates({ result: CloudBackupDrillResult.Running, failedStep: null }).map(({ state }) => state)).toEqual([
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
  });

  it('marks the failed step and what came after it', () => {
    expect(
      stepStates({ result: CloudBackupDrillResult.Failed, failedStep: CloudBackupDrillStep.Rebuild }).map(
        ({ state }) => state,
      ),
    ).toEqual(['done', 'done', 'failed', 'skipped']);
    expect(
      stepStates({ result: CloudBackupDrillResult.Passed, failedStep: null }).every(({ state }) => state === 'done'),
    ).toBe(true);
  });
});
