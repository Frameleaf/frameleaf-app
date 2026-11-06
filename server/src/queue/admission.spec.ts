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

  it('shares budgets per database', () => {
    const db = {};
    expect(queueAdmission(db)).toBe(queueAdmission(db));
    expect(queueAdmission({})).not.toBe(queueAdmission(db));
  });

  it('applies a new capacity at once', async () => {
    const admission = new QueueAdmission(1);
    const first = await admission.acquire(new AbortController().signal);
    let granted = false;
    const second = admission.acquire(new AbortController().signal).then((release) => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    admission.resize(2);
    const releaseSecond = await second;
    expect(granted).toBe(true);
    // Shrinking lets running work finish; the slot it frees is not handed on while over capacity.
    admission.resize(1);
    let third = false;
    const pending = admission.acquire(new AbortController().signal).then((release) => {
      third = true;
      return release;
    });
    first();
    await Promise.resolve();
    expect(third).toBe(false);
    releaseSecond();
    (await pending)();
    expect(third).toBe(true);
  });
});
