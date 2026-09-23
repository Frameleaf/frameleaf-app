import { AssetLockReason, StudioExportScope } from 'src/enum.js';

/**
 * Conservative privacy inheritance for derived media (FL-106, `STU-404`), kept free of the database
 * so the rule can be read and tested on its own.
 *
 * A result made from several sources inherits the **union** of their restrictions, never the first
 * clip's and never the loosest: one Locked source makes the result Locked, one sensitive source
 * makes it sensitive, and one source that reached the owner only through sharing keeps the result
 * out of the owner's library, tied to the share.
 *
 * Locked is always an `asset_lock` record (owner decision, September 22, 2026): a result is never
 * given `visibility = locked`.
 */

/** What publication read about one library source, under a row lock, in its own transaction. */
export type DerivativeSourceEvidence = {
  assetId: string;
  ownerId: string;
  /** The source has an `asset_lock` record, and why. */
  lockReason: AssetLockReason | null;
  /** The sensitive projection (`asset.isNsfw`) is set. */
  sensitive: boolean;
};

export type DerivativePrivacy = {
  /** The lock the result must carry, or null when no source is Locked or sensitive-and-hidden. */
  lockReason: AssetLockReason | null;
  /** The result carries the sensitive projection. */
  sensitive: boolean;
  /** At least one library source belongs to somebody else. */
  includesSharedSources: boolean;
  /** Where the result may live (see {@link StudioExportScope}). */
  scope: StudioExportScope;
  /** How many library sources contributed, and how many of them were Locked or sensitive. */
  sourceCount: number;
  lockedSourceCount: number;
  sensitiveSourceCount: number;
};

/**
 * How strongly each reason hides. An item from the old Locked folder stays in the Locked view only;
 * an owner's mark and a detection are revealed to the owner's unlocked session on the timeline
 * (`REVEALED_LOCK_REASONS`). The result keeps the strongest reason any source had, so it is never
 * revealed anywhere a source would not be.
 */
const LOCK_REASON_STRENGTH: Readonly<Record<AssetLockReason, number>> = {
  [AssetLockReason.Detected]: 1,
  [AssetLockReason.Marked]: 2,
  [AssetLockReason.ImmichLockedFolder]: 3,
};

export const strongestLockReason = (reasons: ReadonlyArray<AssetLockReason | null>): AssetLockReason | null => {
  let strongest: AssetLockReason | null = null;
  for (const reason of reasons) {
    if (reason && (!strongest || LOCK_REASON_STRENGTH[reason] > LOCK_REASON_STRENGTH[strongest])) {
      strongest = reason;
    }
  }
  return strongest;
};

/**
 * The union of every source's evidence.
 *
 * - A Locked source locks the result with the strongest reason among the Locked sources.
 * - A sensitive source makes the result sensitive. When no source is Locked, the result is locked
 *   as `detected` exactly when the library hides sensitive detections (`nsfwHiding`), which is what
 *   a detection on the result itself would do.
 * - A source owned by anybody but `ownerId` puts the result in `project` scope.
 *
 * An empty source list (a project of titles and generated media only) is unrestricted and belongs
 * to the owner's library.
 */
export const unionDerivativePrivacy = (
  ownerId: string,
  sources: readonly DerivativeSourceEvidence[],
  options: { nsfwHiding: boolean },
): DerivativePrivacy => {
  const locked = sources.filter((source) => source.lockReason !== null);
  const sensitive = sources.filter((source) => source.sensitive);
  const includesSharedSources = sources.some((source) => source.ownerId !== ownerId);

  let lockReason = strongestLockReason(locked.map((source) => source.lockReason));
  if (!lockReason && sensitive.length > 0 && options.nsfwHiding) {
    lockReason = AssetLockReason.Detected;
  }

  return {
    lockReason,
    sensitive: sensitive.length > 0,
    includesSharedSources,
    scope: includesSharedSources ? StudioExportScope.Project : StudioExportScope.Library,
    sourceCount: sources.length,
    lockedSourceCount: locked.length,
    sensitiveSourceCount: sensitive.length,
  };
};

/**
 * Whether an existing asset already carries at least `required`: locked when a lock is required,
 * sensitive when sensitivity is. Used when the published bytes turn out to be an asset the owner
 * already has, which publication then references instead of copying.
 */
export const satisfiesDerivativePrivacy = (
  existing: { lockReason: AssetLockReason | null; sensitive: boolean },
  required: Pick<DerivativePrivacy, 'lockReason' | 'sensitive'>,
): boolean => {
  if (
    required.lockReason &&
    (!existing.lockReason || LOCK_REASON_STRENGTH[existing.lockReason] < LOCK_REASON_STRENGTH[required.lockReason])
  ) {
    return false;
  }
  return !required.sensitive || existing.sensitive;
};
