import { PendingEvents } from 'src/utils/event.js';

describe(PendingEvents.name, () => {
  let events: PendingEvents<'HlsSegmentResult'>;
  const result = { sessionId: 'session', variantIndex: 0, segmentIndex: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    events = new PendingEvents({ timeoutMs: 100 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shares one promise and deadline for concurrent waits on the same key', async () => {
    const waits = Array.from({ length: 1000 }, () => events.wait('segment'));
    expect(new Set(waits).size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    events.complete('segment', result);
    expect(await Promise.all(waits)).toEqual(Array.from({ length: 1000 }, () => result));
    expect(await waits[0]).toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const first = events.wait('first');
    const second = events.wait('second');
    expect(first).not.toBe(second);
    events.complete('first', result);
    expect(await first).toBe(result);
    expect(vi.getTimerCount()).toBe(1);
    const other = { ...result, segmentIndex: 2 };
    events.complete('second', other);
    expect(await second).toBe(other);
  });

  it('does not extend the original deadline when another waiter arrives', async () => {
    const first = events.wait('segment');
    const rejection = expect(first).rejects.toThrow('Request timed out');
    await vi.advanceTimersByTimeAsync(99);
    const second = events.wait('segment');
    const secondRejection = expect(second).rejects.toThrow('Request timed out');
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([rejection, secondRejection]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh deadline after completion without retaining the previous timer', async () => {
    const first = events.wait('segment');
    await vi.advanceTimersByTimeAsync(90);
    events.complete('segment', result);
    expect(await first).toBe(result);
    const next = events.wait('segment');
    expect(next).not.toBe(first);
    await vi.advanceTimersByTimeAsync(99);
    expect(vi.getTimerCount()).toBe(1);
    events.complete('segment', result);
    expect(await next).toBe(result);
  });

  it.each(['worker failed', '', undefined])(
    'rejects every waiter when the error field is present: %s',
    async (error) => {
      const first = events.wait('segment');
      const second = events.wait('segment');
      const failures = Promise.all([
        first.catch((error_: unknown) => error_),
        second.catch((error_: unknown) => error_),
      ]);
      events.complete('segment', { ...result, error });
      const [a, b] = await failures;
      expect(a).toBeInstanceOf(Error);
      expect(a).toBe(b);
      expect((a as Error).message).toBe(error ?? '');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('rejects matching prefixes and preserves unrelated waits', async () => {
    const first = events.wait('session:0:1').catch((error: unknown) => error);
    const second = events.wait('session:0:2').catch((error: unknown) => error);
    const other = events.wait('session:1:1');
    const similar = events.wait('session-other:0:1');
    events.rejectByPrefix('session:0:', 'Variant changed');
    expect(((await first) as Error).message).toBe('Variant changed');
    expect(((await second) as Error).message).toBe('Variant changed');
    expect(vi.getTimerCount()).toBe(2);
    events.complete('session:1:1', result);
    events.complete('session-other:0:1', result);
    expect(await other).toBe(result);
    expect(await similar).toBe(result);
  });

  it('ignores unknown or repeated completion and does not replay completed results', async () => {
    events.complete('segment', result);
    const first = events.wait('segment');
    expect(vi.getTimerCount()).toBe(1);
    events.complete('segment', result);
    events.complete('segment', { error: 'late failure' });
    expect(await first).toBe(result);
    const next = events.wait('segment');
    expect(next).not.toBe(first);
    events.complete('segment', result);
    expect(await next).toBe(result);
  });

  it('allows a result continuation to begin a fresh wait on the same key', async () => {
    const first = events.wait('segment');
    let next: Promise<typeof result> | undefined;
    const continuation = first.then(() => {
      next = events.wait('segment');
    });
    events.complete('segment', result);
    await continuation;
    expect(next).not.toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    events.complete('segment', result);
    expect(await next).toBe(result);
  });
});
