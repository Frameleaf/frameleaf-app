import { describe, expect, it, vi } from 'vitest';
import { DatabaseLock, JobName, JobStatus, QueueJobStatus, SystemMetadataKey } from 'src/enum.js';
import { BACKUP_SEQUENCE_CRON, BackupSequenceService } from 'src/services/backup-sequence.service.js';
import { type BackupSequenceState, deriveBackupSchedule, effectiveBackupSchedule } from 'src/utils/backup-sequence.js';

type Place = { on: boolean; busy: boolean };

/** A server with the three places a backup is kept, each on and idle unless a test says otherwise. */
const setup = (options: { chosen?: string; databaseEnabled?: boolean; databaseCron?: string } = {}) => {
  const order: string[] = [];
  const stored: { state?: BackupSequenceState } = {};
  let lockTail = Promise.resolve();
  const buddy: Place = { on: true, busy: false };
  // The snapshot job the run queues: it finishes at once unless a test gives it another state.
  const local: { status: QueueJobStatus } = { status: QueueJobStatus.Complete };
  const cloud: Place = { on: true, busy: false };
  const config = {
    backup: {
      database: {
        enabled: options.databaseEnabled ?? true,
        cronExpression: options.databaseCron ?? '0 02 * * *',
        keepLastAmount: 14,
      },
      schedule: { cronExpression: options.chosen ?? '' },
    },
    frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', schedule: { cronExpression: '0 3 * * *' } } },
    server: { timeZone: '' },
  };
  const mocks = {
    logger: { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // `getConfig` reads the configuration file when there is one; the test gives it the object itself.
    config: { getEnv: () => ({ configFile: 'test' }) },
    metadata: {
      get: vi.fn((key: SystemMetadataKey) =>
        Promise.resolve(key === SystemMetadataKey.BackupSequence ? stored.state : undefined),
      ),
      set: vi.fn((_key: SystemMetadataKey, value: BackupSequenceState) => {
        stored.state = value;
        return Promise.resolve();
      }),
    },
    database: {
      tryLock: vi.fn().mockResolvedValue(true),
      withLock: vi.fn((_lock: DatabaseLock, work: () => Promise<unknown>) => {
        const pending = lockTail.then(work);
        lockTail = pending.then(() => {}).catch(() => {});
        return pending;
      }),
    },
    cron: { create: vi.fn(), update: vi.fn() },
    /** Queuing the snapshot job ("local"). */
    snapshot: vi.fn((): Promise<unknown> => {
      order.push('local');
      return Promise.resolve();
    }),
    job: {
      queue: vi.fn((item: { name: JobName }) =>
        item.name === JobName.DatabaseBackup ? mocks.snapshot() : Promise.resolve(),
      ),
      searchJobs: vi.fn((_queue: string, dto: { status?: QueueJobStatus[] }) => {
        const job = { id: 'snapshot-job', name: JobName.DatabaseBackup, status: local.status };
        return Promise.resolve(!dto.status || dto.status.includes(local.status) ? [job] : []);
      }),
    },
    buddyRepository: { state: vi.fn().mockResolvedValue({ settings: { schedule: '0 4 * * *' } }) },
    buddyBackup: {
      sequenceStatus: vi.fn(() => Promise.resolve({ ...buddy })),
      startScheduled: vi.fn(() => {
        order.push('buddy');
        buddy.busy = true;
        return Promise.resolve();
      }),
    },
    cloudBackup: {
      sequenceStatus: vi.fn(() => Promise.resolve({ ...cloud })),
      handleSchedule: vi.fn(() => {
        order.push('cloud');
        cloud.busy = true;
        return Promise.resolve(JobStatus.Success);
      }),
    },
  };
  const createService = () => {
    const sut = new BackupSequenceService(
      mocks.logger as never,
      mocks.config as never,
      mocks.metadata as never,
      mocks.database as never,
      mocks.cron as never,
      mocks.job as never,
      mocks.buddyRepository as never,
      mocks.buddyBackup as never,
      mocks.cloudBackup as never,
    );
    (sut as unknown as { readConfig: () => Promise<unknown> }).readConfig = () => Promise.resolve(config);
    return sut;
  };
  return { sut: createService(), createService, mocks, order, stored, local, buddy, cloud, config };
};

describe('the one backup schedule (FL-362)', () => {
  describe('the schedule of a server that had three', () => {
    const database = { enabled: true, cronExpression: '0 02 * * *' };

    it('keeps the time the night used to start: the first place in the order that is in use', () => {
      expect(deriveBackupSchedule({ database, buddy: '0 4 * * *', cloud: '0 3 * * *' })).toBe('0 02 * * *');
      expect(
        deriveBackupSchedule({ database: { ...database, enabled: false }, buddy: '0 4 * * *', cloud: '0 3 * * *' }),
      ).toBe('0 4 * * *');
      expect(deriveBackupSchedule({ database: { ...database, enabled: false }, buddy: null, cloud: '0 3 * * 0' })).toBe(
        '0 3 * * 0',
      );
      // Nothing in use: the library data copy's time stands for the day something is turned on.
      expect(deriveBackupSchedule({ database: { ...database, enabled: false } })).toBe('0 02 * * *');
    });

    it('gives way to the schedule chosen in Backup settings', () => {
      expect(effectiveBackupSchedule('0 1 * * 1', { database, cloud: '0 3 * * *' })).toBe('0 1 * * 1');
      expect(effectiveBackupSchedule('', { database })).toBe('0 02 * * *');
      expect(effectiveBackupSchedule(undefined, { database })).toBe('0 02 * * *');
    });

    it('starts the one timer on the stored schedule, and follows a schedule chosen later', async () => {
      const { sut, mocks, config } = setup({ databaseEnabled: false });
      await sut.onConfigInit({ newConfig: config as never });
      expect(mocks.cron.create).toHaveBeenCalledTimes(1);
      // The library data copy is off, so the night starts when Buddy Backup used to.
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: BACKUP_SEQUENCE_CRON, expression: '0 4 * * *', start: true }),
      );
      config.backup.schedule.cronExpression = '30 1 * * *';
      await sut.onConfigUpdate({ newConfig: config as never, oldConfig: config as never });
      expect(mocks.cron.update).toHaveBeenCalledWith({ name: BACKUP_SEQUENCE_CRON, expression: '30 1 * * *' });
      await sut.onShutdown();
    });

    it('leaves the schedule to the server that holds its lock', async () => {
      const { sut, mocks, config } = setup();
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: config as never });
      await sut.onConfigUpdate({ newConfig: config as never, oldConfig: config as never });
      expect(mocks.cron.create).not.toHaveBeenCalled();
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });
  });

  describe('a run', () => {
    it('serializes advancement across workers while the local backup is running', async () => {
      const { sut, createService, mocks, buddy, cloud } = setup();
      buddy.on = false;
      cloud.on = false;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mocks.snapshot.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return JobStatus.Success;
      });
      const starting = sut.handleStart();
      await entered.promise;
      const advancing = createService().move();
      release.resolve();
      await Promise.all([starting, advancing]);
      expect(mocks.snapshot).toHaveBeenCalledOnce();
      expect(mocks.database.withLock).toHaveBeenCalledTimes(2);
      for (const [lock] of mocks.database.withLock.mock.calls) expect(lock).toBe(DatabaseLock.BackupSequenceRun);
    });

    it('retains a scheduled tick received while another worker advances the run', async () => {
      const { sut, createService, mocks, stored, buddy } = setup();
      buddy.on = false;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mocks.snapshot.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return JobStatus.Success;
      });
      const starting = sut.handleStart();
      await entered.promise;
      const ticking = createService().handleStart();
      release.resolve();
      expect(await Promise.all([starting, ticking])).toEqual([JobStatus.Success, JobStatus.Skipped]);
      expect(stored.state?.dueAt).toEqual(expect.any(String));
      expect(stored.state?.run).toMatchObject({ place: 'cloud', begun: true });
      expect(mocks.snapshot).toHaveBeenCalledOnce();
    });

    it('backs up this server, then the buddy, then the cloud, each when the one before has finished', async () => {
      const { sut, order, stored, buddy, cloud } = setup();

      await expect(sut.handleStart()).resolves.toBe(JobStatus.Success);
      // The library data copy is made at once; Buddy Backup has started and Cloud Backup waits its turn.
      expect(order).toEqual(['local', 'buddy']);
      expect(stored.state?.run).toMatchObject({ place: 'buddy', begun: true, results: { local: 'done' } });

      await sut.move();
      expect(order).toEqual(['local', 'buddy']);

      buddy.busy = false;
      await sut.move();
      expect(order).toEqual(['local', 'buddy', 'cloud']);
      expect(stored.state?.run).toMatchObject({ place: 'cloud', begun: true });

      await sut.move();
      expect(stored.state?.run).not.toBeNull();
      cloud.busy = false;
      await sut.move();
      expect(stored.state?.run).toBeNull();
      expect(stored.state?.finishedAt).toEqual(expect.any(String));
      expect(order).toEqual(['local', 'buddy', 'cloud']);
    });

    it('still backs up the next place when one in the middle fails to start', async () => {
      const { sut, mocks, order, stored } = setup();
      mocks.buddyBackup.startScheduled.mockRejectedValue(new Error('The buddy server did not answer.'));

      await sut.handleStart();
      expect(order).toEqual(['local', 'cloud']);
      expect(stored.state?.run).toMatchObject({ place: 'cloud', results: { local: 'done', buddy: 'failed' } });
    });

    it.each(['buddy', 'cloud'] as const)(
      'keeps waiting when the running %s backup status is unreadable',
      async (place) => {
        const { sut, mocks, order, stored, buddy, cloud } = setup();
        await sut.handleStart();
        if (place === 'cloud') {
          buddy.busy = false;
          await sut.move();
        }
        const before = structuredClone(stored.state);
        const status = place === 'buddy' ? mocks.buddyBackup.sequenceStatus : mocks.cloudBackup.sequenceStatus;
        status.mockRejectedValueOnce(new Error('Backup status unavailable'));

        await expect(sut.move()).rejects.toThrow('Backup status unavailable');
        expect(stored.state).toEqual(before);
        expect(order).toEqual(place === 'buddy' ? ['local', 'buddy'] : ['local', 'buddy', 'cloud']);

        // A later successful read resumes the same run without starting the backup again.
        buddy.busy = false;
        cloud.busy = false;
        await sut.move();
        expect(order).toEqual(['local', 'buddy', 'cloud']);
        expect(stored.state?.run?.place ?? null).toBe(place === 'buddy' ? 'cloud' : null);
      },
    );

    it('still backs up the others when the snapshot job cannot be queued', async () => {
      const { sut, mocks, order, stored } = setup();
      mocks.snapshot.mockRejectedValue(new Error('queue unavailable'));

      await sut.handleStart();
      expect(order).toEqual(['buddy']);
      expect(stored.state?.run?.results).toEqual({ local: 'failed' });
    });

    it('makes the library data copy as the queued snapshot job and waits for it (FL-657)', async () => {
      const { sut, mocks, order, stored, local } = setup();
      local.status = QueueJobStatus.Active;

      await sut.handleStart();
      // The same job "Take a snapshot now" queues, so its outcome is reported the same way.
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.DatabaseBackup, data: {} });
      expect(order).toEqual(['local']);
      expect(stored.state?.run).toMatchObject({ place: 'local', begun: true, jobId: 'snapshot-job' });

      await sut.move();
      expect(order).toEqual(['local']);

      // Waiting for its retry still holds the run.
      local.status = QueueJobStatus.Delayed;
      await sut.move();
      expect(order).toEqual(['local']);

      local.status = QueueJobStatus.Complete;
      await sut.move();
      expect(order).toEqual(['local', 'buddy']);
      expect(stored.state?.run).toMatchObject({ place: 'buddy', results: { local: 'done' } });
    });

    it('records the snapshot job failing for good as a failed library data copy (FL-657)', async () => {
      const { sut, order, stored, local } = setup();
      local.status = QueueJobStatus.Active;
      await sut.handleStart();

      local.status = QueueJobStatus.Failed;
      await sut.move();
      expect(order).toEqual(['local', 'buddy']);
      expect(stored.state?.run?.results).toEqual({ local: 'failed' });
    });

    it('waits for a snapshot being made in a paused queue, but not for one still waiting there', async () => {
      const { sut, order, stored, local } = setup();
      // Pausing a queue does not stop a snapshot already being made: the run waits for it.
      local.status = QueueJobStatus.Active;
      await sut.handleStart();
      await sut.move();
      expect(order).toEqual(['local']);

      // One that has not started stays until the queue is resumed: the run moves on without it.
      local.status = QueueJobStatus.Paused;
      await sut.move();
      expect(order).toEqual(['local', 'buddy']);
      expect(stored.state?.run?.results).toEqual({ local: 'failed' });
    });

    it('moves on from a backup that is left waiting instead of holding the run up', async () => {
      const { sut, order, buddy } = setup();
      await sut.handleStart();
      // Buddy Backup cannot reach its peer: the operation waits, but nothing is being sent.
      buddy.busy = false;
      await sut.move();
      expect(order).toEqual(['local', 'buddy', 'cloud']);
    });

    it('leaves a place that is switched off out of the run', async () => {
      const { sut, mocks, order, stored, buddy, cloud, config } = setup();
      config.backup.database.enabled = false;
      buddy.on = false;

      await sut.handleStart();
      expect(order).toEqual(['cloud']);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.buddyBackup.startScheduled).not.toHaveBeenCalled();
      expect(stored.state?.run?.results).toEqual({ local: 'off', buddy: 'off' });

      cloud.busy = false;
      await sut.move();
      expect(stored.state?.run).toBeNull();
    });

    it('ends at once when every place is off', async () => {
      const { sut, order, stored, buddy, cloud, config } = setup();
      config.backup.database.enabled = false;
      buddy.on = false;
      cloud.on = false;
      await sut.handleStart();
      expect(order).toEqual([]);
      expect(stored.state?.run).toBeNull();
    });

    it('never runs two at once: a start during a run is remembered and follows it', async () => {
      const { sut, mocks, order, stored, buddy, cloud } = setup();
      await sut.handleStart();
      await expect(sut.handleStart()).resolves.toBe(JobStatus.Skipped);
      expect(order).toEqual(['local', 'buddy']);
      expect(stored.state?.dueAt).toEqual(expect.any(String));

      buddy.busy = false;
      await sut.move();
      cloud.busy = false;
      await sut.move();
      expect(stored.state).toMatchObject({ run: null, dueAt: null });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.BackupSequence });
    });
  });

  it('reports the schedule in force, the order and the run in progress', async () => {
    const { sut, buddy } = setup({ chosen: '0 1 * * *' });
    buddy.on = false;
    await sut.handleStart();
    const schedule = await sut.getSchedule();
    expect(schedule).toMatchObject({
      cronExpression: '0 1 * * *',
      chosen: true,
      places: [
        { id: 'local', on: true },
        { id: 'buddy', on: false },
        { id: 'cloud', on: true },
      ],
      run: { place: 'cloud' },
    });
    expect(schedule.nextRunAt).toEqual(expect.any(String));
    expect(schedule.timezone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('gives the next start in the time zone chosen for the server (FL-426)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    try {
      const { sut, config } = setup({ chosen: '0 1 * * *' });
      config.server.timeZone = 'America/Edmonton';
      const schedule = await sut.getSchedule();
      expect(schedule.timezone).toBe('America/Edmonton');
      // 01:00 in Edmonton on 2 January is 08:00 UTC
      expect(schedule.nextRunAt).toBe('2026-01-02T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
