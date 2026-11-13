import type { SystemMetadataKey } from 'src/enum.js';
import type { StorageRoot } from 'src/utils/storage-reach.js';

/**
 * FL-954: a fingerprint of the library, taken just before an upgrade and again once the new version
 * has started, and the rules that compare the two. Nothing here reads a database or a drive, so an
 * update rollback (FL-973) can capture and compare with the same code.
 */

/**
 * Where the fingerprint taken before an upgrade, the mount sentinels and the latest check are kept.
 * A plain key, not a `SystemMetadataKey` member: `enum.ts` is hashed into the schema catalog, and this
 * adds no schema.
 */
export const UPGRADE_FINGERPRINT_KEY = 'upgrade-fingerprint' as SystemMetadataKey;

/** The mount sentinel: a file in each storage root holding a random id, written once the root has files. */
export const SENTINEL_FILE = '.frameleaf-sentinel';

/** Tables whose row counts are part of the fingerprint. One that is not there yet counts as null. */
export const FINGERPRINT_TABLES = ['asset', 'user', 'album', 'person', 'asset_face', 'smart_search'] as const;

/** Losing more than this share of the photos and videos across an upgrade fails the check. */
export const ASSET_DROP_THRESHOLD = 0.005;

/** A root with more top-level folders than this is compared by its total only. */
export const MAX_FOLDERS_PER_ROOT = 500;

/** What the database says, read in one go by `DatabaseRepository.getLibraryFingerprintCounts`. */
export type LibraryFingerprintCounts = {
  /** Every photo and video row, the trash included: a row that is gone is gone whatever its state. */
  total: number;
  /** When the newest photo or video was added. */
  newestAt: string | null;
  byType: Record<string, number>;
  byOwner: Record<string, number>;
  /** By external library id; `''` holds the photos and videos that are in no library. */
  byLibrary: Record<string, number>;
  tables: Record<string, number | null>;
  /** One entry per root asked for, in the order asked. */
  roots: Array<{
    path: string;
    assets: number;
    /** Files by top-level folder (`''` for files directly in the root); null when there are too many folders. */
    folders: Record<string, number> | null;
  }>;
};

/**
 * `present`: the sentinel is there with the id on record (or, for a root that has none, the folder is
 * there). `missing`: it is not, so the drive is not mounted. `different`: another id, so another drive
 * is mounted there. `unknown`: it could not be read for another reason, which says nothing.
 */
export type SentinelState = 'present' | 'missing' | 'different' | 'unknown';

/** A storage root as the server last saw it in place. `sentinelId` is null where no file can be written. */
export type SentinelRecord = Pick<StorageRoot, 'kind' | 'name' | 'path'> & { sentinelId: string | null };

export type LibraryFingerprintRoot = SentinelRecord & {
  state: SentinelState;
  assets: number;
  folders: Record<string, number> | null;
};

export type LibraryFingerprint = {
  /** The version the library was on when this was taken. */
  version: string;
  capturedAt: string;
  assets: Pick<LibraryFingerprintCounts, 'total' | 'newestAt' | 'byType' | 'byOwner' | 'byLibrary'>;
  tables: Record<string, number | null>;
  roots: LibraryFingerprintRoot[];
};

export const UPGRADE_CHECK_FINDING_REASONS = [
  'drive-missing',
  'photos-fewer',
  'newest-earlier',
  'folder-empty',
] as const;
export type UpgradeCheckFindingReason = (typeof UPGRADE_CHECK_FINDING_REASONS)[number];

/** One difference the check names. Fields that do not apply to the reason are null. */
export type UpgradeCheckFinding = {
  reason: UpgradeCheckFindingReason;
  /** The drive's folder, or the folder that is empty now. */
  path: string | null;
  /** The external library the folder belongs to; null for Frameleaf's own folders. */
  name: string | null;
  /** Photos and videos before the upgrade: in the whole library, in the folder, or on the drive. */
  before: number | null;
  /** Photos and videos now; null for a drive, whose files cannot be counted while it is away. */
  after: number | null;
  beforeAt: string | null;
  afterAt: string | null;
};

export type UpgradeCheckResult = {
  fromVersion: string;
  toVersion: string;
  checkedAt: string;
  state: 'ok' | 'attention';
  findings: UpgradeCheckFinding[];
  assets: { before: number; after: number };
  newestAt: { before: string | null; after: string | null };
  tables: Array<{ name: string; before: number | null; after: number | null }>;
};

/** What `UPGRADE_FINGERPRINT_KEY` holds. */
export type UpgradeFingerprintState = {
  /** The roots and their sentinel ids, kept from the last start that found them in place. */
  roots?: SentinelRecord[];
  /** Taken before the migrations of `toVersion` ran; compared and removed once that version has started. */
  pending?: { toVersion: string; before: LibraryFingerprint };
  /** The latest check, with both fingerprints for a rollback to read. */
  latest?: UpgradeCheckResult & { before: LibraryFingerprint; after: LibraryFingerprint };
};

export const sentinelPath = (root: string) => `${root}/${SENTINEL_FILE}`;

/** The id a sentinel file holds, or null when the file holds nothing usable. */
export const parseSentinel = (content: string): string | null => {
  const id = content.trim();
  return /^[\w-]{8,64}$/.test(id) ? id : null;
};

export const buildLibraryFingerprint = (
  version: string,
  capturedAt: string,
  counts: LibraryFingerprintCounts,
  roots: Array<SentinelRecord & { state: SentinelState }>,
): LibraryFingerprint => {
  const byPath = new Map(counts.roots.map((root) => [root.path, root]));
  return {
    version,
    capturedAt,
    assets: {
      total: counts.total,
      newestAt: counts.newestAt,
      byType: counts.byType,
      byOwner: counts.byOwner,
      byLibrary: counts.byLibrary,
    },
    tables: counts.tables,
    roots: roots.map((root) => ({
      ...root,
      assets: byPath.get(root.path)?.assets ?? 0,
      folders: byPath.get(root.path)?.folders ?? null,
    })),
  };
};

const finding = (
  reason: UpgradeCheckFindingReason,
  values: Partial<Omit<UpgradeCheckFinding, 'reason'>>,
): UpgradeCheckFinding => ({
  reason,
  path: null,
  name: null,
  before: null,
  after: null,
  beforeAt: null,
  afterAt: null,
  ...values,
});

/**
 * The rules. A drive that is not mounted (its sentinel is missing, or another drive's is there) comes
 * first, so an unplugged drive is named as that. Then: fewer photos and videos by more than 0.5%, a
 * newest photo that is older than before, and a top-level folder that held files and holds none now.
 * Anything else is `ok`.
 */
export const compareLibraryFingerprints = (
  before: LibraryFingerprint,
  after: LibraryFingerprint,
): UpgradeCheckResult => {
  const findings: UpgradeCheckFinding[] = [];
  const beforeRoots = new Map(before.roots.map((root) => [root.path, root]));

  for (const root of after.roots) {
    if (root.state === 'missing' || root.state === 'different') {
      findings.push(
        finding('drive-missing', {
          path: root.path,
          name: root.kind === 'library' ? root.name : null,
          before: beforeRoots.get(root.path)?.assets ?? root.assets,
        }),
      );
    }
  }

  const lost = before.assets.total - after.assets.total;
  if (lost > before.assets.total * ASSET_DROP_THRESHOLD) {
    findings.push(finding('photos-fewer', { before: before.assets.total, after: after.assets.total }));
  }

  const newestBefore = before.assets.newestAt;
  const newestAfter = after.assets.newestAt;
  if (newestBefore && (!newestAfter || Date.parse(newestAfter) < Date.parse(newestBefore))) {
    findings.push(finding('newest-earlier', { beforeAt: newestBefore, afterAt: newestAfter }));
  }

  for (const root of after.roots) {
    const earlier = beforeRoots.get(root.path);
    if (!earlier?.folders || !root.folders) {
      continue;
    }
    for (const [folder, count] of Object.entries(earlier.folders)) {
      // files directly in the root are covered by the totals
      if (folder !== '' && count > 0 && !root.folders[folder]) {
        findings.push(
          finding('folder-empty', {
            path: `${root.path}/${folder}`,
            name: root.kind === 'library' ? root.name : null,
            before: count,
            after: 0,
          }),
        );
      }
    }
  }

  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])];
  return {
    fromVersion: before.version,
    toVersion: after.version,
    checkedAt: after.capturedAt,
    state: findings.length > 0 ? 'attention' : 'ok',
    findings,
    assets: { before: before.assets.total, after: after.assets.total },
    newestAt: { before: newestBefore, after: newestAfter },
    tables: names.map((name) => ({ name, before: before.tables[name] ?? null, after: after.tables[name] ?? null })),
  };
};

/** Whether the fingerprint before an upgrade from `fromVersion` to `toVersion` is already taken, or checked. */
export const hasUpgradeFingerprint = (
  state: UpgradeFingerprintState | null | undefined,
  fromVersion: string,
  toVersion: string,
): boolean =>
  (state?.pending?.toVersion === toVersion && state.pending.before.version === fromVersion) ||
  (state?.latest?.toVersion === toVersion && state.latest.fromVersion === fromVersion);
