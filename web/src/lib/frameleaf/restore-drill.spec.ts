import { stepStates } from '$lib/frameleaf/restore-drill';

describe('restore drill steps (FL-900)', () => {
  it('shows a running drill as waiting, never as done', () => {
    expect(stepStates({ result: 'running', failedStep: null }).map(({ state }) => state)).toEqual([
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
  });

  it('marks the failed step and what came after it', () => {
    expect(stepStates({ result: 'failed', failedStep: 'rebuild' }).map(({ state }) => state)).toEqual([
      'done',
      'done',
      'failed',
      'skipped',
    ]);
    expect(stepStates({ result: 'passed', failedStep: null }).every(({ state }) => state === 'done')).toBe(true);
  });
});
