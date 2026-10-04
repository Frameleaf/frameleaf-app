import { QUEUE_TIMING } from 'src/queue/types.js';
import { QueueWatchdog } from 'src/queue/watchdog.js';

describe('independent queue watchdog', () => {
  it('cancels an opaque hung worker at ten minutes and forces termination after ten seconds', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('hang', 0, QUEUE_TIMING.opaqueDeadline);
    expect(watchdog.inspect(599_999, 599_999)).toEqual({ cancel: [], terminate: false });
    expect(watchdog.inspect(600_000, 600_000)).toEqual({ cancel: ['hang'], terminate: false });
    expect(watchdog.inspect(610_000, 610_000).terminate).toBe(true);
  });

  it('allows ML response bodies thirty minutes, with no header-based deadline reset', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('ml', 0, QUEUE_TIMING.mlDeadline);
    expect(watchdog.inspect(1_799_999, 1_799_999).cancel).toEqual([]);
    expect(watchdog.inspect(1_800_000, 1_800_000).cancel).toEqual(['ml']);
  });

  it('does not mistake repeated progress or heartbeats for new FFmpeg frames', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('ffmpeg', 0, QUEUE_TIMING.opaqueDeadline);
    watchdog.progress('ffmpeg', 100, 1000);
    watchdog.progress('ffmpeg', 100, 590_000);
    expect(watchdog.inspect(601_000, 601_000).cancel).toEqual(['ffmpeg']);
  });

  it('keeps genuinely advancing streaming work alive beyond its initial deadline', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('healthy', 0, QUEUE_TIMING.opaqueDeadline);
    for (let minute = 1; minute <= 120; minute++) {
      const now = minute * 60_000;
      watchdog.progress('healthy', minute * 100, now);
      expect(watchdog.inspect(now, now).cancel).toEqual([]);
    }
  });

  it.each(['PostgreSQL outage', 'pool pressure'])('bounds cancellation during %s before lease can be replayed', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('job', 0, QUEUE_TIMING.opaqueDeadline);
    expect(watchdog.inspect(49_999, 0).cancel).toEqual([]);
    expect(watchdog.inspect(50_000, 0).cancel).toEqual(['job']);
    expect(watchdog.inspect(60_000, 0).terminate).toBe(true);
  });

  it('does not terminate the worker after a cancelled handler acknowledges completion', () => {
    const watchdog = new QueueWatchdog();
    watchdog.add('job', 0, QUEUE_TIMING.opaqueDeadline);
    watchdog.inspect(600_000, 600_000);
    watchdog.remove('job');
    expect(watchdog.inspect(610_000, 610_000)).toEqual({ cancel: [], terminate: false });
  });
});
