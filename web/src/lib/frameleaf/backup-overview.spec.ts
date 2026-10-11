import type { BuddyStatusDto, CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  backupSummary,
  backupWhen,
  buddyPlaceState,
  cloudPlaceState,
  localPlaceState,
  type BackupPlaces,
  type BackupSayings,
} from '$lib/frameleaf/backup-overview';
import { restoreDates } from '$lib/frameleaf/backup-restore';

const now = new Date('2026-10-10T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const cloud = (patch: Record<string, unknown> = {}) =>
  ({
    configured: true,
    keyMode: 'server',
    keyLoaded: true,
    managed: null,
    activeRun: null,
    lastRun: null,
    lastSuccessAt: hoursAgo(10),
    ...patch,
  }) as unknown as CloudBackupStatusResponseDto;

const buddy = (patch: Record<string, unknown> = {}) =>
  ({
    enabled: true,
    instanceId: 'me',
    pairing: { state: 'active', vaults: [] },
    settings: { pausedSending: false, pausedReceiving: false },
    recoveryVerified: true,
    keyFingerprint: 'key',
    lastCompleteAt: hoursAgo(10),
    run: null,
    ...patch,
  }) as unknown as BuddyStatusDto;

const access = { linked: true, entitled: true };
const snapshot = (stamp: string, prefix = '') => ({
  filename: `${prefix}frameleaf-db-backup-${stamp}-v3.2.0-pg19.0.sql.gz`,
  filesize: 1024,
  timezone: 'UTC',
});

const say: BackupSayings = {
  name: (id) => ({ cloud: 'Cloud Backup', buddy: 'Buddy Backup', local: 'On this server' })[id],
  list: (names) => names.join(' and '),
  when: () => 'today at 2:00 AM',
  words: ({ key }) => key,
};
const places = (patch: Partial<BackupPlaces> = {}): BackupPlaces => ({
  cloud: cloudPlaceState(cloud(), now),
  buddy: buddyPlaceState(buddy(), access, now),
  local: localPlaceState([snapshot('20261010T020000')], true, now),
  ...patch,
});

describe('a place a backup is kept (FL-362)', () => {
  it('is off until it is set up', () => {
    expect(cloudPlaceState(null, now)).toMatchObject({ on: false, tone: 'off', current: false });
    expect(cloudPlaceState(cloud({ configured: false }), now).on).toBe(false);
    expect(buddyPlaceState(buddy({ pairing: null }), access, now).on).toBe(false);
  });

  it('is up to date while its newest backup is recent, and behind after three days', () => {
    expect(cloudPlaceState(cloud(), now)).toMatchObject({ tone: 'good', current: true });
    expect(cloudPlaceState(cloud({ lastSuccessAt: hoursAgo(80) }), now)).toMatchObject({
      tone: 'warn',
      current: false,
      status: { key: 'frameleaf_backup_state_behind', values: { days: 3 } },
    });
    // A schedule that runs weekly is given longer before it counts as behind.
    expect(cloudPlaceState(cloud({ lastSuccessAt: hoursAgo(80) }), now, 8 * 86_400_000).current).toBe(true);
  });

  it('says what stands in the way before it says how old the backup is', () => {
    const key = (status: CloudBackupStatusResponseDto) => cloudPlaceState(status, now).status.key;
    expect(key(cloud({ keyMode: 'own-memory', keyLoaded: false }))).toBe('frameleaf_backup_state_needs_key');
    expect(key(cloud({ managed: { readOnly: true, readOnlyReason: 'plan_full' } }))).toBe(
      'frameleaf_backup_state_storage_full',
    );
    expect(key(cloud({ managed: { readOnly: true, readOnlyReason: 'new' } }))).toBe('frameleaf_backup_state_stopped');
    expect(key(cloud({ lastRun: { status: 'failed' } }))).toBe('frameleaf_backup_state_failed');
    expect(key(cloud({ lastSuccessAt: null }))).toBe('frameleaf_backup_state_first');
  });

  it('is backing up while a run is under way, and still counts its last finished backup', () => {
    const running = cloudPlaceState(cloud({ activeRun: { task: 'backup', state: 'running' } }), now);
    expect(running).toMatchObject({ running: true, tone: 'good', current: true });
    // Checking the backup is not making one.
    expect(cloudPlaceState(cloud({ activeRun: { task: 'verify', state: 'running' } }), now).running).toBe(false);
    expect(buddyPlaceState(buddy({ run: { state: 'sending' } }), access, now).running).toBe(true);
  });

  it('reads Buddy Backup trouble in plain words', () => {
    const key = (status: BuddyStatusDto, who = access) => buddyPlaceState(status, who, now).status.key;
    expect(key(buddy({ run: { state: 'waiting-peer' } }))).toBe('frameleaf_backup_state_buddy_unreachable');
    expect(key(buddy({ run: { state: 'waiting-quota' } }))).toBe('frameleaf_backup_state_buddy_full');
    expect(key(buddy({ settings: { pausedSending: true } }))).toBe('frameleaf_backup_state_paused');
    expect(key(buddy({ pairing: { state: 'ended', vaults: [] } }))).toBe('frameleaf_backup_state_buddy_ended');
    expect(key(buddy(), { linked: false, entitled: false })).toBe('frameleaf_backup_state_buddy_sign_in');
    expect(key(buddy())).toBe('frameleaf_backup_state_up_to_date');
  });

  it('dates the copy on this server by its newest scheduled snapshot, not an upload or a safety copy', () => {
    const saved = [
      snapshot('20261009T020000'),
      snapshot('20261010T110000', 'uploaded-'),
      snapshot('20261010T100000', 'restore-point-'),
    ];
    const state = localPlaceState(saved, true, now);
    expect(state.lastAt?.toISOString()).toBe('2026-10-09T02:00:00.000Z');
    expect(state.current).toBe(true);
    expect(localPlaceState(saved, false, now)).toMatchObject({ on: false, tone: 'off' });
    expect(localPlaceState([], true, now).status.key).toBe('frameleaf_backup_state_first');
  });
});

describe('the one answer (FL-362)', () => {
  it('says the library is backed up when every place is current', () => {
    const summary = backupSummary(places(), say);
    expect(summary).toMatchObject({ kind: 'ok', tone: 'good', title: { key: 'frameleaf_backup_hero_ok' } });
    expect(summary.media).toMatchObject({ tone: 'good', value: { values: { count: 2 } } });
    expect(summary.data.value.values).toEqual({ count: 3 });
    expect(summary.data.note.values).toEqual({ places: 'On this server and Cloud Backup and Buddy Backup' });
  });

  it('says there is no backup away from home when nothing is set up', () => {
    const summary = backupSummary(
      places({ cloud: cloudPlaceState(null, now), buddy: buddyPlaceState(null, access, now) }),
      say,
    );
    expect(summary).toMatchObject({ kind: 'none', tone: 'bad', title: { key: 'frameleaf_backup_hero_none' } });
    expect(summary.media).toMatchObject({ tone: 'bad', value: { key: 'frameleaf_backup_cover_none' } });
    expect(summary.data).toMatchObject({ tone: 'warn', note: { key: 'frameleaf_backup_cover_data_only_here' } });
  });

  it('names the backup that needs attention, and says the library is still protected by the other', () => {
    const summary = backupSummary(
      places({ buddy: buddyPlaceState(buddy({ run: { state: 'waiting-peer' } }), access, now) }),
      say,
    );
    expect(summary).toMatchObject({ kind: 'attention', tone: 'warn', fix: 'buddy' });
    expect(summary.title.values).toEqual({ count: 1 });
    expect(summary.body.map(({ key }) => key)).toEqual([
      'frameleaf_backup_hero_attention_place',
      'frameleaf_backup_hero_attention_protected',
    ]);
    expect(summary.media).toMatchObject({ tone: 'warn', value: { key: 'frameleaf_backup_cover_current' } });
  });

  it('says so when the one backup away from home is the one in trouble', () => {
    const summary = backupSummary(
      places({
        cloud: cloudPlaceState(null, now),
        buddy: buddyPlaceState(buddy({ run: { state: 'incomplete' } }), access, now),
      }),
      say,
    );
    expect(summary.body.at(-1)?.key).toBe('frameleaf_backup_hero_attention_unprotected');
    expect(summary.media.value.key).toBe('frameleaf_backup_cover_none_current');
  });

  it('waits for a first backup without calling it a fault, and reports one under way', () => {
    const first = backupSummary(
      places({
        cloud: cloudPlaceState(cloud({ lastSuccessAt: null }), now),
        buddy: buddyPlaceState(null, access, now),
      }),
      say,
    );
    expect(first).toMatchObject({ kind: 'first', tone: 'warn' });
    const running = backupSummary(
      places({ cloud: cloudPlaceState(cloud({ activeRun: { task: 'backup', state: 'running' } }), now) }),
      say,
    );
    expect(running).toMatchObject({ kind: 'running', tone: 'good' });
  });
});

describe('how a moment is said (FL-362)', () => {
  const at = (iso: string, sentence = false) =>
    backupWhen(new Date(iso), { locale: 'en-CA', now: new Date(2026, 9, 10, 12), sentence });

  it('uses today and yesterday, then the day, with the year once it is another one', () => {
    expect(at(new Date(2026, 9, 10, 2, 29).toISOString())).toEqual({
      key: 'frameleaf_backup_when_today',
      values: { time: '2:29 a.m.', day: 'Oct 10' },
    });
    expect(at(new Date(2026, 9, 9, 23, 59).toISOString()).key).toBe('frameleaf_backup_when_yesterday');
    expect(at(new Date(2026, 9, 8, 2).toISOString()).key).toBe('frameleaf_backup_when_day');
    expect(at(new Date(2025, 11, 31, 2).toISOString()).values?.day).toBe('Dec 31, 2025');
    expect(at(new Date(2026, 9, 10, 2).toISOString(), true).key).toBe('frameleaf_backup_when_today_sentence');
  });
});

describe('dates a library can go back to (FL-362)', () => {
  it('lists one row a day, newest first, with the places that hold a backup from it', () => {
    const day = (d: number, h: number) => new Date(2026, 9, d, h);
    const dates = restoreDates(
      [
        { place: 'local', at: day(10, 2) },
        { place: 'buddy', at: day(10, 3) },
        { place: 'cloud', at: day(10, 4) },
        { place: 'cloud', at: day(9, 4) },
        { place: 'local', at: day(8, 2) },
        { place: 'local', at: new Date('nonsense') },
      ],
      2,
    );
    expect(dates).toHaveLength(2);
    expect(dates[0]).toMatchObject({ newest: day(10, 4), places: ['cloud', 'buddy', 'local'] });
    expect(dates[1].places).toEqual(['cloud']);
  });
});
