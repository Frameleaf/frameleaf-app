import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { ATTENTION_KINDS, ATTENTION_REASONS } from 'src/dtos/attention.dto.js';
import { QueueName, SystemMetadataKey } from 'src/enum.js';
import { AttentionService } from 'src/services/attention.service.js';
import { UPGRADE_FINGERPRINT_KEY } from 'src/utils/library-fingerprint.js';
import { AuthFactory } from 'test/factories/auth.factory.js';

const GB = 1_000_000_000;
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const admin = AuthFactory.create({ isAdmin: true }) as unknown as AuthDto;
const idle = { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 };

/** A healthy server: room on the drive, Cloud Backup and the library data copy up to date, no failures. */
const setup = () => {
  const metadata: Partial<Record<SystemMetadataKey, unknown>> = {
    [SystemMetadataKey.FrameleafCloudBackup]: {
      claimedAt: daysAgo(30),
      lastSuccessAt: daysAgo(0.4),
      lastRun: { status: 'completed', startedAt: daysAgo(0.5), finishedAt: daysAgo(0.4) },
    },
    [SystemMetadataKey.BackupSequence]: { run: null },
    [SystemMetadataKey.VersionCheckState]: { checkedAt: daysAgo(0.1), releaseVersion: `v${serverVersion}` },
  };
  const config = {
    backup: {
      database: { enabled: true, cronExpression: '0 02 * * *', keepLastAmount: 14 },
      schedule: { cronExpression: '' },
    },
    frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', schedule: { cronExpression: '0 3 * * *' } } },
    newVersionCheck: { enabled: true, channel: 'stable' },
    storageWarning: { percent: 90 },
  };
  const mocks = {
    logger: { setContext: vi.fn(), warn: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn() },
    config: { getEnv: () => ({}) },
    metadata: {
      get: vi.fn((key: SystemMetadataKey) => Promise.resolve(metadata[key])),
      set: vi.fn((key: SystemMetadataKey, value: unknown) => {
        metadata[key] = value;
        return Promise.resolve();
      }),
    },
    storage: {
      checkDiskUsage: vi.fn().mockResolvedValue({ available: 600 * GB, free: 600 * GB, total: 1000 * GB }),
      // One drive: thumbnails sit inside the library's own folder.
      getDevice: vi.fn().mockResolvedValue(42),
      // The server names each copy after its own clock: this one was made early this morning.
      readdir: vi
        .fn()
        .mockResolvedValue([
          'frameleaf-db-backup-20261016T020000-v3.2.0-pg16.sql.gz',
          'uploaded-frameleaf-db-backup-20250101T020000-v3.2.0-pg16.sql.gz',
        ]),
    },
    job: {
      getJobCounts: vi.fn().mockResolvedValue(idle),
      isPaused: vi.fn().mockResolvedValue(false),
    },
    buddy: {
      state: vi.fn().mockResolvedValue({ settings: null, pairing: null, lastCompleteAt: null, run: null }),
    },
  };
  const counts = { fixed: 0, needsYou: 0, since: null as Date | null, latest: null as Date | null };
  const failures = { count: 0, setAside: 0 };
  const assetJob = { countProcessingFailures: vi.fn().mockImplementation(() => Promise.resolve({ ...failures })) };
  const mediaHealth = { fileProblemCounts: vi.fn().mockImplementation(() => Promise.resolve({ ...counts })) };
  const sut = new AttentionService(
    mocks.logger as never,
    mocks.config as never,
    mocks.metadata as never,
    mocks.storage as never,
    mocks.job as never,
    mocks.buddy as never,
    mediaHealth as never,
    assetJob as never,
  );
  // The configuration is handed over as it is, as in the backup schedule's spec.
  const settings = { current: config as object };
  (sut as unknown as { readConfig: () => Promise<unknown> }).readConfig = () => Promise.resolve(settings.current);
  const useConfig = (next: object) => {
    settings.current = next;
  };
  return { sut, mocks, metadata, config, useConfig, mediaHealth, counts, assetJob, failures };
};

describe(AttentionService.name, () => {
  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('says nothing needs attention on a healthy server, with every check in its fixed order', async () => {
    const { sut } = setup();

    await expect(sut.getAttention(admin)).resolves.toEqual({
      checkedAt: NOW.toISOString(),
      items: [],
      checks: [
        { kind: 'backup', state: 'ok' },
        { kind: 'storage', state: 'ok' },
        { kind: 'work', state: 'ok' },
        { kind: 'version', state: 'ok' },
      ],
      dismissed: [],
      fileProblems: { fixed: 0, needsYou: 0, since: null, latest: null },
      processingFailures: { count: 0, setAside: 0 },
      upgradeCheck: { state: 'none', reason: null, checkedAt: null, fromVersion: null, toVersion: null },
    });
  });

  it('says how the library check after the last upgrade came out in a field of its own (FL-954)', async () => {
    const { sut, mocks, metadata } = setup();
    const latest = {
      fromVersion: '1.4.0',
      toVersion: '1.4.1',
      checkedAt: daysAgo(1),
      state: 'attention',
      findings: [{ reason: 'drive-missing', path: '/mnt/photos' }],
    };
    metadata[UPGRADE_FINGERPRINT_KEY] = { latest };

    const response = await sut.getAttention(admin);

    expect(response.upgradeCheck).toEqual({
      state: 'attention',
      reason: 'upgrade-check-failed',
      checkedAt: daysAgo(1),
      fromVersion: '1.4.0',
      toVersion: '1.4.1',
    });
    // not an attention item: nothing is added, no check changes, and the reasons stay as they were
    expect(response.items).toEqual([]);
    expect(response.checks.every((check) => check.state === 'ok')).toBe(true);
    expect(ATTENTION_REASONS).not.toContain('upgrade-check-failed');

    metadata[UPGRADE_FINGERPRINT_KEY] = { latest: { ...latest, state: 'ok', findings: [] } };
    await expect(sut.getAttention(admin)).resolves.toMatchObject({ upgradeCheck: { state: 'ok', reason: null } });

    mocks.metadata.get.mockImplementation((key: SystemMetadataKey) =>
      key === UPGRADE_FINGERPRINT_KEY
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve(metadata[key]),
    );
    await expect(sut.getAttention(admin)).resolves.toMatchObject({ upgradeCheck: { state: 'none', reason: null } });
  });

  it('counts the files Frameleaf could not process in a field of its own, never as a new kind or reason (FL-862)', async () => {
    const { sut, assetJob, failures } = setup();
    failures.count = 4;
    failures.setAside = 2;

    const response = await sut.getAttention(admin);
    expect(response.processingFailures).toEqual({ count: 4, setAside: 2 });
    expect(assetJob.countProcessingFailures).toHaveBeenCalledWith(admin);
    // native apps decode these strictly: the kinds and reasons stay exactly as they were
    expect(ATTENTION_KINDS).toEqual(['backup', 'storage', 'work', 'version']);
    expect(ATTENTION_REASONS).toEqual([
      'not-backed-up',
      'backup-failed',
      'backup-behind',
      'nearly-full',
      'out-of-space',
      'work-failed',
      'work-paused',
      'new-version',
    ]);
    expect(response.items).toEqual([]);
    expect(response.checks.every((check) => check.state === 'ok')).toBe(true);
  });

  it('still answers when the files it could not process cannot be counted', async () => {
    const { sut, mocks, assetJob } = setup();
    assetJob.countProcessingFailures.mockRejectedValueOnce(new Error('connection terminated'));

    const response = await sut.getAttention(admin);
    expect(response.processingFailures).toEqual({ count: 0, setAside: 0 });
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not process'));
  });

  it('counts what Frameleaf fixed this week and what needs you, since the earliest fix, to the newest (FL-1337)', async () => {
    const { sut, mediaHealth, counts } = setup();
    counts.fixed = 5;
    counts.needsYou = 2;
    counts.since = new Date(daysAgo(3));
    counts.latest = new Date(daysAgo(1));

    const response = await sut.getAttention(admin);
    expect(response.fileProblems).toEqual({ fixed: 5, needsYou: 2, since: daysAgo(3), latest: daysAgo(1) });
    // a count is not an attention item: nothing is added and no check changes
    expect(response.items).toEqual([]);
    expect(response.checks.every((check) => check.state === 'ok')).toBe(true);
    expect(mediaHealth.fileProblemCounts).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));
  });

  it('still answers when the damaged and missing files cannot be counted, with no counts and a warning', async () => {
    const { sut, mocks, mediaHealth } = setup();
    mediaHealth.fileProblemCounts.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

    const response = await sut.getAttention(admin);

    expect(response.fileProblems).toEqual({ fixed: 0, needsYou: 0, since: null, latest: null });
    expect(response.checks.every((check) => check.state === 'ok')).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('damaged and missing files'));
  });

  it("counts every account's problems for the administrator who asks, minus other accounts' Locked photos", async () => {
    const { sut, mediaHealth } = setup();

    await sut.getAttention(admin);
    const [options] = mediaHealth.fileProblemCounts.mock.calls[0] as [{ ownerId?: string; privacy: object }];
    expect(options.ownerId).toBeUndefined();
    // the administrator's own privacy rides along, so another account's Locked photo is never counted
    expect(options.privacy).not.toHaveProperty('lockedOwnerId');
  });

  it('keeps a dismissed Overview item for every administrator, and brings it back (FL-363)', async () => {
    const { sut } = setup();

    await expect(sut.setDismissed(admin, { id: 'studio', dismissed: true })).resolves.toEqual(
      expect.objectContaining({ dismissed: ['studio'] }),
    );
    await expect(sut.setDismissed(admin, { id: 'studio', dismissed: false })).resolves.toEqual(
      expect.objectContaining({ dismissed: [] }),
    );
  });

  it('keeps the newest 32 dismissals, including the one just added', async () => {
    const { sut, mocks } = setup();
    const old = Array.from({ length: 32 }, (_, i) => `old-${i}`);
    await mocks.metadata.set(SystemMetadataKey.OverviewDismissed, { ids: old });

    await expect(sut.setDismissed(admin, { id: 'studio', dismissed: true })).resolves.toEqual(
      expect.objectContaining({ dismissed: [...old.slice(1), 'studio'] }),
    );
  });

  it('reads the drive the library is on', async () => {
    const { sut, mocks } = setup();
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 8 * GB, free: 8 * GB, total: 500 * GB });

    const { items } = await sut.getAttention(admin);
    expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringMatching(/library$/));
    expect(items).toEqual([
      expect.objectContaining({
        id: 'storage',
        reason: 'out-of-space',
        level: 'now',
        storage: expect.objectContaining({ drive: 'library' }),
      }),
    ]);
  });

  describe('thumbnails on a drive of their own (FL-1324)', () => {
    const separateDrives = (mocks: ReturnType<typeof setup>['mocks']) =>
      mocks.storage.getDevice.mockImplementation((path: string) => Promise.resolve(path.endsWith('thumbs') ? 7 : 42));
    const diskFor = (mocks: ReturnType<typeof setup>['mocks'], library: number, thumbnails: number) =>
      mocks.storage.checkDiskUsage.mockImplementation((path: string) => {
        const available = (path.endsWith('thumbs') ? thumbnails : library) * GB;
        return Promise.resolve({ available, free: available, total: 500 * GB });
      });

    it('keeps one item for a library whose thumbnails are on the same drive', async () => {
      const { sut, mocks } = setup();
      diskFor(mocks, 8, 8);

      const { items, checks } = await sut.getAttention(admin);
      expect(items.map((item) => item.id)).toEqual(['storage']);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledTimes(1);
    });

    it('names the thumbnails drive when only it is nearly full', async () => {
      const { sut, mocks } = setup();
      separateDrives(mocks);
      diskFor(mocks, 400, 30);

      const { items, checks } = await sut.getAttention(admin);
      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringMatching(/thumbs$/));
      expect(items).toEqual([
        expect.objectContaining({
          id: 'storage:thumbnails',
          reason: 'nearly-full',
          level: 'soon',
          storage: { drive: 'thumbnails', availableBytes: 30 * GB, totalBytes: 500 * GB, usedPercent: 94 },
        }),
      ]);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
    });

    it('lists each drive that is running out, with the drive named', async () => {
      const { sut, mocks } = setup();
      separateDrives(mocks);
      diskFor(mocks, 30, 5);

      const { items } = await sut.getAttention(admin);
      expect(items.map((item) => [item.id, item.reason, item.storage?.drive])).toEqual([
        ['storage:thumbnails', 'out-of-space', 'thumbnails'],
        ['storage', 'nearly-full', 'library'],
      ]);
    });

    it('is fine when both drives have room', async () => {
      const { sut, mocks } = setup();
      separateDrives(mocks);

      const { items, checks } = await sut.getAttention(admin);
      expect(items).toEqual([]);
      expect(checks).toContainEqual({ kind: 'storage', state: 'ok' });
      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledTimes(2);
    });

    it('still warns about one drive when the other cannot be read', async () => {
      const { sut, mocks } = setup();
      separateDrives(mocks);
      mocks.storage.checkDiskUsage.mockImplementation((path: string) =>
        path.endsWith('thumbs')
          ? Promise.reject(new Error('EIO'))
          : Promise.resolve({ available: 5 * GB, free: 5 * GB, total: 500 * GB }),
      );

      const { items, checks } = await sut.getAttention(admin);
      expect(items.map((item) => item.id)).toEqual(['storage']);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('thumbnails drive'));
    });

    it('still warns about a full thumbnails drive when the library folder cannot be read', async () => {
      const { sut, mocks } = setup();
      mocks.storage.getDevice.mockImplementation((path: string) => Promise.resolve(path.endsWith('thumbs') ? 7 : null));
      mocks.storage.checkDiskUsage.mockImplementation((path: string) =>
        path.endsWith('thumbs')
          ? Promise.resolve({ available: 5 * GB, free: 5 * GB, total: 500 * GB })
          : Promise.reject(new Error('EACCES')),
      );

      const { items, checks } = await sut.getAttention(admin);
      expect(items.map((item) => [item.id, item.storage?.drive])).toEqual([['storage:thumbnails', 'thumbnails']]);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
    });

    it('does not take same-size drives with nearly the same room for one drive when the library device is unknown', async () => {
      const { sut, mocks } = setup();
      mocks.storage.getDevice.mockImplementation((path: string) => Promise.resolve(path.endsWith('thumbs') ? 7 : null));
      mocks.storage.checkDiskUsage.mockImplementation((path: string) => {
        const available = (path.endsWith('thumbs') ? 9.9 : 10.1) * GB;
        return Promise.resolve({ available, free: available, total: 500 * GB });
      });

      const { items } = await sut.getAttention(admin);
      expect(items.map((item) => [item.id, item.reason])).toEqual([
        ['storage:thumbnails', 'out-of-space'],
        ['storage', 'nearly-full'],
      ]);
    });

    it('still names a low thumbnails drive when the library drive is read but its device is not', async () => {
      const { sut, mocks } = setup();
      mocks.storage.getDevice.mockImplementation((path: string) => Promise.resolve(path.endsWith('thumbs') ? 7 : null));
      diskFor(mocks, 400, 5);

      const { items } = await sut.getAttention(admin);
      expect(items.map((item) => [item.id, item.storage?.drive])).toEqual([['storage:thumbnails', 'thumbnails']]);
    });

    it('says the storage check is unknown when the thumbnails folder cannot be read', async () => {
      const { sut, mocks } = setup();
      mocks.storage.getDevice.mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('thumbs') ? null : 42),
      );

      const { items, checks } = await sut.getAttention(admin);
      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledTimes(1);
      expect(items).toEqual([]);
      expect(checks).toContainEqual({ kind: 'storage', state: 'unknown' });
    });

    it('keeps the library warning when the thumbnails folder cannot be read', async () => {
      const { sut, mocks } = setup();
      mocks.storage.getDevice.mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('thumbs') ? null : 42),
      );
      diskFor(mocks, 5, 5);

      const { items, checks } = await sut.getAttention(admin);
      expect(items.map((item) => item.id)).toEqual(['storage']);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
    });

    it('reads the shared drive through the thumbnails folder when the library folder cannot be read', async () => {
      const { sut, mocks } = setup();
      mocks.storage.checkDiskUsage.mockImplementation((path: string) =>
        path.endsWith('thumbs')
          ? Promise.resolve({ available: 30 * GB, free: 30 * GB, total: 500 * GB })
          : Promise.reject(new Error('EACCES')),
      );

      const { items, checks } = await sut.getAttention(admin);
      expect(items).toEqual([
        expect.objectContaining({
          id: 'storage',
          reason: 'nearly-full',
          storage: expect.objectContaining({ drive: 'library' }),
        }),
      ]);
      expect(checks).toContainEqual({ kind: 'storage', state: 'attention' });
    });
  });

  it('reads each backup place from what the server records about it', async () => {
    const { sut, mocks, metadata } = setup();
    vi.stubEnv('FRAMELEAF_BUDDY_BACKUP', 'true');
    metadata[SystemMetadataKey.FrameleafCloudBackup] = {
      claimedAt: daysAgo(30),
      lastSuccessAt: daysAgo(2),
      lastRun: { status: 'failed', startedAt: daysAgo(0.6), finishedAt: daysAgo(0.5) },
    };
    mocks.buddy.state.mockResolvedValue({
      settings: { schedule: '0 4 * * *', pausedSending: false },
      pairing: { state: 'active' },
      lastCompleteAt: daysAgo(4),
      protectionStartedAt: daysAgo(40),
      run: { state: 'waiting-peer', startedAt: daysAgo(1), finishedAt: null },
    });
    // The newest scheduled copy is five days old; the uploaded one is not a scheduled copy.
    mocks.storage.readdir.mockResolvedValue([
      'frameleaf-db-backup-20261011T020000-v3.2.0-pg16.sql.gz',
      'frameleaf-db-backup-20261010T020000-v3.2.0-pg16.sql.gz',
      'uploaded-frameleaf-db-backup-20261016T020000-v3.2.0-pg16.sql.gz',
    ]);

    const { items, checks } = await sut.getAttention(admin);
    expect(items.map((item) => [item.id, item.reason])).toEqual([
      ['backup:cloud', 'backup-failed'],
      ['backup:buddy', 'backup-behind'],
      ['backup:local', 'backup-behind'],
    ]);
    expect(checks[0]).toEqual({ kind: 'backup', state: 'attention' });
  });

  it('leaves Buddy Backup out while its feature is switched off on this server', async () => {
    const { sut, mocks, metadata } = setup();
    metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
    mocks.buddy.state.mockResolvedValue({
      settings: { schedule: '0 4 * * *' },
      pairing: { state: 'active' },
      lastCompleteAt: daysAgo(10),
      run: null,
    });

    const { items } = await sut.getAttention(admin);
    expect(items.map((item) => item.id)).toEqual(['backup:none']);
  });

  it('says nothing about a library data copy that is missing while there is no backups folder yet', async () => {
    const { sut, mocks } = setup();
    mocks.storage.readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const { items, checks } = await sut.getAttention(admin);
    expect(items).toEqual([]);
    expect(checks[0]).toEqual({ kind: 'backup', state: 'ok' });
  });

  it('treats a run of the backup schedule that has reached a place as its backup being made', async () => {
    const { sut, mocks, metadata } = setup();
    mocks.storage.readdir.mockResolvedValue(['frameleaf-db-backup-20261001T020000-v3.2.0-pg16.sql.gz']);
    metadata[SystemMetadataKey.BackupSequence] = {
      run: { place: 'local', startedAt: daysAgo(0.01), begun: false, results: {} },
    };

    expect((await sut.getAttention(admin)).items).toEqual([]);
  });

  it('reads every kind of work, and leaves out a pause a library move holds', async () => {
    const { sut, mocks, metadata } = setup();
    metadata[SystemMetadataKey.FrameleafLibraryMovePause] = { queues: [QueueName.SmartSearch] };
    mocks.job.getJobCounts.mockImplementation((name: QueueName) =>
      Promise.resolve(
        name === QueueName.VideoConversion
          ? { ...idle, failed: 2 }
          : name === QueueName.FaceDetection || name === QueueName.SmartSearch
            ? { ...idle, waiting: 10 }
            : idle,
      ),
    );
    mocks.job.isPaused.mockImplementation((name: QueueName) =>
      Promise.resolve(name === QueueName.FaceDetection || name === QueueName.SmartSearch),
    );

    const { items } = await sut.getAttention(admin);
    expect(mocks.job.getJobCounts).toHaveBeenCalledTimes(Object.values(QueueName).length);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'work:failed',
        work: { count: 2, queues: [{ name: QueueName.VideoConversion, count: 2 }] },
      }),
      expect.objectContaining({
        id: 'work:paused',
        work: { count: 10, queues: [{ name: QueueName.FaceDetection, count: 10 }] },
      }),
    ]);
  });

  it('leaves out the heavy work quiet hours save for tonight on a new server (FL-711)', async () => {
    const { sut, mocks, metadata, config, useConfig } = setup();
    useConfig({ ...config, nightlyTasks: { startTime: '00:00', days: [0, 1, 2, 3, 4, 5, 6] } });
    metadata[SystemMetadataKey.OvernightSequence] = {
      run: null,
      nights: [],
      quiet: { holding: [QueueName.VideoConversion, QueueName.FaceDetection] },
    };
    mocks.job.getJobCounts.mockImplementation((name: QueueName) =>
      Promise.resolve(name === QueueName.VideoConversion ? { ...idle, paused: 3 } : idle),
    );
    mocks.job.isPaused.mockImplementation((name: QueueName) => Promise.resolve(name === QueueName.VideoConversion));

    expect((await sut.getAttention(admin)).items).toEqual([]);
  });

  it('still lists a pause an administrator made on a queue quiet hours do not hold', async () => {
    const { sut, mocks, metadata, config, useConfig } = setup();
    useConfig({ ...config, nightlyTasks: { startTime: '00:00', days: [0, 1, 2, 3, 4, 5, 6] } });
    metadata[SystemMetadataKey.OvernightSequence] = { run: null, nights: [], quiet: { holding: null } };
    mocks.job.getJobCounts.mockImplementation((name: QueueName) =>
      Promise.resolve(name === QueueName.VideoConversion ? { ...idle, paused: 3 } : idle),
    );
    mocks.job.isPaused.mockImplementation((name: QueueName) => Promise.resolve(name === QueueName.VideoConversion));

    expect((await sut.getAttention(admin)).items).toEqual([
      expect.objectContaining({
        id: 'work:paused',
        work: { count: 3, queues: [{ name: QueueName.VideoConversion, count: 3 }] },
      }),
    ]);
  });

  it('lists a newer version the check found, and is off while looking for updates is', async () => {
    const { sut, metadata, config, useConfig } = setup();
    metadata[SystemMetadataKey.VersionCheckState] = { checkedAt: daysAgo(0.1), releaseVersion: 'v99.0.0' };

    const { items } = await sut.getAttention(admin);
    expect(items).toEqual([
      expect.objectContaining({ id: 'version', version: { current: serverVersion.toString(), available: '99.0.0' } }),
    ]);

    useConfig({ ...config, newVersionCheck: { enabled: false, channel: 'stable' } });
    const { checks, items: none } = await sut.getAttention(admin);
    expect(none).toEqual([]);
    expect(checks.at(-1)).toEqual({ kind: 'version', state: 'off' });
  });

  it('says a check it could not read is unknown, and still makes the others', async () => {
    const { sut, mocks } = setup();
    mocks.storage.checkDiskUsage.mockRejectedValue(new Error('EACCES'));
    mocks.job.getJobCounts.mockRejectedValue(new Error('pool exhausted'));

    const { checks } = await sut.getAttention(admin);
    expect(checks).toEqual([
      { kind: 'backup', state: 'ok' },
      { kind: 'storage', state: 'unknown' },
      { kind: 'work', state: 'unknown' },
      { kind: 'version', state: 'ok' },
    ]);
    // the library drive, then the same drive through the thumbnails folder, then the work
    expect(mocks.logger.warn).toHaveBeenCalledTimes(3);
  });

  it('puts what needs the person now first', async () => {
    const { sut, mocks, metadata } = setup();
    metadata[SystemMetadataKey.VersionCheckState] = { checkedAt: daysAgo(0.1), releaseVersion: 'v99.0.0' };
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 5 * GB, free: 5 * GB, total: 500 * GB });
    metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;

    expect((await sut.getAttention(admin)).items.map((item) => item.id)).toEqual(['backup:none', 'storage', 'version']);
  });
});
