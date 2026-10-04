import { coalescedTask } from 'src/queue/coalesced-task.js';

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
