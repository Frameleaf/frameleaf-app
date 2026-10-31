import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

describe(CronRepository.name, () => {
  let registry: SchedulerRegistry;
  let repository: CronRepository;
  let jobs: CronJob[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    registry = new SchedulerRegistry();
    repository = new CronRepository(registry, { setContext: vi.fn() } as unknown as LoggingRepository);
    jobs = [];
    const add = registry.addCronJob.bind(registry);
    vi.spyOn(registry, 'addCronJob').mockImplementation((name, job) => {
      jobs.push(job);
      add(name, job);
    });
  });

  afterEach(() => {
    for (const job of jobs) {
      void job.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts registered jobs by default and preserves callback context', async () => {
    const onTick = vi.fn(function (this: CronJob) {
      expect(this).toBe(registry.getCronJob('scheduled'));
    });
    repository.create({ name: 'scheduled', expression: '* * * * * *', onTick });
    const job = registry.getCronJob('scheduled');
    expect(job.isActive).toBe(true);
    expect(job.unrefTimeout).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledOnce();
  });

  it('registers stopped jobs without creating a timer', async () => {
    const onTick = vi.fn();
    repository.create({ name: 'stopped', expression: '* * * * * *', start: false, onTick });
    expect(registry.getCronJob('stopped').isActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('stops rejected duplicate jobs while preserving the registered job', async () => {
    const firstTick = vi.fn();
    const rejectedTick = vi.fn();
    repository.create({ name: 'duplicate', expression: '* * * * * *', onTick: firstTick });
    expect(() => repository.create({ name: 'duplicate', expression: '* * * * * *', onTick: rejectedTick })).toThrow(
      'already exists',
    );
    expect(registry.getCronJobs().size).toBe(1);
    expect(registry.getCronJob('duplicate')).toBe(jobs[0]);
    expect(jobs[0].isActive).toBe(true);
    expect(jobs[1].isActive).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(firstTick).toHaveBeenCalledTimes(2);
    expect(rejectedTick).not.toHaveBeenCalled();
  });

  it('stops a job on other registration errors and propagates the original error', async () => {
    const error = new Error('registration failed');
    const onTick = vi.fn();
    vi.mocked(registry.addCronJob).mockImplementation((name, job) => {
      jobs.push(job);
      throw error;
    });
    expect(() => repository.create({ name: 'rejected', expression: '* * * * * *', onTick })).toThrow(error);
    expect(jobs[0].isActive).toBe(false);
    expect(registry.getCronJobs().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('rejects invalid expressions without registering or scheduling', () => {
    expect(() => repository.create({ name: 'invalid', expression: 'invalid', onTick: vi.fn() })).toThrow();
    expect(registry.getCronJobs().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves start and stop updates', async () => {
    const onTick = vi.fn();
    repository.create({ name: 'updated', expression: '* * * * * *', onTick, start: false });
    repository.update({ name: 'updated', start: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledOnce();
    repository.update({ name: 'updated', start: false });
    expect(registry.getCronJob('updated').isActive).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledOnce();
  });

  it('reschedules active jobs and leaves stopped jobs stopped', async () => {
    const onTick = vi.fn();
    repository.create({ name: 'updated', expression: '* * * * * *', onTick });
    repository.update({ name: 'updated', expression: '*/2 * * * * *' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledOnce();
    repository.update({ name: 'updated', start: false });
    repository.update({ name: 'updated', expression: '* * * * * *' });
    expect(registry.getCronJob('updated').isActive).toBe(false);
  });

  it('preserves a running job when a replacement expression is invalid', async () => {
    const onTick = vi.fn();
    repository.create({ name: 'updated', expression: '* * * * * *', onTick });
    expect(() => repository.update({ name: 'updated', expression: 'invalid', start: false })).toThrow();
    expect(registry.getCronJob('updated').isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledOnce();
  });

  describe('time zone (FL-426)', () => {
    const logger = () => ({ setContext: vi.fn(), log: vi.fn() }) as unknown as LoggingRepository;
    const nextRun = (name: string) => registry.getCronJob(name).nextDate().toUTC().toISO();

    it('runs new and rescheduled jobs in the chosen time zone', () => {
      repository = new CronRepository(registry, logger());
      repository.setTimeZone('America/Edmonton');
      repository.create({ name: 'nightly', expression: '0 0 2 * * *', onTick: vi.fn() });
      // 02:00 in Edmonton in January (UTC−07:00)
      expect(nextRun('nightly')).toBe('2026-01-01T09:00:00.000Z');

      repository.update({ name: 'nightly', expression: '0 30 3 * * *' });
      expect(nextRun('nightly')).toBe('2026-01-01T10:30:00.000Z');
    });

    it('moves existing jobs to a new time zone, keeping each running or stopped', () => {
      repository = new CronRepository(registry, logger());
      repository.create({ name: 'nightly', expression: '0 0 2 * * *', onTick: vi.fn() });
      repository.create({ name: 'paused', expression: '0 0 4 * * *', onTick: vi.fn(), start: false });

      repository.setTimeZone('Europe/London');
      expect(nextRun('nightly')).toBe('2026-01-01T02:00:00.000Z');
      expect(registry.getCronJob('nightly').isActive).toBe(true);
      expect(registry.getCronJob('paused').isActive).toBe(false);
      expect(registry.getCronJob('paused').cronTime.timeZone).toBe('Europe/London');

      repository.setTimeZone('Asia/Tokyo');
      // 02:00 in Tokyo is 17:00 UTC the day before; the next one is that evening
      expect(nextRun('nightly')).toBe('2026-01-01T17:00:00.000Z');
    });

    it("goes back to the computer's own clock when the choice is emptied", () => {
      repository = new CronRepository(registry, logger());
      repository.setTimeZone('Asia/Tokyo');
      repository.create({ name: 'nightly', expression: '0 0 2 * * *', onTick: vi.fn() });
      repository.setTimeZone('');
      expect(registry.getCronJob('nightly').cronTime.timeZone).toBe(
        new Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    });
  });

  it('preserves missing-job errors and registry deletion cleanup', () => {
    expect(() => repository.update({ name: 'missing', start: true })).toThrow();
    repository.create({ name: 'deleted', expression: '* * * * * *', onTick: vi.fn() });
    registry.deleteCronJob('deleted');
    expect(jobs[0].isActive).toBe(false);
    expect(registry.getCronJobs().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
