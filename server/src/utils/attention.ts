/**
 * FL-421: the rules for what needs an administrator, one function per kind of check. Each takes the
 * facts the server already keeps and says how the check came out and what, if anything, to list.
 * `AttentionService` reads the facts; nothing here touches a repository.
 */
import type { QueueName } from 'src/enum.js';
import type { JobCounts, VersionCheckMetadata } from 'src/types.js';
import {
  ATTENTION_BACKUP_PLACES,
  ATTENTION_KINDS,
  type AttentionBackupPlace,
  type AttentionCheckState,
  type AttentionItem,
} from 'src/dtos/attention.dto.js';

/** How a check came out, and what it lists. */
export type SignalResult = { state: AttentionCheckState; items: AttentionItem[] };

const DAY_MS = 86_400_000;
const GB = 1_000_000_000;

/** A drive this full is nearly full: there is still time to make room. */
export const NEARLY_FULL_PERCENT = 90;
/** Less room than this is a few days of photos at most: it needs the person now. */
export const OUT_OF_SPACE_BYTES = 10 * GB;
/** A backup this many days behind needs the person now, not when they can. */
export const BACKUP_URGENT_DAYS = 14;
/** The wait before a backup counts as behind, when the schedule runs every day or more often. */
export const BACKUP_BEHIND_DAYS = 3;

type ItemFields = Pick<AttentionItem, 'id' | 'kind' | 'reason' | 'level'> & Partial<AttentionItem>;
const item = (fields: ItemFields): AttentionItem => ({
  since: null,
  storage: null,
  backup: null,
  work: null,
  version: null,
  ...fields,
});

const outcome = (items: AttentionItem[]): SignalResult => ({ state: items.length > 0 ? 'attention' : 'ok', items });

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

// ── Storage ─────────────────────────────────────────────────────────────────────────────────────────

/** The drive the library is on, as `StorageRepository.checkDiskUsage` reads it. */
export type DiskFacts = { available: number; free: number; total: number };

export const storageSignal = (disk: DiskFacts): SignalResult => {
  if (!(disk.total > 0)) {
    return { state: 'unknown', items: [] };
  }
  const usedPercent = Math.min(100, Math.max(0, ((disk.total - disk.free) / disk.total) * 100));
  const storage = {
    availableBytes: Math.max(0, Math.floor(disk.available)),
    totalBytes: Math.floor(disk.total),
    usedPercent: Math.round(usedPercent * 10) / 10,
  };
  if (disk.available < OUT_OF_SPACE_BYTES) {
    return outcome([item({ id: 'storage', kind: 'storage', reason: 'out-of-space', level: 'now', storage })]);
  }
  if (usedPercent >= NEARLY_FULL_PERCENT) {
    return outcome([item({ id: 'storage', kind: 'storage', reason: 'nearly-full', level: 'soon', storage })]);
  }
  return outcome([]);
};

// ── Backup ──────────────────────────────────────────────────────────────────────────────────────────

/** What the server records about one place a backup is kept. */
export type BackupPlaceFacts = {
  /** Set up and meant to be backing up. */
  on: boolean;
  /** When it last finished a backup. */
  lastSuccessAt: string | null;
  /** When it was set up, to judge a place that has never finished one. */
  setUpAt: string | null;
  /** When the backup being made right now started. */
  runningSince: string | null;
  /** When its last attempt ended without finishing. */
  failedAt: string | null;
};

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const dayOf = (text: string): number | undefined => {
  const named = DAY_NAMES.indexOf(text.toLowerCase());
  if (named !== -1) {
    return named;
  }
  if (!/^\d$/.test(text)) {
    return undefined;
  }
  const day = Number(text);
  return day <= 7 ? day % 7 : undefined;
};

/** The days of the week a schedule runs on, or null when it runs every day (or is not understood). */
const scheduleDays = (cronExpression: string): number[] | null => {
  const field = cronExpression.trim().split(/\s+/, 5)[4];
  if (!field || field === '*' || field === '?') {
    return null;
  }
  const days = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      return null;
    }
    const [from, to, extra] = part.split('-', 3);
    const first = dayOf(from);
    // A range may end on Sunday, written 7 or "sun", after Saturday.
    const end = to === undefined ? first : ['7', 'sun'].includes(to.toLowerCase()) ? 7 : dayOf(to);
    if (extra !== undefined || first === undefined || end === undefined || end < first) {
      return null;
    }
    for (let day = first; day <= end; day++) {
      days.add(day % 7);
    }
  }
  return [...days].toSorted((a, b) => a - b);
};

/**
 * How many days a backup may be old before it counts as behind: three, as the Backup page and Buddy
 * Backup's own warning use, or the longest gap between two chosen days plus two for a schedule
 * that does not run every day (the web's `behindAfterMs`).
 */
export const behindAfterDays = (cronExpression: string): number => {
  const days = scheduleDays(cronExpression);
  if (!days || days.length === 0) {
    return BACKUP_BEHIND_DAYS;
  }
  const gaps = days.map((day, index) => (days[(index + 1) % days.length] - day + 7) % 7 || 7);
  return Math.max(BACKUP_BEHIND_DAYS, Math.max(...gaps) + 2);
};

/**
 * A backup is missed when a place that is set up has not finished one for longer than the schedule
 * allows, or its last attempt did not finish. With neither Cloud Backup nor Buddy Backup set up,
 * nothing keeps a copy away from home: the library is not backed up, which needs the person now.
 * A place whose backup is being made is left alone until that one ends.
 */
export const backupSignal = (
  places: Record<AttentionBackupPlace, BackupPlaceFacts>,
  cronExpression: string,
  now: Date,
): SignalResult => {
  const items: AttentionItem[] = [];
  if (!places.cloud.on && !places.buddy.on) {
    items.push(
      item({
        id: 'backup:none',
        kind: 'backup',
        reason: 'not-backed-up',
        level: 'now',
        backup: { place: null, lastSuccessAt: null, days: null },
      }),
    );
  }
  const behindMs = behindAfterDays(cronExpression) * DAY_MS;
  for (const place of ATTENTION_BACKUP_PLACES) {
    const facts = places[place];
    if (!facts.on) {
      continue;
    }
    const running = time(facts.runningSince);
    // A run that started long ago and never ended is not taken at its word.
    if (running !== null && now.getTime() - running <= behindMs) {
      continue;
    }
    const lastSuccess = time(facts.lastSuccessAt);
    const days = lastSuccess === null ? null : Math.max(0, Math.floor((now.getTime() - lastSuccess) / DAY_MS));
    const backup = { place, lastSuccessAt: facts.lastSuccessAt, days };
    const failed = time(facts.failedAt);
    if (failed !== null) {
      items.push(
        item({
          id: `backup:${place}`,
          kind: 'backup',
          reason: 'backup-failed',
          level: days !== null && days >= BACKUP_URGENT_DAYS ? 'now' : 'soon',
          since: new Date(failed).toISOString(),
          backup,
        }),
      );
      continue;
    }
    const from = lastSuccess ?? time(facts.setUpAt);
    if (from === null || now.getTime() - from <= behindMs) {
      continue;
    }
    const age = Math.floor((now.getTime() - from) / DAY_MS);
    items.push(
      item({
        id: `backup:${place}`,
        kind: 'backup',
        reason: 'backup-behind',
        level: age >= BACKUP_URGENT_DAYS ? 'now' : 'soon',
        since: new Date(from).toISOString(),
        backup: { ...backup, days: age },
      }),
    );
  }
  return outcome(items);
};

// ── Background work ─────────────────────────────────────────────────────────────────────────────────

/** One kind of work as the job store reports it. */
export type QueueFacts = {
  name: QueueName;
  counts: JobCounts;
  paused: boolean;
  /** Paused by a library move, which starts it again by itself when the move ends. */
  heldByMove: boolean;
};

const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;

/**
 * Work that stopped and cannot carry on by itself: items that failed (they stay failed until someone
 * retries or clears them), and work paused with items waiting behind the pause. A pause a library
 * move holds lifts by itself and is not listed.
 */
export const workSignal = (queues: QueueFacts[]): SignalResult => {
  const items: AttentionItem[] = [];
  const failed = queues
    .filter((queue) => queue.counts.failed > 0)
    .map((queue) => ({ name: queue.name, count: queue.counts.failed }))
    .toSorted(byCount);
  if (failed.length > 0) {
    items.push(
      item({
        id: 'work:failed',
        kind: 'work',
        reason: 'work-failed',
        level: 'soon',
        work: { count: failed.reduce((sum, queue) => sum + queue.count, 0), queues: failed },
      }),
    );
  }
  const paused = queues
    .filter((queue) => queue.paused && !queue.heldByMove)
    .map((queue) => ({ name: queue.name, count: queue.counts.waiting + queue.counts.paused }))
    .filter((queue) => queue.count > 0)
    .toSorted(byCount);
  if (paused.length > 0) {
    items.push(
      item({
        id: 'work:paused',
        kind: 'work',
        reason: 'work-paused',
        level: 'soon',
        work: { count: paused.reduce((sum, queue) => sum + queue.count, 0), queues: paused },
      }),
    );
  }
  return outcome(items);
};

// ── New version ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The version check's last answer (Frameleaf's own GitHub releases, `VersionService`). Off while the
 * check is switched off; unknown until it has answered once.
 */
export const versionSignal = ({
  enabled,
  state,
  current,
  isNewer,
}: {
  enabled: boolean;
  state: VersionCheckMetadata | null | undefined;
  current: string;
  isNewer: (releaseVersion: string) => boolean;
}): SignalResult => {
  if (!enabled) {
    return { state: 'off', items: [] };
  }
  if (!state?.releaseVersion) {
    return { state: 'unknown', items: [] };
  }
  if (!isNewer(state.releaseVersion)) {
    return outcome([]);
  }
  return outcome([
    item({
      id: 'version',
      kind: 'version',
      reason: 'new-version',
      level: 'soon',
      version: { current, available: state.releaseVersion.replace(/^v/, '') },
    }),
  ]);
};

// ── Together ────────────────────────────────────────────────────────────────────────────────────────

/** The most urgent first, then in the order the Overview names its checks: backup, storage, work, version. */
export const sortAttention = (items: AttentionItem[]): AttentionItem[] =>
  items.toSorted(
    (a, b) =>
      Number(a.level !== 'now') - Number(b.level !== 'now') ||
      ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind),
  );
