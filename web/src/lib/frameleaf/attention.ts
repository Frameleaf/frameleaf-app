/**
 * "What needs your attention" in plain words (FL-421). The server works out what needs an
 * administrator (`getAttention`) and sends the facts; this module says each one the way a household
 * would, and names the page that puts it right. The Notifications page uses it, and so can the
 * Overview's "needs you now" list (FL-363): one wording wherever the same thing is said.
 */
import {
  AttentionBackupPlace,
  AttentionCheckState,
  AttentionKind,
  AttentionLevel,
  AttentionReason,
  type AttentionCheckDto,
  type AttentionItemDto,
  type QueueName,
} from '@frameleaf/sdk';
import { mdiHarddisk, mdiProgressAlert, mdiShieldAlertOutline, mdiUpdate } from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
import type { BackupPlaceId } from '$lib/frameleaf/backup-overview';
import { jobQueue } from '$lib/frameleaf/job-queues';
import { backupPageUrl, commandCenterUrl } from '$lib/frameleaf/settings-areas';

// Same union as Pill.svelte's KitTone; .ts files can't import types from a .svelte module script.
type KitTone = 'good' | 'warn' | 'bad' | 'off';

/** A phrase to translate: its key and the values it takes. */
export type Words = { key: Translations; values?: Record<string, string | number> };

/** One thing that needs the administrator, ready to show. */
export type AttentionView = {
  id: string;
  kind: AttentionKind;
  icon: string;
  /** `bad` for what needs them now, `warn` for what can wait until they have a moment. */
  tone: Extract<KitTone, 'warn' | 'bad'>;
  /** "Now" or "When you can". */
  level: Words;
  title: Words;
  detail: Words;
  /** When it started ("Since today, 7:30 AM") or, for a backup that is behind, when the last one finished. */
  since?: Words;
  /** The page that puts it right. */
  action: { label: Words; href: string };
};

/** What the page turns into words before they go into a sentence. */
export type AttentionSayings = {
  /** A size in decimal units: "74 GB". */
  size: (bytes: number) => string;
  /** Names joined as a sentence joins them: "a, b and c". */
  list: (names: string[]) => string;
  /** A translated phrase. */
  words: (words: Words) => string;
  locale?: string;
  /** The moment "today" is judged from. */
  now?: Date;
};

const DAY_MS = 86_400_000;

/**
 * "Since today, 7:30 AM", "Last finished yesterday, 2:17 AM", "Since 8 Oct, 2:28 AM": a moment in
 * the viewer's own time zone, with the year once it is not this one, as the Backup pages say it.
 */
export const momentWords = (
  phrase: 'since' | 'finished',
  date: Date,
  { locale, now = new Date() }: Pick<AttentionSayings, 'locale' | 'now'> = {},
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
  return { key: `frameleaf_attention_${phrase}_${kind}` as Translations, values: { time, day } };
};

const ICONS: Record<AttentionKind, string> = {
  [AttentionKind.Backup]: mdiShieldAlertOutline,
  [AttentionKind.Storage]: mdiHarddisk,
  [AttentionKind.Work]: mdiProgressAlert,
  [AttentionKind.Version]: mdiUpdate,
};

/** The kinds of work, as Background work names them. */
export const workName = (name: QueueName): Words => {
  const definition = jobQueue(name);
  return definition
    ? { key: `frameleaf_work_${definition.key}` as Translations }
    : { key: 'frameleaf_computers_page_queues' };
};

/** Each place a backup is kept, as the Backup pages name it and the page of its own there. */
const PLACES: Record<AttentionBackupPlace, BackupPlaceId> = {
  [AttentionBackupPlace.Cloud]: 'cloud',
  [AttentionBackupPlace.Buddy]: 'buddy',
  [AttentionBackupPlace.Local]: 'local',
};

const parse = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time);
};

const words = (key: Translations, values?: Words['values']): Words => ({ key, values });

/** What one item says, and where it sends the administrator. */
export const attentionView = (item: AttentionItemDto, say: AttentionSayings): AttentionView => {
  const now = item.level === AttentionLevel.Now;
  const backup = item.backup;
  const placeId = backup?.place ? PLACES[backup.place] : undefined;
  const base = {
    id: item.id,
    kind: item.kind,
    // A backup place is drawn as the Backup pages draw it (the prototype's handshake for Buddy Backup).
    icon: placeId ? BACKUP_PLACE_COPY[placeId].icon : ICONS[item.kind],
    tone: now ? ('bad' as const) : ('warn' as const),
    level: words(now ? 'frameleaf_attention_level_now' : 'frameleaf_attention_level_soon'),
  };
  const started = parse(item.since);
  const since = started ? momentWords('since', started, say) : undefined;
  const place = placeId ? say.words({ key: BACKUP_PLACE_COPY[placeId].name }) : '';
  const toBackup = { label: words('frameleaf_attention_open_backup'), href: backupPageUrl(placeId) };
  const drive = item.storage
    ? { left: say.size(item.storage.availableBytes), total: say.size(item.storage.totalBytes) }
    : { left: '', total: '' };
  const toOverview = { label: words('frameleaf_attention_open_overview'), href: commandCenterUrl('overview') };
  const work = item.work;
  const kinds = say.list((work?.queues ?? []).map((queue) => say.words(workName(queue.name))));
  const toWork = { label: words('frameleaf_attention_open_work'), href: commandCenterUrl('processing', 'queues') };

  switch (item.reason) {
    case AttentionReason.NotBackedUp: {
      return {
        ...base,
        title: words('frameleaf_attention_backup_none_title'),
        detail: words('frameleaf_backup_hero_none_body'),
        action: { label: words('frameleaf_attention_set_up_backup'), href: backupPageUrl() },
      };
    }
    case AttentionReason.BackupFailed: {
      return {
        ...base,
        title: words('frameleaf_attention_backup_title'),
        detail: words('frameleaf_attention_backup_failed', { place }),
        since,
        action: toBackup,
      };
    }
    case AttentionReason.BackupBehind: {
      const finished = parse(backup?.lastSuccessAt);
      return {
        ...base,
        title: words('frameleaf_attention_backup_title'),
        detail:
          backup?.place === AttentionBackupPlace.Local
            ? words('frameleaf_attention_backup_behind_local', { days: backup.days ?? 0 })
            : words(finished ? 'frameleaf_attention_backup_behind' : 'frameleaf_attention_backup_behind_never', {
                place,
                days: backup?.days ?? 0,
              }),
        since: finished ? momentWords('finished', finished, say) : since,
        action: toBackup,
      };
    }
    case AttentionReason.OutOfSpace: {
      return {
        ...base,
        title: words('frameleaf_attention_storage_out_title'),
        detail: words('frameleaf_attention_storage_out', drive),
        action: toOverview,
      };
    }
    case AttentionReason.NearlyFull: {
      return {
        ...base,
        title: words('frameleaf_attention_storage_title'),
        detail: words('frameleaf_attention_storage_detail', drive),
        action: toOverview,
      };
    }
    case AttentionReason.WorkFailed: {
      return {
        ...base,
        title: words('frameleaf_attention_work_failed_title', { count: work?.count ?? 0 }),
        detail: words('frameleaf_attention_work_failed', { work: kinds }),
        action: toWork,
      };
    }
    case AttentionReason.WorkPaused: {
      return {
        ...base,
        title: words('frameleaf_attention_work_paused_title'),
        detail: words('frameleaf_attention_work_paused', { work: kinds, count: work?.count ?? 0 }),
        action: toWork,
      };
    }
    case AttentionReason.NewVersion: {
      return {
        ...base,
        title: words('frameleaf_attention_version_title'),
        detail: words('frameleaf_attention_version_detail', { version: item.version?.available ?? '' }),
        action: { label: words('frameleaf_attention_open_updates'), href: commandCenterUrl('server', 'version-check') },
      };
    }
  }
};

/** The answer the page opens on. */
export type AttentionHero = { tone: 'good' | 'warn' | 'bad' | 'quiet'; title: Words; body: Words };

export const attentionHero = (
  items: readonly AttentionItemDto[],
  checks: readonly AttentionCheckDto[],
  say: Pick<AttentionSayings, 'list' | 'words'>,
): AttentionHero => {
  if (items.length > 0) {
    return {
      tone: items.some((item) => item.level === AttentionLevel.Now) ? 'bad' : 'warn',
      title: words('frameleaf_attention_hero_some', { count: items.length }),
      body: words('frameleaf_attention_hero_some_body'),
    };
  }
  // Updates that have not been looked for yet are not a check that failed (see `checkState`).
  const unread = checks.filter(
    (check) => check.state === AttentionCheckState.Unknown && check.kind !== AttentionKind.Version,
  );
  if (unread.length > 0) {
    return {
      tone: 'quiet',
      title: words('frameleaf_attention_hero_unread'),
      body: words('frameleaf_attention_hero_unread_body', {
        checks: say.list(unread.map((check) => say.words(CHECK_ROWS[check.kind].name))),
      }),
    };
  }
  return {
    tone: 'good',
    title: words('frameleaf_attention_hero_none'),
    body: words('frameleaf_attention_hero_none_body'),
  };
};

/** "What Frameleaf looks for": each check, what it watches for, and where it is looked after. */
export type AttentionCheckRow = {
  kind: AttentionKind;
  /** The check's short name, for a sentence such as "The drive couldn't be read". */
  name: Words;
  label: Words;
  help: Words;
  link: { text: Words; href: string };
};

const CHECK_ROWS: Record<AttentionKind, AttentionCheckRow> = {
  [AttentionKind.Storage]: {
    kind: AttentionKind.Storage,
    name: words('frameleaf_attention_check_storage_name'),
    label: words('frameleaf_attention_check_storage'),
    help: words('frameleaf_attention_check_storage_help'),
    link: { text: words('frameleaf_attention_check_storage_link'), href: commandCenterUrl('overview') },
  },
  [AttentionKind.Backup]: {
    kind: AttentionKind.Backup,
    name: words('frameleaf_attention_check_backup_name'),
    label: words('frameleaf_attention_check_backup'),
    help: words('frameleaf_attention_check_backup_help'),
    link: { text: words('frameleaf_attention_check_backup_link'), href: backupPageUrl() },
  },
  [AttentionKind.Work]: {
    kind: AttentionKind.Work,
    name: words('frameleaf_attention_check_work_name'),
    label: words('frameleaf_attention_check_work'),
    help: words('frameleaf_attention_check_work_help'),
    link: { text: words('frameleaf_attention_check_work_link'), href: commandCenterUrl('processing', 'queues') },
  },
  [AttentionKind.Version]: {
    kind: AttentionKind.Version,
    name: words('frameleaf_attention_check_version_name'),
    label: words('frameleaf_attention_check_version'),
    help: words('frameleaf_attention_check_version_help'),
    link: { text: words('frameleaf_attention_check_version_link'), href: commandCenterUrl('server', 'version-check') },
  },
};

/** The prototype's order for these rows: storage, backup, work, version. */
const CHECK_ORDER = [AttentionKind.Storage, AttentionKind.Backup, AttentionKind.Work, AttentionKind.Version];

const CHECK_STATES: Record<AttentionCheckState, { tone: KitTone; words: Words }> = {
  [AttentionCheckState.Ok]: { tone: 'good', words: words('frameleaf_attention_state_ok') },
  [AttentionCheckState.Attention]: { tone: 'warn', words: words('frameleaf_attention_state_attention') },
  [AttentionCheckState.Off]: { tone: 'off', words: words('frameleaf_attention_state_off') },
  [AttentionCheckState.Unknown]: { tone: 'off', words: words('frameleaf_attention_state_unknown') },
};

/**
 * How one check came out, as a status word and its tone. The version check is unknown until it has
 * looked for updates once, which is "not checked yet" rather than a check that could not be read.
 */
export const checkState = (kind: AttentionKind, state: AttentionCheckState) =>
  kind === AttentionKind.Version && state === AttentionCheckState.Unknown
    ? { tone: 'off' as const, words: words('frameleaf_attention_state_not_yet') }
    : CHECK_STATES[state];

export const attentionCheckRows = (checks: readonly AttentionCheckDto[]) =>
  CHECK_ORDER.map((kind) => ({
    ...CHECK_ROWS[kind],
    state: checkState(kind, checks.find((check) => check.kind === kind)?.state ?? AttentionCheckState.Unknown),
  }));
