import {
  AttentionBackupPlace,
  AttentionCheckState,
  AttentionKind,
  AttentionLevel,
  AttentionReason,
  QueueName,
  type AttentionCheckDto,
  type AttentionItemDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  attentionCheckRows,
  attentionHero,
  attentionView,
  momentWords,
  type AttentionSayings,
} from '$lib/frameleaf/attention';

const GB = 1_000_000_000;
const NOW = new Date(2026, 9, 16, 12, 0);
const say: AttentionSayings = {
  size: (bytes) => `${Math.round(bytes / GB)} GB`,
  list: (names) => names.join(' and '),
  words: ({ key }) => key,
  locale: 'en-GB',
  now: NOW,
};
const item = (patch: Partial<AttentionItemDto>): AttentionItemDto => ({
  id: 'x',
  kind: AttentionKind.Backup,
  reason: AttentionReason.NotBackedUp,
  level: AttentionLevel.Soon,
  since: null,
  storage: null,
  backup: null,
  work: null,
  version: null,
  ...patch,
});
const check = (kind: AttentionKind, state: AttentionCheckState): AttentionCheckDto => ({ kind, state });
const allClear = [AttentionKind.Backup, AttentionKind.Storage, AttentionKind.Work, AttentionKind.Version].map((kind) =>
  check(kind, AttentionCheckState.Ok),
);

describe('what needs attention, in words (FL-421)', () => {
  it('says a library without a backup away from home needs the person now, and opens Backup', () => {
    const view = attentionView(
      item({
        id: 'backup:none',
        level: AttentionLevel.Now,
        backup: { place: null, lastSuccessAt: null, days: null },
      }),
      say,
    );
    expect(view).toMatchObject({
      tone: 'bad',
      level: { key: 'frameleaf_attention_level_now' },
      title: { key: 'frameleaf_attention_backup_none_title' },
      detail: { key: 'frameleaf_backup_hero_none_body' },
      action: { label: { key: 'frameleaf_attention_set_up_backup' }, href: '/user-settings?area=backups' },
    });
    expect(view.since).toBeUndefined();
  });

  it('names the place that is behind, when it last finished, and opens its own Backup page', () => {
    const view = attentionView(
      item({
        id: 'backup:buddy',
        reason: AttentionReason.BackupBehind,
        since: new Date(2026, 9, 12, 2, 17).toISOString(),
        backup: {
          place: AttentionBackupPlace.Buddy,
          lastSuccessAt: new Date(2026, 9, 12, 2, 17).toISOString(),
          days: 4,
        },
      }),
      say,
    );
    expect(view).toMatchObject({
      tone: 'warn',
      title: { key: 'frameleaf_attention_backup_title' },
      detail: { key: 'frameleaf_attention_backup_behind', values: { place: 'frameleaf_buddy_buddy_backup', days: 4 } },
      since: { key: 'frameleaf_attention_finished_day', values: { day: '12 Oct' } },
      action: { href: '/user-settings?area=backups&section=buddy' },
    });
  });

  it('says how old the copy of the library data on this server is', () => {
    const view = attentionView(
      item({
        reason: AttentionReason.BackupBehind,
        backup: { place: AttentionBackupPlace.Local, lastSuccessAt: NOW.toISOString(), days: 6 },
      }),
      say,
    );
    expect(view.detail).toEqual({ key: 'frameleaf_attention_backup_behind_local', values: { days: 6 } });
  });

  it('says a place that has never finished a backup, and one whose last attempt failed', () => {
    const never = attentionView(
      item({
        reason: AttentionReason.BackupBehind,
        since: new Date(2026, 9, 10).toISOString(),
        backup: { place: AttentionBackupPlace.Cloud, lastSuccessAt: null, days: 6 },
      }),
      say,
    );
    expect(never.detail.key).toBe('frameleaf_attention_backup_behind_never');
    expect(never.since?.key).toBe('frameleaf_attention_since_day');

    const failed = attentionView(
      item({
        reason: AttentionReason.BackupFailed,
        since: new Date(2026, 9, 16, 2, 30).toISOString(),
        backup: { place: AttentionBackupPlace.Cloud, lastSuccessAt: null, days: null },
      }),
      say,
    );
    expect(failed.detail).toEqual({
      key: 'frameleaf_attention_backup_failed',
      values: { place: 'frameleaf_buddy_cloud_backup' },
    });
    expect(failed.since?.key).toBe('frameleaf_attention_since_today');
  });

  it('says how much room the drive has left, and opens the Overview', () => {
    const storage = { availableBytes: 74 * GB, totalBytes: 932 * GB, usedPercent: 92.1 };
    expect(
      attentionView(item({ kind: AttentionKind.Storage, reason: AttentionReason.NearlyFull, storage }), say),
    ).toMatchObject({
      icon: expect.any(String),
      title: { key: 'frameleaf_attention_storage_title' },
      detail: { key: 'frameleaf_attention_storage_detail', values: { left: '74 GB', total: '932 GB' } },
      action: { label: { key: 'frameleaf_attention_open_overview' }, href: '/user-settings?area=overview' },
    });
    expect(
      attentionView(item({ kind: AttentionKind.Storage, reason: AttentionReason.OutOfSpace, storage }), say).title.key,
    ).toBe('frameleaf_attention_storage_out_title');
  });

  it('names the kinds of work that failed or are paused as Background work names them', () => {
    const failed = attentionView(
      item({
        kind: AttentionKind.Work,
        reason: AttentionReason.WorkFailed,
        work: {
          count: 12,
          queues: [
            { name: QueueName.VideoConversion, count: 9 },
            { name: QueueName.MetadataExtraction, count: 3 },
          ],
        },
      }),
      say,
    );
    expect(failed).toMatchObject({
      title: { key: 'frameleaf_attention_work_failed_title', values: { count: 12 } },
      detail: { values: { work: expect.stringContaining('frameleaf_work_metadata_extraction') } },
      action: { href: '/user-settings?area=processing&section=queues' },
    });

    const paused = attentionView(
      item({
        kind: AttentionKind.Work,
        reason: AttentionReason.WorkPaused,
        work: { count: 42, queues: [{ name: QueueName.FaceDetection, count: 42 }] },
      }),
      say,
    );
    expect(paused.detail).toEqual({
      key: 'frameleaf_attention_work_paused',
      values: { work: 'frameleaf_work_face_detection', count: 42 },
    });
  });

  it('names a new version and opens Updates', () => {
    const view = attentionView(
      item({
        kind: AttentionKind.Version,
        reason: AttentionReason.NewVersion,
        version: { current: '3.2.0', available: '3.3.0' },
      }),
      say,
    );
    expect(view).toMatchObject({
      detail: { key: 'frameleaf_attention_version_detail', values: { version: '3.3.0' } },
      action: { href: '/user-settings?area=server&section=version-check' },
    });
  });

  describe('the answer at the top', () => {
    it('counts what needs attention, and is red when something needs the person now', () => {
      expect(attentionHero([item({}), item({ level: AttentionLevel.Now })], allClear, say)).toEqual({
        tone: 'bad',
        title: { key: 'frameleaf_attention_hero_some', values: { count: 2 } },
        body: { key: 'frameleaf_attention_hero_some_body' },
      });
      expect(attentionHero([item({})], allClear, say).tone).toBe('warn');
    });

    it('says nothing needs attention only when every check could be read', () => {
      expect(attentionHero([], allClear, say).title.key).toBe('frameleaf_attention_hero_none');
      const unread = [
        check(AttentionKind.Backup, AttentionCheckState.Ok),
        check(AttentionKind.Storage, AttentionCheckState.Unknown),
        check(AttentionKind.Work, AttentionCheckState.Unknown),
        check(AttentionKind.Version, AttentionCheckState.Ok),
      ];
      expect(attentionHero([], unread, say)).toEqual({
        tone: 'quiet',
        title: { key: 'frameleaf_attention_hero_unread' },
        body: {
          key: 'frameleaf_attention_hero_unread_body',
          values: { checks: 'frameleaf_attention_check_storage_name and frameleaf_attention_check_work_name' },
        },
      });
    });

    it('does not count updates that have not been looked for yet as a check that failed', () => {
      const notYet = allClear.map((row) =>
        row.kind === AttentionKind.Version ? check(row.kind, AttentionCheckState.Unknown) : row,
      );
      expect(attentionHero([], notYet, say).title.key).toBe('frameleaf_attention_hero_none');
    });
  });

  it('lists the checks in the prototype order, each with how it came out', () => {
    const rows = attentionCheckRows([
      check(AttentionKind.Backup, AttentionCheckState.Attention),
      check(AttentionKind.Storage, AttentionCheckState.Ok),
      check(AttentionKind.Work, AttentionCheckState.Unknown),
      check(AttentionKind.Version, AttentionCheckState.Unknown),
    ]);
    expect(rows.map((row) => [row.kind, row.state.tone, row.state.words.key])).toEqual([
      [AttentionKind.Storage, 'good', 'frameleaf_attention_state_ok'],
      [AttentionKind.Backup, 'warn', 'frameleaf_attention_state_attention'],
      [AttentionKind.Work, 'off', 'frameleaf_attention_state_unknown'],
      [AttentionKind.Version, 'off', 'frameleaf_attention_state_not_yet'],
    ]);
    expect(rows[1].link.href).toBe('/user-settings?area=backups');
  });

  it('says a moment as today, yesterday or the day, with the year once it is not this one', () => {
    expect(momentWords('since', new Date(2026, 9, 16, 7, 30), say).key).toBe('frameleaf_attention_since_today');
    expect(momentWords('finished', new Date(2026, 9, 15, 2, 17), say).key).toBe(
      'frameleaf_attention_finished_yesterday',
    );
    expect(momentWords('since', new Date(2025, 11, 30, 2, 17), say).values?.day).toContain('2025');
  });
});
