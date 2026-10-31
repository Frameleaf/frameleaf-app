import { createObserverDelivery } from 'src/queue/observers.js';

describe('bounded observer delivery', () => {
  it('retains its reservation after timeout and delivers the remainder when a slow observer resolves', async () => {
    const deliver = createObserverDelivery({ maxInFlight: 1, budgetMs: 5, warningIntervalMs: 0 });
    const pending = Promise.withResolvers<void>();
    const remainder = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const release = await deliver.reserve(new AbortController().signal);
    await deliver([() => pending.promise, remainder], warn, release);
    const reserved = vi.fn();
    const next = deliver.reserve(new AbortController().signal).then((release) => {
      reserved();
      release();
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reserved).not.toHaveBeenCalled();
      expect(remainder).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      await next;
    }
    expect(remainder).toHaveBeenCalledOnce();
    expect(reserved).toHaveBeenCalledOnce();
  });

  it('backpressures the seventeenth delivery without skipping its callbacks', async () => {
    const deliver = createObserverDelivery();
    const pending = Promise.withResolvers<void>();
    const observe = vi.fn().mockImplementation(() => pending.promise);
    const warn = vi.fn();
    const deliveries = Array.from({ length: 17 }, async () => {
      const release = await deliver.reserve(new AbortController().signal);
      await deliver([observe], warn, release);
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observe).toHaveBeenCalledTimes(16);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await Promise.all(deliveries);
    }
    expect(observe).toHaveBeenCalledTimes(17);
  });

  it('contains rejected observers and warning failures without suppressing the remainder', async () => {
    const deliver = createObserverDelivery({ budgetMs: 50 });
    const healthy = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn().mockImplementation(() => {
      throw new Error('logging offline');
    });
    const release = await deliver.reserve(new AbortController().signal);
    await expect(
      deliver([() => Promise.reject(new Error('offline')), healthy], warn, release),
    ).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});
