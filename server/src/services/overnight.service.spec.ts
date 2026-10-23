import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseLock, JobName, JobStatus, OvernightStepTiming, QueueName, SystemMetadataKey } from 'src/enum.js';
import { OvernightService } from 'src/services/overnight.service.js';
import {
  OVERNIGHT_NIGHTS_KEPT,
  type OvernightState,
  isStepDue,
  keepNight,
  overnightCron,
  overnightStopAt,
} from 'src/utils/overnight.js';

const counts = (active = 0, waiting = 0) => ({ active, waiting, delayed: 0, completed: 0, failed: 0, paused: 0 });

/** A server with one added folder, one iCloud Photos connection and the file checks on. */
const setup = (overrides: { stopTime?: string; steps?: Partial<Record<string, OvernightStepTiming>> } = {}) => {
  const stored: { state?: OvernightState } = {};
  let lockTail = Promise.resolve();
  const busy: Record<string, boolean> = {};
  const config = {
    server: { timeZone: 'UTC' },
    nightlyTasks: {
      startTime: '00:00',
      stopTime: overrides.stopTime ?? '',
      days: [0, 1, 2, 3, 4, 5, 6],
      weeklyDay: 0,
      databaseCleanup: true,
      emptyTrash: true,
      steps: {
        cleanup: OvernightStepTiming.Nightly,
        folders: OvernightStepTiming.Nightly,
        icloud: OvernightStepTiming.Nightly,
        fileChecks: OvernightStepTiming.Nightly,
        ...overrides.steps,
      },
    },
    library: { scan: { enabled: true } },
    trash: { enabled: true, days: 30 },
    integrityChecks: {
      untrackedFiles: { enabled: true },
      missingFiles: { enabled: true },
      checksumFiles: { enabled: true },
    },
    libraryCare: { integrityAudit: true, healthScan: true },
  };
  const mocks = {
    logger: { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() },
    config: { getEnv: () => ({ configFile: 'test' }) },
    metadata: {
      get: vi.fn((key: SystemMetadataKey) =>
        Promise.resolve(key === SystemMetadataKey.OvernightSequence ? stored.state : undefined),
      ),
      set: vi.fn((_key: SystemMetadataKey, value: OvernightState) => {
        stored.state = value;
        return Promise.resolve();
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    database: {
      tryLock: vi.fn().mockResolvedValue(true),
      withLock: vi.fn((_lock: DatabaseLock, work: () => Promise<unknown>) => {
        const pending = lockTail.then(work);
        lockTail = pending.then(() => {}).catch(() => {});
        return pending;
      }),
    },
    job: {
      queue: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn((name: QueueName) =>
        Promise.resolve(
          name === QueueName.BackgroundTask ? counts(1, busy.cleanup ? 1 : 0) : counts(busy[name] ? 1 : 0),
        ),
      ),
    },
    library: { getAll: vi.fn().mockResolvedValue([{ id: 'library-1' }]) },
    icloud: {
      hasConnections: vi.fn().mockResolvedValue(true),
      overnightConnections: vi.fn().mockResolvedValue([{ id: 'connection-1', ownerId: 'user-1' }]),
      queueOperation: vi.fn().mockResolvedValue({}),
      hasActiveSync: vi.fn(() => Promise.resolve(!!busy.icloud)),
    },
    queue: { handleNightlyJobs: vi.fn().mockResolvedValue(undefined) },
    mediaHealth: { startScheduledScans: vi.fn().mockResolvedValue(1) },
    // 12 items past their keep time when the run starts, none left after the tidy-up; 214 came in
    trash: {
      countTrashedBefore: vi.fn().mockResolvedValueOnce(12).mockResolvedValue(0),
      countAddedSince: vi.fn().mockResolvedValue(214),
    },
  };
  const sut = new OvernightService(
    mocks.logger as never,
    mocks.config as never,
    mocks.metadata as never,
    mocks.database as never,
    mocks.job as never,
    mocks.library as never,
    mocks.icloud as never,
    mocks.queue as never,
    mocks.mediaHealth as never,
    mocks.trash as never,
  );
  (sut as unknown as { readConfig: () => Promise<unknown> }).readConfig = () => Promise.resolve(config);
  return { sut, mocks, stored, busy, config };
};

describe(OvernightService.name, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the four steps one after another and records the night', async () => {
    const { sut, mocks, stored } = setup();
    await expect(sut.handleStart()).resolves.toBe(JobStatus.Success);

    expect(mocks.queue.handleNightlyJobs).toHaveBeenCalledWith({ cleanup: true });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryScanQueueAll });
    expect(mocks.icloud.queueOperation).toHaveBeenCalledWith('connection-1', 'user-1', { trigger: 'schedule' });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.IntegrityChecksumFiles, data: {} });
    expect(mocks.mediaHealth.startScheduledScans).toHaveBeenCalled();
    expect(stored.state?.run).toBeNull();
    expect(stored.state?.nights[0].results).toEqual({
      cleanup: 'done',
      folders: 'done',
      icloud: 'done',
      fileChecks: 'done',
    });
    // FL-518: what the night removed from Trash and what came in while it ran
    expect(stored.state?.nights[0]).toMatchObject({ removedFromTrash: 12, newFiles: 214 });
  });

  it('still records the night when the counts cannot be read (FL-518)', async () => {
    const { sut, mocks, stored } = setup();
    mocks.trash.countTrashedBefore.mockReset().mockRejectedValue(new Error('offline'));
    mocks.trash.countAddedSince.mockRejectedValue(new Error('offline'));
    await sut.handleStart();

    expect(stored.state?.nights[0]).toMatchObject({ removedFromTrash: null, newFiles: null });
  });

  it('compares look-alike photos again once when "Save and start tonight" asked for it (FL-520)', async () => {
    const { sut, mocks } = setup();
    mocks.metadata.get.mockImplementation((key: SystemMetadataKey) =>
      Promise.resolve(key === SystemMetadataKey.DuplicateRecompare ? ({ requestedAt: 'then' } as never) : undefined),
    );
    await sut.handleStart();

    expect(mocks.metadata.delete).toHaveBeenCalledWith(SystemMetadataKey.DuplicateRecompare);
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.AssetDetectDuplicatesQueueAll,
      data: { force: true },
    });
  });

  it('waits for a step to finish before starting the next', async () => {
    const { sut, mocks, stored, busy } = setup();
    busy[QueueName.Library] = true;
    await sut.handleStart();

    expect(stored.state?.run?.step).toBe('folders');
    expect(mocks.icloud.queueOperation).not.toHaveBeenCalled();

    busy[QueueName.Library] = false;
    await sut.move();
    expect(mocks.icloud.queueOperation).toHaveBeenCalled();
    expect(stored.state?.run).toBeNull();
  });

  it('leaves out a step that is not set up', async () => {
    const { sut, mocks, stored } = setup();
    mocks.icloud.hasConnections.mockResolvedValue(false);
    await sut.handleStart();

    expect(mocks.icloud.queueOperation).not.toHaveBeenCalled();
    expect(stored.state?.nights[0].results.icloud).toBe('off');
  });

  it('runs a step set to "only when I start it" with Run now only', async () => {
    const { sut, mocks, stored } = setup({ steps: { folders: OvernightStepTiming.Manual } });
    await sut.handleStart();
    expect(stored.state?.nights[0].results.folders).toBe('skipped');
    expect(mocks.job.queue).not.toHaveBeenCalledWith({ name: JobName.LibraryScanQueueAll });

    await sut.handleStart({ manual: true });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryScanQueueAll });
  });

  it('keeps the nightly counts when the tidy-up does not run', async () => {
    const { sut, mocks } = setup({ steps: { cleanup: OvernightStepTiming.Manual } });
    await sut.handleStart();
    expect(mocks.queue.handleNightlyJobs).toHaveBeenCalledWith({ cleanup: false });
    expect(mocks.queue.handleNightlyJobs).not.toHaveBeenCalledWith({ cleanup: true });
  });

  it('starts no step after the stop time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T05:59:00Z'));
    const { sut, mocks, stored, busy } = setup({ stopTime: '06:00' });
    busy[QueueName.Library] = true;
    await sut.handleStart();
    expect(stored.state?.run?.step).toBe('folders');

    vi.setSystemTime(new Date('2026-10-20T06:05:00Z'));
    busy[QueueName.Library] = false;
    await sut.move();
    expect(mocks.icloud.queueOperation).not.toHaveBeenCalled();
    expect(stored.state?.nights[0].results).toEqual({
      cleanup: 'done',
      folders: 'done',
      icloud: 'stopped',
      fileChecks: 'stopped',
    });
  });

  it('does not start a second run while one is going', async () => {
    const { sut, busy } = setup();
    busy[QueueName.Library] = true;
    await sut.handleStart();
    await expect(sut.handleStart()).resolves.toBe(JobStatus.Skipped);
  });

  it('stops a run and records what it did not reach', async () => {
    const { sut, stored, busy } = setup();
    busy[QueueName.Library] = true;
    await sut.handleStart();
    await sut.stop();
    expect(stored.state?.run).toBeNull();
    expect(stored.state?.nights[0].results).toEqual({
      cleanup: 'done',
      folders: 'unfinished',
      icloud: 'stopped',
      fileChecks: 'stopped',
    });
  });

  it('refuses Run now while a run is going', async () => {
    const { sut, busy } = setup();
    busy[QueueName.Library] = true;
    await sut.handleStart();
    await expect(sut.runNow()).rejects.toThrow();
  });
});

describe('overnight rules', () => {
  it('builds the schedule from the start time and the days', () => {
    expect(overnightCron({ startTime: '00:30', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('30 0 * * *');
    expect(overnightCron({ startTime: '23:05', days: [3, 0, 3] })).toBe('5 23 * * 0,3');
  });

  it('runs a weekly step on its day only', () => {
    const sunday = '2026-10-18T00:00:00Z';
    const monday = '2026-10-19T00:00:00Z';
    const base = { manual: false, weeklyDay: 0, zone: 'UTC' };
    expect(isStepDue(OvernightStepTiming.Weekly, { ...base, startedAt: sunday })).toBe(true);
    expect(isStepDue(OvernightStepTiming.Weekly, { ...base, startedAt: monday })).toBe(false);
    expect(isStepDue(OvernightStepTiming.Manual, { ...base, startedAt: monday })).toBe(false);
    expect(isStepDue(OvernightStepTiming.Manual, { ...base, manual: true, startedAt: monday })).toBe(true);
  });

  it('stops at the first stop time after the start', () => {
    expect(overnightStopAt('2026-10-20T00:00:00Z', '06:00', 'UTC')?.toISO()).toBe('2026-10-20T06:00:00.000Z');
    expect(overnightStopAt('2026-10-20T23:00:00Z', '06:00', 'UTC')?.toISO()).toBe('2026-10-21T06:00:00.000Z');
    expect(overnightStopAt('2026-10-20T00:00:00Z', '', 'UTC')).toBeNull();
  });

  it('keeps the most recent nights', () => {
    const night = { startedAt: 'a', finishedAt: 'b', manual: false, results: {} };
    let nights: (typeof night)[] = [];
    for (let index = 0; index < OVERNIGHT_NIGHTS_KEPT + 3; index++) {
      nights = keepNight(nights, night);
    }
    expect(nights).toHaveLength(OVERNIGHT_NIGHTS_KEPT);
  });
});
