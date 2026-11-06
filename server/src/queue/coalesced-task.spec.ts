import { coalescedTask, costReusedRead } from 'src/queue/coalesced-task.js';

describe('coalesced queue ticks', () => {
  it('remembers a settlement received during a running tick without overlapping dispatch', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    let visits = 0;
    let active = 0;
    let maximumActive = 0;
    const request = coalescedTask(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      visits++;
      if (visits === 1) await first;
      active--;
    });
    const pending = request();
    void request();
    void request();
    release();
    await pending;
    expect(visits).toBe(2);
    expect(maximumActive).toBe(1);
    await request();
    expect(visits).toBe(3);
  });

  it('stops after useful work and can run again after a failed visit', async () => {
    let visits = 0;
    const request = coalescedTask(() =>
      ++visits === 1 ? Promise.reject(new Error('database unavailable')) : Promise.resolve(),
    );
    await expect(request()).rejects.toThrow('database unavailable');
    await request();
    expect(visits).toBe(2);
    await Promise.resolve();
    expect(visits).toBe(2);
  });
});

describe('cost-reused reads', () => {
  it('shares a read in flight, reuses it for ten times its cost, then reads again', async () => {
    let clock = 0;
    let release!: (value: string) => void;
    const load = vi.fn((key: { take: number }) =>
      key.take === 25 && load.mock.calls.length === 1
        ? new Promise<string>((resolve) => (release = resolve))
        : Promise.resolve('fresh'),
    );
    const read = costReusedRead(load, { now: () => clock });

    const first = read({ take: 25 });
    const second = read({ take: 25 });
    clock = 12_000; // the recount took 12 s
    release('counted');
    await expect(first).resolves.toBe('counted');
    await expect(second).resolves.toBe('counted');
    expect(load).toHaveBeenCalledTimes(1);

    clock = 12_000 + 119_000; // still inside 10 × 12 s
    await expect(read({ take: 25 })).resolves.toBe('counted');
    expect(load).toHaveBeenCalledTimes(1);

    clock = 12_000 + 120_000;
    await expect(read({ take: 25 })).resolves.toBe('fresh');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps reads for different keys apart and never reuses a failed read', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('lock timeout')).mockResolvedValue('ok');
    const read = costReusedRead(load, { now: () => 0 });
    await expect(read({ take: 25, skip: 0 })).rejects.toThrow('lock timeout');
    await expect(read({ take: 25, skip: 0 })).resolves.toBe('ok');
    await expect(read({ take: 25, skip: 25 })).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('forgets every reuse on clear, including a read still in flight', async () => {
    let clock = 0;
    let release!: (value: string) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)))
      .mockResolvedValue('after the change');
    const read = costReusedRead(load, { now: () => clock });
    const inFlight = read({ take: 25 });
    read.clear(); // a cancel lands while the slow count is running
    clock = 12_000;
    release('before the change');
    await expect(inFlight).resolves.toBe('before the change');
    await expect(read({ take: 25 })).resolves.toBe('after the change');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never reuses a cheap read, so a change made just before shows at once', async () => {
    let clock = 0;
    const load = vi.fn(() => {
      clock += 20;
      return Promise.resolve(clock);
    });
    const read = costReusedRead(load, { now: () => clock });
    await expect(read({})).resolves.toBe(20);
    await expect(read({})).resolves.toBe(40);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
