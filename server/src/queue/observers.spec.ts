import { createObserverDelivery } from 'src/queue/observers.js';

describe('bounded observer delivery', () => {
  it('releases the executor budget while a hung observer retains the separate allowance', async () => {
    const deliver = createObserverDelivery({ maxInFlight: 1, budgetMs: 5, warningIntervalMs: 0 });
    const { promise: hung, resolve: release } = Promise.withResolvers<void>();
    const skipped = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    await deliver([() => hung], warn);
    await deliver([skipped], warn);
    expect(skipped).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    release();
    await hung;
    // Let the delivery's finally release its allowance.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await deliver([skipped], warn);
    expect(skipped).toHaveBeenCalledOnce();
  });
  it('contains a rejected observer without spending execution retries or suppressing healthy nudges', async () => {
    const deliver = createObserverDelivery({ budgetMs: 50 });
    const healthy = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    await expect(deliver([() => Promise.reject(new Error('offline')), healthy], warn)).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});
