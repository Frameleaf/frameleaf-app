import { z } from 'zod';
import type { NativeRecoveryRecord } from './native-recovery.js';

/**
 * The capability a native Manager declares once it restores a backup taken by an earlier
 * companion package. It is not declared, and the rule below is not used by the service yet:
 * `NativeService.restore` still refuses every backup from another package before any
 * operation exists. See `crossPackageRestoreAdmission` for what has to be true first.
 */
export const NATIVE_CROSS_PACKAGE_RESTORE = 'cross-package-restore';

/**
 * The earlier packages the installed controller says it can restore from: each by the source
 * revision it was built from and the Postgres major it wrote. Desktop would hand this down in
 * the bootstrap, from the upgrade paths its signed package declares.
 */
export const NativeRestoreSources = z
  .object({
    sources: z
      .array(
        z
          .object({
            sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
            postgresMajor: z.string().regex(/^[1-9][0-9]$/),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type NativeRestoreSources = z.infer<typeof NativeRestoreSources>;

export type CrossPackageAdmission = 'same-package' | 'supported' | 'refused';

const version = (release: string) =>
  /^frameleaf-v(\d+)\.(\d+)\.(\d+)(?:-|$)/
    .exec(release)
    ?.slice(1)
    .map(Number);

/**
 * Whether a verified backup may be restored by this package. The answer is meant to be taken
 * before a restore operation is created, so that a backup this package cannot restore never
 * becomes an operation that fails and holds the single-operation lock.
 *
 * - `same-package`: it was taken by this release and source revision.
 * - `supported`: it was taken by an earlier package; the exact source revision and Postgres
 *   major the backup names are a pair the controller declared it restores from; that major
 *   is not newer than this package's; and the backup's release is strictly older than this
 *   one.
 * - `refused`: everything else, including anything that cannot be ordered. A restore only
 *   ever goes forward.
 *
 * Before the service may act on `supported`, two things must exist that do not today: the
 * controller's restore must accept a recovery record from a declared earlier package (it
 * refuses any other source revision), and a restore that fails after admission must be
 * something a person can clear or retry (a failed operation keeps the lock until it is
 * resumed, and a refusal by the controller would recur on every resume).
 */
export function crossPackageRestoreAdmission(
  recovery: NativeRecoveryRecord,
  target: { release: string; sourceRevision: string; postgresMajor: string },
  declared?: NativeRestoreSources,
): CrossPackageAdmission {
  const checkpoint = recovery.checkpoint;
  if (
    recovery.installation.release === target.release &&
    checkpoint.sourceRevision === target.sourceRevision
  )
    return 'same-package';
  const parsed = NativeRestoreSources.safeParse(declared);
  const from = version(recovery.installation.release);
  const to = version(target.release);
  if (!parsed.success || !from || !to) return 'refused';
  const older = from.findIndex((part, index) => part !== to[index]);
  if (older < 0 || from[older]! > to[older]!) return 'refused';
  const major = Number(checkpoint.postgresMajor);
  if (
    checkpoint.sourceRevision === target.sourceRevision ||
    !/^[1-9][0-9]$/.test(target.postgresMajor) ||
    !Number.isInteger(major) ||
    major > Number(target.postgresMajor) ||
    !parsed.data.sources.some(
      (source) =>
        source.sourceRevision === checkpoint.sourceRevision &&
        source.postgresMajor === checkpoint.postgresMajor,
    )
  )
    return 'refused';
  return 'supported';
}
