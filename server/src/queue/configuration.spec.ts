import { readQueueDeadlineProfiles } from 'src/queue/configuration.js';

describe('queue deadline profiles', () => {
  it('uses the agreed execution, inference, progress and cancellation defaults', () => {
    expect(readQueueDeadlineProfiles({})).toEqual({
      opaqueDeadline: 600_000,
      mlDeadline: 1_800_000,
      noProgressDeadline: 600_000,
      cancelGrace: 10_000,
    });
  });

  it('accepts explicit bounded millisecond settings independently', () => {
    expect(
      readQueueDeadlineProfiles({
        FRAMELEAF_JOB_DEADLINE_MS: '900000',
        FRAMELEAF_ML_DEADLINE_MS: '2400000',
        FRAMELEAF_JOB_IDLE_DEADLINE_MS: '1200000',
        FRAMELEAF_JOB_CANCEL_GRACE_MS: '20000',
      }),
    ).toEqual({ opaqueDeadline: 900_000, mlDeadline: 2_400_000, noProgressDeadline: 1_200_000, cancelGrace: 20_000 });
  });

  it.each(['', '0', '-1', '999', '1.5', 'Infinity', 'NaN', '1e6', '86400001', ' 1000 '])(
    'rejects invalid or unbounded values: %s',
    (value) => {
      for (const name of ['FRAMELEAF_JOB_DEADLINE_MS', 'FRAMELEAF_ML_DEADLINE_MS', 'FRAMELEAF_JOB_IDLE_DEADLINE_MS']) {
        expect(() => readQueueDeadlineProfiles({ [name]: value })).toThrow(name);
      }
    },
  );

  it('refuses cancellation grace long enough to outlive the claim safety window', () => {
    expect(() => readQueueDeadlineProfiles({ FRAMELEAF_JOB_CANCEL_GRACE_MS: '30001' })).toThrow(
      'FRAMELEAF_JOB_CANCEL_GRACE_MS',
    );
  });
});
