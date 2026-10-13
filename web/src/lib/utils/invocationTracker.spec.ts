import { InvocationTracker } from '$lib/utils/invocationTracker';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

describe('InvocationTracker', () => {
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
});
