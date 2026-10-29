import { describe, expect, it } from 'vitest';
import type { AttentionItem } from 'src/dtos/attention.dto.js';
import { QueueName } from 'src/enum.js';
import {
  type BackupPlaceFacts,
  type QueueFacts,
  backupSignal,
  behindAfterDays,
  sortAttention,
  storageSignal,
  versionSignal,
  workSignal,
} from 'src/utils/attention.js';

const GB = 1_000_000_000;
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const DAILY = '0 2 * * *';

describe('attention: the drive the library is on', () => {
  it('lists nothing while the drive has room', () => {
    expect(storageSignal({ available: 400 * GB, free: 400 * GB, total: 1000 * GB })).toEqual({
      state: 'ok',
      items: [],
    });
  });

  it('warns at the chosen level, or not at all while the warning is off (FL-365)', () => {
    const disk = { available: 120 * GB, free: 120 * GB, total: 1000 * GB };
    expect(storageSignal(disk, 85).state).toBe('attention');
    expect(storageSignal(disk, 95).state).toBe('ok');
    expect(storageSignal(disk, 0).state).toBe('ok');
    // under 10 GB free needs the person whatever the warning says
    expect(storageSignal({ available: 8 * GB, free: 8 * GB, total: 1000 * GB }, 0).items[0].level).toBe('now');
  });

  it('says a drive that is 90% full is nearly full, when the person can', () => {
    const { state, items } = storageSignal({ available: 74 * GB, free: 74 * GB, total: 932 * GB });
    expect(state).toBe('attention');
    expect(items).toEqual([
      expect.objectContaining({
        id: 'storage',
        kind: 'storage',
        reason: 'nearly-full',
        level: 'soon',
        storage: { availableBytes: 74 * GB, totalBytes: 932 * GB, usedPercent: 92.1 },
      }),
    ]);
  });

  it('needs the person now when less than 10 GB is left, however big the drive', () => {
    const { items } = storageSignal({ available: 9 * GB, free: 9 * GB, total: 64 * GB });
    expect(items[0]).toMatchObject({ reason: 'out-of-space', level: 'now' });
  });

  it('judges fullness by what is used, and room by what can still be written', () => {
    // 5% reserved for the system: free counts toward "used", available is what is left to write.
    const { items } = storageSignal({ available: 40 * GB, free: 90 * GB, total: 1000 * GB });
    expect(items[0]).toMatchObject({ reason: 'nearly-full', storage: { availableBytes: 40 * GB, usedPercent: 91 } });
  });

  it('cannot judge a drive whose size could not be read', () => {
    expect(storageSignal({ available: 0, free: 0, total: 0 }).state).toBe('unknown');
  });
});

describe('attention: a missed backup', () => {
  const off: BackupPlaceFacts = { on: false, lastSuccessAt: null, setUpAt: null, runningSince: null, failedAt: null };
  const fresh: BackupPlaceFacts = { ...off, on: true, lastSuccessAt: daysAgo(1) };
  const places = (overrides: Partial<Record<'cloud' | 'buddy' | 'local', Partial<BackupPlaceFacts>>> = {}) => ({
    cloud: { ...fresh, ...overrides.cloud },
    buddy: { ...off, ...overrides.buddy },
    local: { ...fresh, ...overrides.local },
  });

  it('lists nothing while every place that is set up backed up lately', () => {
    expect(backupSignal(places(), DAILY, NOW)).toEqual({ state: 'ok', items: [] });
  });

  it('says the library is not backed up, now, when nothing keeps a copy away from home', () => {
    const { state, items } = backupSignal(places({ cloud: { on: false } }), DAILY, NOW);
    expect(state).toBe('attention');
    expect(items).toEqual([
      expect.objectContaining({
        id: 'backup:none',
        reason: 'not-backed-up',
        level: 'now',
        backup: { place: null, lastSuccessAt: null, days: null },
      }),
    ]);
  });

  it('says a place is behind after three days without a finished backup', () => {
    const { items } = backupSignal(places({ cloud: { lastSuccessAt: daysAgo(4) } }), DAILY, NOW);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'backup:cloud',
        reason: 'backup-behind',
        level: 'soon',
        since: daysAgo(4),
        backup: { place: 'cloud', lastSuccessAt: daysAgo(4), days: 4 },
      }),
    ]);
    expect(backupSignal(places({ cloud: { lastSuccessAt: daysAgo(2.9) } }), DAILY, NOW).items).toEqual([]);
  });

  it('needs the person now once a place is two weeks behind', () => {
    const { items } = backupSignal(places({ buddy: { on: true, lastSuccessAt: daysAgo(15) } }), DAILY, NOW);
    expect(items[0]).toMatchObject({ id: 'backup:buddy', reason: 'backup-behind', level: 'now' });
  });

  it('judges a place that never finished a backup from when it was set up', () => {
    const neverYet = places({ buddy: { on: true, lastSuccessAt: null, setUpAt: daysAgo(1) } });
    expect(backupSignal(neverYet, DAILY, NOW).items).toEqual([]);
    const { items } = backupSignal(
      places({ buddy: { on: true, lastSuccessAt: null, setUpAt: daysAgo(5) } }),
      DAILY,
      NOW,
    );
    expect(items[0]).toMatchObject({ id: 'backup:buddy', since: daysAgo(5), backup: { lastSuccessAt: null, days: 5 } });
  });

  it('says a last attempt that did not finish, as soon as it ends', () => {
    const { items } = backupSignal(places({ cloud: { failedAt: daysAgo(0.5) } }), DAILY, NOW);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'backup:cloud',
        reason: 'backup-failed',
        level: 'soon',
        since: daysAgo(0.5),
        backup: { place: 'cloud', lastSuccessAt: daysAgo(1), days: 1 },
      }),
    ]);
  });

  it('leaves a place alone while its backup is being made, unless that run never ended', () => {
    const running = places({ cloud: { lastSuccessAt: daysAgo(5), runningSince: daysAgo(0.1) } });
    expect(backupSignal(running, DAILY, NOW).items).toEqual([]);
    const stuck = places({ cloud: { lastSuccessAt: daysAgo(10), runningSince: daysAgo(9) } });
    expect(backupSignal(stuck, DAILY, NOW).items[0]).toMatchObject({ reason: 'backup-behind' });
  });

  it('counts the copy of the library data on this server as a place, but not as one away from home', () => {
    const { items } = backupSignal(places({ cloud: { on: false }, local: { lastSuccessAt: daysAgo(6) } }), DAILY, NOW);
    expect(items.map((item) => item.id)).toEqual(['backup:none', 'backup:local']);
  });

  it('gives a schedule that skips days the longest gap plus two before a backup is behind', () => {
    expect(behindAfterDays(DAILY)).toBe(3);
    expect(behindAfterDays('0 */6 * * *')).toBe(3);
    expect(behindAfterDays('0 2 * * 0')).toBe(9);
    expect(behindAfterDays('0 2 * * mon,thu')).toBe(6);
    expect(behindAfterDays('0 2 * * 1-5')).toBe(5);
    expect(behindAfterDays('0 2 * * fri-sun')).toBe(7);
    expect(behindAfterDays('nonsense')).toBe(3);
    const weekly = places({ cloud: { lastSuccessAt: daysAgo(6) } });
    expect(backupSignal(weekly, '0 2 * * 0', NOW).items).toEqual([]);
  });
});

describe('attention: background work that stopped', () => {
  const counts = { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 };
  const queue = (name: QueueName, overrides: Partial<QueueFacts> = {}, numbers: Partial<typeof counts> = {}) => ({
    name,
    counts: { ...counts, ...numbers },
    paused: false,
    heldByMove: false,
    ...overrides,
  });

  it('lists nothing while work runs or waits', () => {
    expect(workSignal([queue(QueueName.ThumbnailGeneration, {}, { active: 2, waiting: 120 })])).toEqual({
      state: 'ok',
      items: [],
    });
  });

  it('adds up what failed, kind by kind with the most first', () => {
    const { state, items } = workSignal([
      queue(QueueName.ThumbnailGeneration, {}, { failed: 3 }),
      queue(QueueName.VideoConversion, {}, { failed: 9 }),
      queue(QueueName.SmartSearch),
    ]);
    expect(state).toBe('attention');
    expect(items).toEqual([
      expect.objectContaining({
        id: 'work:failed',
        reason: 'work-failed',
        level: 'soon',
        work: {
          count: 12,
          queues: [
            { name: QueueName.VideoConversion, count: 9 },
            { name: QueueName.ThumbnailGeneration, count: 3 },
          ],
        },
      }),
    ]);
  });

  it('says work that is paused with items waiting behind the pause', () => {
    const { items } = workSignal([
      queue(QueueName.FaceDetection, { paused: true }, { waiting: 40, paused: 2 }),
      queue(QueueName.Ocr, { paused: true }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'work:paused',
        reason: 'work-paused',
        work: { count: 42, queues: [{ name: QueueName.FaceDetection, count: 42 }] },
      }),
    ]);
  });

  it('leaves out a pause a library move holds, which lifts by itself', () => {
    expect(
      workSignal([queue(QueueName.FaceDetection, { paused: true, heldByMove: true }, { waiting: 40 })]).items,
    ).toEqual([]);
  });
});

describe('attention: a new version', () => {
  const newer = (version: string) => version !== 'v3.2.0';

  it('lists the newest version the check found', () => {
    const { state, items } = versionSignal({
      enabled: true,
      state: { checkedAt: NOW.toISOString(), releaseVersion: 'v3.3.0' },
      current: '3.2.0',
      isNewer: newer,
    });
    expect(state).toBe('attention');
    expect(items).toEqual([
      expect.objectContaining({
        id: 'version',
        reason: 'new-version',
        level: 'soon',
        version: { current: '3.2.0', available: '3.3.0' },
      }),
    ]);
  });

  it('lists nothing while this server runs the newest version', () => {
    const state = { checkedAt: NOW.toISOString(), releaseVersion: 'v3.2.0' };
    expect(versionSignal({ enabled: true, state, current: '3.2.0', isNewer: newer })).toEqual({
      state: 'ok',
      items: [],
    });
  });

  it('is off while looking for updates is switched off, and unknown before the first look', () => {
    const state = { checkedAt: NOW.toISOString(), releaseVersion: 'v3.3.0' };
    expect(versionSignal({ enabled: false, state, current: '3.2.0', isNewer: newer }).state).toBe('off');
    expect(versionSignal({ enabled: true, state: null, current: '3.2.0', isNewer: newer }).state).toBe('unknown');
  });
});

describe('attention: the order of the list', () => {
  const at = (kind: AttentionItem['kind'], level: AttentionItem['level']) =>
    ({ id: `${kind}:${level}`, kind, level }) as AttentionItem;

  it('puts what needs the person now first, then backup, storage, work and version', () => {
    const sorted = sortAttention([
      at('version', 'soon'),
      at('work', 'soon'),
      at('storage', 'now'),
      at('backup', 'soon'),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['storage:now', 'backup:soon', 'work:soon', 'version:soon']);
  });
});
