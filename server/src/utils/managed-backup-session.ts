import { performance } from 'node:perf_hooks';
import {
  type BackupGrantResponse,
  type BackupOperation,
  backupGrantProblem,
  managedBackupRefusal,
} from 'src/utils/frameleaf-cloud-backup.js';

export type BackupCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** Authorization failures must not be recorded as missing or damaged backup media. */
export class ManagedBackupAuthorizationError extends Error {
  constructor(
    message = 'Managed backup authorization is unavailable. Try again later.',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ManagedBackupAuthorizationError';
  }
}

/** One operation owns one renewal flight. Provider expiry remains authoritative. */
export const managedBackupSession = (
  initial: BackupGrantResponse,
  operation: BackupOperation,
  renew: () => Promise<BackupGrantResponse>,
  now = () => performance.now(),
) => {
  let grant = initial;
  let refreshAt = now() + grant.capability.refreshAfterSec * 1000;
  let pending: Promise<BackupCredentials> | undefined;
  let failure: ManagedBackupAuthorizationError | undefined;
  let retryAt = 0;
  const validate = (next: BackupGrantResponse) => {
    if (
      next.capability.operation !== operation ||
      next.storageId !== initial.storageId ||
      next.bucket !== initial.bucket ||
      next.endpoint !== initial.endpoint ||
      next.region !== initial.region ||
      next.location.locationId !== initial.location.locationId ||
      JSON.stringify(next.coverage) !== JSON.stringify(initial.coverage) ||
      (operation !== 'restore' && next.readOnly) ||
      backupGrantProblem(next)
    ) {
      throw new ManagedBackupAuthorizationError('Frameleaf Cloud changed the backup capability or storage binding.');
    }
  };
  validate(initial);
  return async (failedAccessKeyId?: string): Promise<BackupCredentials> => {
    if (pending) return pending;
    if (failure && now() < retryAt) throw failure;
    if (
      !failure &&
      (failedAccessKeyId ? failedAccessKeyId !== grant.capability.credentials.accessKeyId : now() < refreshAt)
    ) {
      return grant.capability.credentials;
    }
    pending = Promise.try(async () => {
      try {
        const next = await renew();
        validate(next);
        grant = next;
        refreshAt = now() + next.capability.refreshAfterSec * 1000;
        failure = undefined;
        return next.capability.credentials;
      } catch (error) {
        const refusal = managedBackupRefusal(error);
        const delay = Math.max(60, refusal.retryAfterSeconds ?? 60) * 1000;
        failure =
          error instanceof ManagedBackupAuthorizationError
            ? error
            : new ManagedBackupAuthorizationError(
                refusal.retry ? undefined : 'Frameleaf Cloud refused renewal of this backup operation.',
                refusal.retry ? delay : null,
              );
        retryAt = failure.retryAfterMs === null ? Infinity : now() + failure.retryAfterMs;
        throw failure;
      }
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
};
