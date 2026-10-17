import { QueueAdmission, QueueAdmissionFull, queueAdmission } from 'src/queue/admission.js';
import { QUEUE_BATCH } from 'src/queue/types.js';

describe('queue admission', () => {
  it('removes cancelled waiters and admits remaining work in arrival order', async () => {
    const admission = new QueueAdmission(1);
    const release = await admission.acquire(new AbortController().signal);
    const abort = new AbortController();
    const refused = expect(admission.acquire(abort.signal)).rejects.toThrow('cancelled');
    const order: number[] = [];
    const second = admission.run(new AbortController().signal, () => {
      order.push(2);
      return Promise.resolve();
    });
    const third = admission.run(new AbortController().signal, () => {
      order.push(3);
      return Promise.resolve();
    });
    abort.abort(new Error('cancelled'));
    await refused;
    expect(order).toEqual([]);
    release();
    release(); // a duplicate release must not admit a second owner
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
  });

  it('returns a grant cancelled before its continuation without executing work', async () => {
    const admission = new QueueAdmission(1);
    const release = await admission.acquire(new AbortController().signal);
    const abort = new AbortController();
    let executed = false;
    const refused = expect(
      admission.run(abort.signal, () => {
        executed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow('cancelled');
    release();
    abort.abort(new Error('cancelled'));
    await refused;
    expect(executed).toBe(false);
    const next = await admission.acquire(new AbortController().signal);
    next();
  });

  it('bounds queued claims and reuses cancelled capacity without leaking permits', async () => {
    const admission = new QueueAdmission(1);
    const release = await admission.acquire(new AbortController().signal);
    const abort = new AbortController();
    const waiters = Array.from({ length: QUEUE_BATCH }, () =>
      expect(admission.acquire(abort.signal)).rejects.toThrow('cancelled'),
    );
    await expect(admission.acquire(new AbortController().signal)).rejects.toBeInstanceOf(QueueAdmissionFull);
    abort.abort(new Error('cancelled'));
    await Promise.all(waiters);
    const next = admission.acquire(new AbortController().signal);
    release();
    (await next)();
  });

  it('shares budgets per database and releases admission after an action throws', async () => {
    const db = {};
    const first = queueAdmission(db);
    const second = queueAdmission(db);
    const release = await first.publication.acquire(new AbortController().signal);
    let entered = false;
    const failed = expect(
      second.publication.run(new AbortController().signal, () => {
        entered = true;
        return Promise.reject(new Error('failed'));
      }),
    ).rejects.toThrow('failed');
    await Promise.resolve();
    expect(entered).toBe(false);
    // A separate execution database has its own capacity, not a process-global lock.
    const other = await queueAdmission({}).publication.acquire(new AbortController().signal);
    other();
    release();
    await failed;
    (await first.publication.acquire(new AbortController().signal))();
  });
});
