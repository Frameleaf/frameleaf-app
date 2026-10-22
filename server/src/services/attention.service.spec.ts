import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { QueueName, SystemMetadataKey } from 'src/enum.js';
import { AttentionService } from 'src/services/attention.service.js';

const GB = 1_000_000_000;
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
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
    metadata: { get: vi.fn((key: SystemMetadataKey) => Promise.resolve(metadata[key])) },
    storage: {
      checkDiskUsage: vi.fn().mockResolvedValue({ available: 600 * GB, free: 600 * GB, total: 1000 * GB }),
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
  const sut = new AttentionService(
    mocks.logger as never,
    mocks.config as never,
    mocks.metadata as never,
    mocks.storage as never,
    mocks.job as never,
    mocks.buddy as never,
  );
  // The configuration is handed over as it is, as in the backup schedule's spec.
  const settings = { current: config as object };
  (sut as unknown as { readConfig: () => Promise<unknown> }).readConfig = () => Promise.resolve(settings.current);
  const useConfig = (next: object) => {
    settings.current = next;
  };
  return { sut, mocks, metadata, config, useConfig };
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

    await expect(sut.getAttention()).resolves.toEqual({
      checkedAt: NOW.toISOString(),
      items: [],
      checks: [
        { kind: 'backup', state: 'ok' },
        { kind: 'storage', state: 'ok' },
        { kind: 'work', state: 'ok' },
        { kind: 'version', state: 'ok' },
      ],
    });
  });

  it('reads the drive the library is on', async () => {
    const { sut, mocks } = setup();
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 8 * GB, free: 8 * GB, total: 500 * GB });

    const { items } = await sut.getAttention();
    expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringMatching(/library$/));
    expect(items).toEqual([expect.objectContaining({ id: 'storage', reason: 'out-of-space', level: 'now' })]);
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

    const { items, checks } = await sut.getAttention();
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

    const { items } = await sut.getAttention();
    expect(items.map((item) => item.id)).toEqual(['backup:none']);
  });

  it('says nothing about a library data copy that is missing while there is no backups folder yet', async () => {
    const { sut, mocks } = setup();
    mocks.storage.readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const { items, checks } = await sut.getAttention();
    expect(items).toEqual([]);
    expect(checks[0]).toEqual({ kind: 'backup', state: 'ok' });
  });

  it('treats a run of the backup schedule that has reached a place as its backup being made', async () => {
    const { sut, mocks, metadata } = setup();
    mocks.storage.readdir.mockResolvedValue(['frameleaf-db-backup-20261001T020000-v3.2.0-pg16.sql.gz']);
    metadata[SystemMetadataKey.BackupSequence] = {
      run: { place: 'local', startedAt: daysAgo(0.01), begun: false, results: {} },
    };

    expect((await sut.getAttention()).items).toEqual([]);
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

    const { items } = await sut.getAttention();
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

  it('lists a newer version the check found, and is off while looking for updates is', async () => {
    const { sut, metadata, config, useConfig } = setup();
    metadata[SystemMetadataKey.VersionCheckState] = { checkedAt: daysAgo(0.1), releaseVersion: 'v99.0.0' };

    const { items } = await sut.getAttention();
    expect(items).toEqual([
      expect.objectContaining({ id: 'version', version: { current: serverVersion.toString(), available: '99.0.0' } }),
    ]);

    useConfig({ ...config, newVersionCheck: { enabled: false, channel: 'stable' } });
    const { checks, items: none } = await sut.getAttention();
    expect(none).toEqual([]);
    expect(checks.at(-1)).toEqual({ kind: 'version', state: 'off' });
  });

  it('says a check it could not read is unknown, and still makes the others', async () => {
    const { sut, mocks } = setup();
    mocks.storage.checkDiskUsage.mockRejectedValue(new Error('EACCES'));
    mocks.job.getJobCounts.mockRejectedValue(new Error('pool exhausted'));

    const { checks } = await sut.getAttention();
    expect(checks).toEqual([
      { kind: 'backup', state: 'ok' },
      { kind: 'storage', state: 'unknown' },
      { kind: 'work', state: 'unknown' },
      { kind: 'version', state: 'ok' },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('puts what needs the person now first', async () => {
    const { sut, mocks, metadata } = setup();
    metadata[SystemMetadataKey.VersionCheckState] = { checkedAt: daysAgo(0.1), releaseVersion: 'v99.0.0' };
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 5 * GB, free: 5 * GB, total: 500 * GB });
    metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;

    expect((await sut.getAttention()).items.map((item) => item.id)).toEqual(['backup:none', 'storage', 'version']);
  });
});
