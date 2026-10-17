/**
 * Backup in plain words (FL-362): what the Backup pages say about each place a backup is kept and
 * about the library as a whole, worked out from what the server already reports. Nothing here is
 * measured by the browser: a place's status, its last backup and its storage are the server's own
 * figures, turned into a tone and a short phrase (an i18n key with its values).
 */
import {
  CloudBackupKeyMode,
  CloudBackupLastRunStatus,
  CloudBackupRunState,
  CloudBackupTask,
  type BuddyStatusDto,
  type CloudBackupStatusResponseDto,
  type DatabaseBackupDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { backupStamp, backupTime } from '$lib/components/frameleaf/settings/backup-time';
import { buddyBackupPresentation } from '$lib/frameleaf/buddy-backup';

/** A place a backup is kept. Cloud Backup and Buddy Backup are away from home; `local` is this server. */
export type BackupPlaceId = 'cloud' | 'buddy' | 'local';

/** The order the pages list them in: away from home first. */
export const BACKUP_PLACE_IDS: readonly BackupPlaceId[] = Object.freeze(['cloud', 'buddy', 'local']);

/** The places that keep photos and videos, which the copy on this server does not. */
export const OFFSITE_PLACE_IDS: readonly BackupPlaceId[] = Object.freeze(['cloud', 'buddy']);

export type BackupTone = 'good' | 'warn' | 'bad' | 'off';

/** A phrase to translate: its key and the values it takes. */
export type Words = { key: Translations; values?: Record<string, string | number> };

export type BackupPlaceState = {
  id: BackupPlaceId;
  /** Set up and meant to be backing up. */
  on: boolean;
  tone: BackupTone;
  status: Words;
  /** When its newest finished backup was made. */
  lastAt: Date | null;
  /** A backup is being made right now. */
  running: boolean;
  /** Its newest backup is recent and nothing is wrong with it: it counts as a copy. */
  current: boolean;
};

const DAY_MS = 86_400_000;

/**
 * A backup older than this is behind. Three days, the same wait after which the server itself warns
 * that Buddy Backup is out of date; a schedule that runs less often than daily passes a longer one.
 */
export const BEHIND_AFTER_MS = 3 * DAY_MS;

const parse = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : new Date(time);
};

const off = (id: BackupPlaceId): BackupPlaceState => ({
  id,
  on: false,
  tone: 'off',
  status: { key: 'frameleaf_backup_state_off' },
  lastAt: null,
  running: false,
  current: false,
});

/** Up to date, behind, or still waiting for a first backup, from the age of the newest one. */
const byAge = (
  lastAt: Date | null,
  now: Date,
  behindAfterMs: number,
): Pick<BackupPlaceState, 'tone' | 'status' | 'current'> => {
  if (!lastAt) {
    return { tone: 'warn', status: { key: 'frameleaf_backup_state_first' }, current: false };
  }
  const age = now.getTime() - lastAt.getTime();
  if (age > behindAfterMs) {
    return {
      tone: 'warn',
      status: { key: 'frameleaf_backup_state_behind', values: { days: Math.floor(age / DAY_MS) } },
      current: false,
    };
  }
  return { tone: 'good', status: { key: 'frameleaf_backup_state_up_to_date' }, current: true };
};

const fresh = (lastAt: Date | null, now: Date, behindAfterMs: number) =>
  !!lastAt && now.getTime() - lastAt.getTime() <= behindAfterMs;

/** Cloud Backup as the server reports it. */
export const cloudPlaceState = (
  status: CloudBackupStatusResponseDto | null,
  now: Date,
  behindAfterMs = BEHIND_AFTER_MS,
): BackupPlaceState => {
  if (!status?.configured) {
    return off('cloud');
  }
  const lastAt = parse(status.lastSuccessAt);
  const base = { id: 'cloud' as const, on: true, lastAt, running: false };
  const problem = (key: Translations): BackupPlaceState => ({ ...base, tone: 'warn', status: { key }, current: false });

  if (status.keyMode === CloudBackupKeyMode.OwnMemory && !status.keyLoaded) {
    return problem('frameleaf_backup_state_needs_key');
  }
  if (status.managed?.readOnly) {
    return problem(
      status.managed.readOnlyReason === 'plan_full'
        ? 'frameleaf_backup_state_storage_full'
        : 'frameleaf_backup_state_stopped',
    );
  }
  const run = status.activeRun;
  if (run?.task === CloudBackupTask.Backup) {
    if (run.state === CloudBackupRunState.Paused || run.state === CloudBackupRunState.Pausing) {
      return problem('frameleaf_backup_state_paused');
    }
    return {
      ...base,
      running: true,
      tone: 'good',
      status: { key: 'frameleaf_backup_state_running' },
      current: fresh(lastAt, now, behindAfterMs),
    };
  }
  if (status.lastRun?.status === CloudBackupLastRunStatus.Failed) {
    return problem('frameleaf_backup_state_failed');
  }
  return { ...base, ...byAge(lastAt, now, behindAfterMs) };
};

/** What stands in the way of a Buddy Backup, by the status `buddyBackupPresentation` reads for sending. */
const BUDDY_PROBLEMS: Partial<Record<Translations, Translations>> = {
  frameleaf_backup_blocked: 'frameleaf_backup_state_buddy_blocked',
  frameleaf_backup_ended: 'frameleaf_backup_state_buddy_ended',
  frameleaf_backup_pending: 'frameleaf_backup_state_buddy_pending',
  frameleaf_backup_authorization: 'frameleaf_backup_state_buddy_sign_in',
  frameleaf_backup_recovery_only: 'frameleaf_backup_state_buddy_restore_only',
  frameleaf_backup_paused: 'frameleaf_backup_state_paused',
  frameleaf_backup_key_required: 'frameleaf_backup_state_buddy_kit',
  frameleaf_backup_waiting_peer: 'frameleaf_backup_state_buddy_unreachable',
  frameleaf_backup_waiting_quota: 'frameleaf_backup_state_buddy_full',
  frameleaf_backup_incomplete: 'frameleaf_backup_state_failed',
  frameleaf_buddy_not_configured: 'frameleaf_backup_state_buddy_not_finished',
};

/**
 * Buddy Backup as the server reports it. `linked` and `entitled` are the availability rules the app
 * already applies (the server is linked to Frameleaf Cloud, and its plan includes backup).
 */
export const buddyPlaceState = (
  status: BuddyStatusDto | null,
  access: { linked: boolean; entitled: boolean },
  now: Date,
  behindAfterMs = BEHIND_AFTER_MS,
): BackupPlaceState => {
  if (!status?.pairing) {
    return off('buddy');
  }
  const lastAt = parse(status.lastCompleteAt);
  const base = { id: 'buddy' as const, on: true, lastAt, running: false };
  const { outgoing } = buddyBackupPresentation(status, access.linked, access.entitled, now.getTime());
  const problem = BUDDY_PROBLEMS[outgoing];
  if (problem) {
    return { ...base, tone: 'warn', status: { key: problem }, current: false };
  }
  if (outgoing === 'frameleaf_backup_capturing' || outgoing === 'frameleaf_backup_sending') {
    return {
      ...base,
      running: true,
      tone: 'good',
      status: { key: 'frameleaf_backup_state_running' },
      current: fresh(lastAt, now, behindAfterMs),
    };
  }
  return { ...base, ...byAge(lastAt, now, behindAfterMs) };
};

/** A snapshot the schedule made, not one that was uploaded or kept as a safety copy before a restore. */
const isScheduledSnapshot = (filename: string) => !/^(uploaded-|restore-point-)/.test(filename);

/** The saved copies of the library data, newest first, each with the moment it was made. */
export const localSnapshots = (backups: readonly DatabaseBackupDto[]) =>
  backups
    .map((backup) => ({ ...backup, at: backupTime(backup.filename, { timezone: backup.timezone })?.at.toJSDate() }))
    .sort((a, b) => (backupStamp(b.filename) ?? '').localeCompare(backupStamp(a.filename) ?? ''));

/** The library data copy on this server: on when its setting is, and as recent as its newest snapshot. */
export const localPlaceState = (
  backups: readonly DatabaseBackupDto[] | null,
  enabled: boolean,
  now: Date,
  behindAfterMs = BEHIND_AFTER_MS,
): BackupPlaceState => {
  const newest = localSnapshots(backups ?? []).find((backup) => backup.at && isScheduledSnapshot(backup.filename));
  const lastAt = newest?.at ?? null;
  if (!enabled) {
    return { ...off('local'), lastAt };
  }
  return { id: 'local', on: true, lastAt, running: false, ...byAge(lastAt, now, behindAfterMs) };
};

export type BackupPlaces = Record<BackupPlaceId, BackupPlaceState>;

export type CoverageLine = { tone: BackupTone; value: Words; note: Words };

export type BackupSummary = {
  /**
   * `none`: nothing keeps a copy away from home. `first`: something is set up and has not finished a
   * backup yet. `attention`: a place has a problem. `running`: a backup is being made. `ok`: all well.
   */
  kind: 'none' | 'first' | 'attention' | 'running' | 'ok';
  tone: 'good' | 'warn' | 'bad';
  title: Words;
  /** Sentences, in order. */
  body: Words[];
  /** The place to open to put things right. */
  fix?: BackupPlaceId;
  /** How well the photos and videos are covered. */
  media: CoverageLine;
  /** How well the library data (albums, people, edits, settings) is covered. */
  data: CoverageLine;
};

export type BackupSayings = {
  /** A place's name. */
  name: (id: BackupPlaceId) => string;
  /** Names joined as a sentence does: "a, b and c". */
  list: (names: string[]) => string;
  /** A moment as it reads inside a sentence. */
  when: (date: Date) => string;
  /** A phrase, translated. */
  words: (words: Words) => string;
};

/** The one answer the Overview opens on, and its two coverage lines. */
export const backupSummary = (places: BackupPlaces, say: BackupSayings): BackupSummary => {
  const offsite = OFFSITE_PLACE_IDS.map((id) => places[id]).filter((place) => place.on);
  const current = offsite.filter((place) => place.current);
  const waiting = (place: BackupPlaceState) => place.status.key === 'frameleaf_backup_state_first';
  const troubled = BACKUP_PLACE_IDS.map((id) => places[id]).filter(
    (place) => place.on && place.tone !== 'good' && !waiting(place),
  );
  const names = (list: BackupPlaceState[]) => say.list(list.map((place) => say.name(place.id)));
  const pending = places.local.on || offsite.length > 0;

  const media: CoverageLine =
    offsite.length === 0
      ? {
          tone: 'bad',
          value: { key: 'frameleaf_backup_cover_none' },
          note: { key: 'frameleaf_backup_cover_only_here' },
        }
      : current.length === 0
        ? {
            tone: 'warn',
            value: { key: 'frameleaf_backup_cover_none_current' },
            note: { key: 'frameleaf_backup_cover_until_finished' },
          }
        : current.length === offsite.length
          ? {
              tone: 'good',
              value: { key: 'frameleaf_backup_cover_away', values: { count: current.length } },
              note: { key: 'frameleaf_backup_cover_places', values: { places: names(current) } },
            }
          : {
              tone: 'warn',
              value: { key: 'frameleaf_backup_cover_current', values: { count: current.length } },
              note: {
                key: 'frameleaf_backup_cover_places_not',
                values: {
                  places: names(current),
                  others: names(offsite.filter((place) => !place.current)),
                  count: offsite.length - current.length,
                },
              },
            };

  // Library data is in every backup, and in the copy on this server too.
  const dataCopies = [...(places.local.current ? [places.local] : []), ...current];
  const data: CoverageLine =
    dataCopies.length === 0
      ? {
          tone: pending ? 'warn' : 'bad',
          value: { key: pending ? 'frameleaf_backup_cover_none_current' : 'frameleaf_backup_cover_none' },
          note: { key: pending ? 'frameleaf_backup_cover_until_finished' : 'frameleaf_backup_cover_data_off' },
        }
      : {
          tone: dataCopies.length > 1 ? 'good' : 'warn',
          value: { key: 'frameleaf_backup_cover_copies', values: { count: dataCopies.length } },
          note:
            dataCopies.length === 1 && dataCopies[0].id === 'local'
              ? { key: 'frameleaf_backup_cover_data_only_here' }
              : { key: 'frameleaf_backup_cover_places', values: { places: names(dataCopies) } },
        };

  if (offsite.length === 0) {
    return {
      kind: 'none',
      tone: 'bad',
      title: { key: 'frameleaf_backup_hero_none' },
      body: [{ key: 'frameleaf_backup_hero_none_body' }],
      media,
      data,
    };
  }
  if (troubled.length > 0) {
    return {
      kind: 'attention',
      tone: 'warn',
      title: { key: 'frameleaf_backup_hero_attention', values: { count: troubled.length } },
      body: [
        ...troubled.map((place): Words => ({
          key: 'frameleaf_backup_hero_attention_place',
          values: { place: say.name(place.id), status: say.words(place.status) },
        })),
        current.length > 0
          ? {
              key: 'frameleaf_backup_hero_attention_protected',
              values: { places: names(current), count: current.length },
            }
          : { key: 'frameleaf_backup_hero_attention_unprotected' },
      ],
      fix: troubled[0].id,
      media,
      data,
    };
  }
  if (BACKUP_PLACE_IDS.some((id) => places[id].running)) {
    return {
      kind: 'running',
      tone: 'good',
      title: { key: 'frameleaf_backup_hero_running' },
      body: [{ key: 'frameleaf_backup_hero_running_body' }],
      media,
      data,
    };
  }
  if (current.length === 0) {
    return {
      kind: 'first',
      tone: 'warn',
      title: { key: 'frameleaf_backup_hero_first' },
      body: [{ key: 'frameleaf_backup_hero_first_body' }],
      media,
      data,
    };
  }
  const newest = current
    .map((place) => place.lastAt)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    kind: 'ok',
    tone: 'good',
    title: { key: 'frameleaf_backup_hero_ok' },
    body: newest ? [{ key: 'frameleaf_backup_hero_ok_body', values: { when: say.when(newest) } }] : [],
    media,
    data,
  };
};

/**
 * A moment as the Backup pages say it: "Today, 2:29 AM", "Yesterday, 2:31 AM", "8 Oct, 2:28 AM", with
 * the year once it is not this one; `sentence` gives the form that sits inside one ("today at 2:29 AM").
 * In the viewer's own time zone, as every other time in the app.
 */
export const backupWhen = (
  date: Date,
  { locale, now = new Date(), sentence = false }: { locale?: string; now?: Date; sentence?: boolean } = {},
): Words => {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  const dayOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(date)) / DAY_MS);
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
  const kind = days === 0 ? 'today' : days === 1 ? 'yesterday' : 'day';
  return {
    key: `frameleaf_backup_when_${kind}${sentence ? '_sentence' : ''}` as Translations,
    values: { time, day },
  };
};
