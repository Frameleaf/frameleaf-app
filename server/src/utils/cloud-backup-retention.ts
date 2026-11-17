import { compareCodeUnits } from 'src/utils/compare.js';

/**
 * Cloud backup retention and verification sampling (FL-164, CLD-302). Pure functions: nothing here reads a
 * file or talks to a provider, so the rules that decide what may be deleted can be tested on their own.
 *
 * - **Retention** keeps the newest backup, then the newest backup of each of the last `keepDaily` days,
 *   `keepWeekly` ISO weeks and `keepMonthly` months that have one (UTC). Every other backup is removed by
 *   the backup engine, and with it only the stored data that no kept backup needs.
 * - **Weekly verification** reads the stored objects whose name falls in this week's 1/52 slice, so every
 *   object is fetched and checked once a year; the monthly pass checks that every needed piece is stored.
 */

export type CloudBackupRetention = { keepDaily: number; keepWeekly: number; keepMonthly: number };

/** One backup a retention pass decides about: its name in storage and when its run made it. */
export type CloudBackupRetentionCandidate = { key: string; createdAt: Date };

/** Weeks in the verification cycle: each week checks 1/52 of the objects. */
export const CLOUD_BACKUP_VERIFY_SLICES = 52;
/** How long after a full verification the next one is due. */
export const CLOUD_BACKUP_FULL_VERIFY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long after a sampled verification the next one is due. */
export const CLOUD_BACKUP_SAMPLE_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/** The ISO 8601 week, `2026-W39`, in UTC. */
export const isoWeekOf = (date: Date) => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides which year a week belongs to
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/**
 * Which backups to keep and which to remove. The newest is always kept, whatever the settings say, so
 * a bucket is never left without a restore point. Ties on time are broken by key, so the answer is the
 * same however the list arrives.
 */
export const retentionPlan = <T extends CloudBackupRetentionCandidate>(
  manifests: readonly T[],
  retention: CloudBackupRetention,
): { keep: T[]; remove: T[] } => {
  const newestFirst = manifests.toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareCodeUnits(b.key, a.key),
  );
  const kept = new Set<string>();
  if (newestFirst.length > 0) {
    kept.add(newestFirst[0].key);
  }
  const rules: Array<[number, (date: Date) => string]> = [
    [retention.keepDaily, dayOf],
    [retention.keepWeekly, isoWeekOf],
    [retention.keepMonthly, monthOf],
  ];
  for (const [count, periodOf] of rules) {
    const periods = new Set<string>();
    for (const manifest of newestFirst) {
      if (periods.size >= count) {
        break;
      }
      const period = periodOf(manifest.createdAt);
      if (!periods.has(period)) {
        periods.add(period);
        kept.add(manifest.key);
      }
    }
  }
  return {
    keep: newestFirst.filter(({ key }) => kept.has(key)),
    remove: newestFirst.filter(({ key }) => !kept.has(key)),
  };
};

/** This week's verification slice, 0 to 51, counted in whole weeks since the epoch. */
export const verifySliceOf = (date: Date) => Math.floor(date.getTime() / WEEK_MS) % CLOUD_BACKUP_VERIFY_SLICES;

/** Whether a stored object falls in a week's slice: the first 32 bits of its (random, hex) name, modulo 52. */
export const inVerifySlice = (name: string, slice: number) =>
  Number.parseInt(name.slice(0, 8), 16) % CLOUD_BACKUP_VERIFY_SLICES === slice;

/** Which verification is due now, if any: the monthly full pass first, else the weekly sample. */
export const verificationDue = (
  options: { verifyWeekly: boolean; lastFullAt?: string | null; lastSampleAt?: string | null },
  now: Date,
): 'full' | 'sample' | null => {
  if (!options.verifyWeekly) {
    return null;
  }
  const since = (value?: string | null) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isNaN(at) ? Infinity : now.getTime() - at;
  };
  if (since(options.lastFullAt) >= CLOUD_BACKUP_FULL_VERIFY_INTERVAL_MS) {
    return 'full';
  }
  if (since(options.lastSampleAt) >= CLOUD_BACKUP_SAMPLE_VERIFY_INTERVAL_MS) {
    return 'sample';
  }
  return null;
};
