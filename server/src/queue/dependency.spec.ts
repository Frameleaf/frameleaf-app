import type { QueueExecution } from 'src/queue/types.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobDependencyUnavailable, deferJobUntilDependency, noteAdmissionDependency } from 'src/queue/dependency.js';

const execution = (): QueueExecution => ({
  claim: {
    id: 'fixture',
    queue: 'fixture',
    name: 'fixture',
    data: {},
    token: 'fixture',
    workerId: 'fixture',
    attempt: 1,
    runId: null,
    itemKey: null,
    deadlineMs: 600_000,
    startedAt: new Date(),
    safeToRetry: true,
  },
  signal: new AbortController().signal,
  progress: vi.fn(),
  progressUnits: 0,
  adoptions: [],
  followups: [],
  buffering: false,
});
describe('queue dependency outcomes', () => {
  it('keeps non-queue callers unchanged', () => {
    expect(() => deferJobUntilDependency('workload-disabled')).not.toThrow();
  });
  it('retains a disabled selected workload instead of skipping it', () => {
    const context = execution();
    expect(() => queueExecution.run(context, () => deferJobUntilDependency('workload-disabled'))).toThrow(
      JobDependencyUnavailable,
    );
    expect(context.dependencyReason).toBe('workload-disabled');
  });
  it.each([
    [MlAdmissionRefusal.ConsentMissing, 'destination-consent'],
    [MlAdmissionRefusal.WalletInsufficient, 'destination-budget'],
    [MlAdmissionRefusal.DestinationUnhealthy, 'destination-unavailable'],
    [MlAdmissionRefusal.WorkloadNotRouted, 'destination-configuration'],
  ])('records the safe reason for %s', (refusal, reason) => {
    const context = execution();
    queueExecution.run(context, () => noteAdmissionDependency(refusal as MlAdmissionRefusal));
    expect(context.dependencyReason).toBe(reason);
  });
  it('does not replay invalid requests or operation-owned/unsafe effects', () => {
    for (const kind of ['invalid', 'operation', 'unsafe']) {
      const context = execution();
      if (kind === 'operation') context.claim.data.operationId = 'operation';
      else if (kind === 'unsafe') context.claim.safeToRetry = false;
      queueExecution.run(context, () =>
        noteAdmissionDependency(
          kind === 'invalid' ? MlAdmissionRefusal.RequestInvalid : MlAdmissionRefusal.CloudUnavailable,
        ),
      );
      expect(context.dependencyReason).toBeUndefined();
    }
  });
});
