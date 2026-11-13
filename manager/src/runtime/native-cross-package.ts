import { z } from 'zod';
import type { NativeRecoveryRecord } from './native-recovery.js';

/**
 * The capability a native Manager declares once it restores a backup taken by an earlier
 * companion package. It is not declared yet: see `crossPackageRestoreAdmission`.
 */
export const NATIVE_CROSS_PACKAGE_RESTORE = 'cross-package-restore';

/**
 * The earlier database builds the installed controller says it can restore from. Desktop hands
 * this down in the bootstrap, from the upgrade paths its signed package declares. Without it
 * every backup from another package is refused, exactly as before.
 */
export const NativeRestoreSources = z
  .object({
    sources: z
      .array(
        z
          .object({ postgresMajor: z.string().regex(/^[1-9][0-9]$/) })
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
 * Whether a verified backup may be restored by this package.
 *
 * - `same-package`: it was taken by this release and source revision.
 * - `supported`: it was taken by an earlier package, it names that package and the Postgres
 *   major that wrote it, that major is one the controller declared it restores from and is
 *   not newer than this package's, and the backup's release is strictly older than this one.
 * - `refused`: everything else, including anything that cannot be ordered. A restore only
 *   ever goes forward.
 *
 * The restore itself is the controller's ordinary one: a logical dump read into a fresh
 * database directory by this package's own Postgres, verified before it can be selected.
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
    !/^[1-9][0-9]$/.test(target.postgresMajor) ||
    !Number.isInteger(major) ||
    major > Number(target.postgresMajor) ||
    !parsed.data.sources.some(
      (source) => source.postgresMajor === checkpoint.postgresMajor,
    )
  )
    return 'refused';
  return 'supported';
}
