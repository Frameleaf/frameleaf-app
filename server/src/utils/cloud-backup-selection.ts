import { createHash } from 'node:crypto';
import { compareCodeUnits } from 'src/utils/compare.js';

/** Why one owned original is, or is not, in a run's Cloud Backup. */
export type CloudBackupDecisionReason = 'included' | 'selection' | 'licence';

/** A dated period whose photos a selection adds, whatever else it chooses (`recent`: the last N months). */
export type CloudBackupDateRange = { kind: 'between'; from: string; to: string } | { kind: 'recent'; months: number };

/**
 * FL-362: what Cloud Backup keeps of each account's own library. Everything by default; otherwise the
 * union of chosen albums, collections (the albums they hold), people, tags (and the tags inside them),
 * folders (and the folders inside them), favorites and taken-date ranges. A date range adds photos rather
 * than narrowing the other choices. Only the assets the account owns are measured against its choice.
 *
 * The choice stays in this database. Frameleaf Cloud only ever receives counts per opaque account
 * reference, and a manifest only ever names the originals it holds.
 */
export const CLOUD_BACKUP_DESTINATION = 'cloud' as const;
/** Ids or folders one choice may name, per kind. */
export const CLOUD_BACKUP_SELECTION_MAX_ITEMS = 500;
/** Date ranges one choice may hold. */
export const CLOUD_BACKUP_SELECTION_MAX_RANGES = 20;

export type CloudBackupChosen = {
  albumIds: string[];
  collectionIds: string[];
  personIds: string[];
  tagIds: string[];
  folders: string[];
  favorites: boolean;
  dateRanges: CloudBackupDateRange[];
};

/** `null`: Everything. */
export type CloudBackupSelection = CloudBackupChosen | null;

const unique = (values: string[]) => [...new Set(values)].toSorted(compareCodeUnits);

/** A folder as the Folders view names it, without a trailing slash; empty when it names no folder. */
export const normalizeBackupFolder = (path: string) => path.trim().replace(/\/+$/, '');

/** The choice in canonical order, so the same choice always hashes the same. */
export const canonicalSelection = (chosen: CloudBackupChosen): CloudBackupChosen => ({
  albumIds: unique(chosen.albumIds),
  collectionIds: unique(chosen.collectionIds),
  personIds: unique(chosen.personIds),
  tagIds: unique(chosen.tagIds),
  folders: unique(chosen.folders.map(normalizeBackupFolder).filter(Boolean)),
  favorites: chosen.favorites,
  dateRanges: chosen.dateRanges
    .map((range): CloudBackupDateRange =>
      range.kind === 'between'
        ? { kind: 'between', from: range.from, to: range.to }
        : { kind: 'recent', months: range.months },
    )
    .toSorted((a, b) => compareCodeUnits(JSON.stringify(a), JSON.stringify(b)))
    .filter((range, index, all) => index === 0 || JSON.stringify(range) !== JSON.stringify(all[index - 1])),
});

/** SHA-256 of the canonical choice: recorded locally with each run, never sent anywhere. Null: Everything. */
export const selectionHash = (selection: CloudBackupSelection): string | null =>
  selection
    ? createHash('sha256')
        .update(JSON.stringify(canonicalSelection(selection)))
        .digest('hex')
    : null;

/** Whether a choice chooses anything at all. */
export const choosesAnything = (chosen: CloudBackupChosen) =>
  chosen.favorites ||
  chosen.dateRanges.length > 0 ||
  [chosen.albumIds, chosen.collectionIds, chosen.personIds, chosen.tagIds, chosen.folders].some(
    (ids) => ids.length > 0,
  );

/**
 * The opaque per-server account reference Frameleaf Cloud knows an account by (`fingerprint.user`, the
 * binding a personal licence is activated with): SHA-256 of the instance id followed by the account id.
 */
export const backupUserFingerprint = (instanceId: string, userId: string) =>
  createHash('sha256').update(`${instanceId}${userId}`).digest('hex');

/** The licence coverage a run's grant gave, as the run records it. */
export type BackupLicenceScope =
  { scope: 'all' } | { scope: 'none' } | { scope: 'users'; userFingerprints: string[] } | { scope: 'own-bucket' };

export const isLicenceEligible = (scope: BackupLicenceScope, fingerprint: string) =>
  scope.scope === 'all' ||
  scope.scope === 'own-bucket' ||
  (scope.scope === 'users' && scope.userFingerprints.includes(fingerprint));

/** Why an item of a backed-up database has no original in that backup's manifest (FL-362). */
export type BackupExclusionReason = 'selection' | 'licence' | 'not-committed' | 'unknown';

/**
 * The reason a restore shows for an item whose original is not in the manifest it restores, from that
 * backup's own decision: never from today's choice. Without that backup's decision the reason is unknown.
 */
export const exclusionReason = (
  decisionKnown: boolean,
  reason: CloudBackupDecisionReason | null,
): BackupExclusionReason => {
  if (!decisionKnown) {
    return 'unknown';
  }
  switch (reason) {
    case 'selection': {
      return 'selection';
    }
    case 'licence': {
      return 'licence';
    }
    default: {
      // chosen and covered, or added after the inventory: not in this backup yet
      return 'not-committed';
    }
  }
};
