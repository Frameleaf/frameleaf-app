import { handleError } from '$lib/utils/handle-error';
import { InvocationTracker } from '$lib/utils/invocationTracker';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

describe('InvocationTracker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays inactive when an older invocation ends after the latest invocation', () => {
    const tracker = new InvocationTracker();
    const older = tracker.startInvocation();
    const latest = tracker.startInvocation();

    expect(older.isStillValid()).toBe(false);
    expect(latest.isStillValid()).toBe(true);
    latest.endInvocation();
    expect(tracker.isActive()).toBe(false);

    older.endInvocation();
    expect(tracker.isActive()).toBe(false);

    const next = tracker.startInvocation();
    expect(tracker.isActive()).toBe(true);
    next.endInvocation();
    expect(tracker.isActive()).toBe(false);
  });

  it('keeps the latest invocation active when an older invocation finishes first', () => {
    const tracker = new InvocationTracker();
    const older = tracker.startInvocation();
    const latest = tracker.startInvocation();

    older.endInvocation();
    expect(tracker.isActive()).toBe(true);
    latest.endInvocation();
    expect(tracker.isActive()).toBe(false);
  });

  it('returns results and ends invocations on success, synchronous throws and async failures', async () => {
    const tracker = new InvocationTracker();
    expect(await tracker.invoke(async () => 42, 'failed')).toBe(42);
    expect(tracker.isActive()).toBe(false);
    const error = new Error('failed');
    expect(
      await tracker.invoke(() => {
        throw error;
      }, 'sync'),
    ).toBeUndefined();
    expect(handleError).toHaveBeenLastCalledWith(error, 'sync');
    expect(tracker.isActive()).toBe(false);
    expect(
      await tracker.invoke(async () => {
        throw error;
      }, 'async'),
    ).toBeUndefined();
    expect(handleError).toHaveBeenLastCalledWith(error, 'async');
    expect(tracker.invocationsStarted).toBe(3);
    expect(tracker.invocationsEnded).toBe(3);
  });

  it('ends the invocation even if the error handler throws', async () => {
    const tracker = new InvocationTracker();
    const error = new Error('handler failed');
    vi.mocked(handleError).mockImplementationOnce(() => {
      throw error;
    });
    await expect(
      tracker.invoke(async () => {
        throw new Error('task failed');
      }, 'failed'),
    ).rejects.toBe(error);
    expect(tracker.isActive()).toBe(false);
  });

  it('keeps completion monotonic across duplicate ends and a newer pending invocation', async () => {
    const tracker = new InvocationTracker();
    const old = tracker.startInvocation();
    let finish!: (value: number) => void;
    const pending = tracker.invoke(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      'failed',
    );
    old.endInvocation();
    old.endInvocation();
    expect(tracker.isActive()).toBe(true);
    expect(old.isStillValid()).toBe(false);
    finish(7);
    expect(await pending).toBe(7);
    old.endInvocation();
    expect(tracker.isActive()).toBe(false);
    expect(tracker.invocationsEnded).toBe(2);
  });
});
