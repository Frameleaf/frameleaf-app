import { performance } from 'node:perf_hooks';
import {
  type BackupGrantResponse,
  type BackupOperation,
  backupGrantProblem,
  managedBackupRefusal,
} from 'src/utils/frameleaf-cloud-backup.js';
import { tryPromise } from 'src/utils/promise.js';

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

const authorizationError = (error: unknown): ManagedBackupAuthorizationError => {
  if (error instanceof ManagedBackupAuthorizationError) return error;
  const refusal = managedBackupRefusal(error);
  return new ManagedBackupAuthorizationError(
    refusal.retry ? undefined : 'Frameleaf Cloud refused renewal of this backup operation.',
    refusal.retry ? Math.max(60, refusal.retryAfterSeconds ?? 60) * 1000 : null,
  );
};

/** One operation owns one renewal flight. Provider expiry remains authoritative. */
export const managedBackupSession = (
  initial: BackupGrantResponse,
  operation: BackupOperation,
  renew: () => Promise<BackupGrantResponse>,
  now = () => performance.now(),
  binding = initial,
) => {
  let grant = initial;
  let refreshAt = now() + grant.capability.refreshAfterSec * 1000;
  let pending: Promise<BackupCredentials> | undefined;
  let failure: ManagedBackupAuthorizationError | undefined;
  let retryAt = 0;
  const validate = (next: BackupGrantResponse) => {
    if (
      next.capability.operation !== operation ||
      next.storageId !== binding.storageId ||
      next.bucket !== binding.bucket ||
      next.endpoint !== binding.endpoint ||
      next.region !== binding.region ||
      next.location.locationId !== binding.location.locationId ||
      JSON.stringify(next.coverage) !== JSON.stringify(binding.coverage) ||
      JSON.stringify(next.objectFormats) !== JSON.stringify(binding.objectFormats) ||
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
    pending = tryPromise(async () => {
      try {
        const next = await renew();
        validate(next);
        grant = next;
        refreshAt = now() + next.capability.refreshAfterSec * 1000;
        failure = undefined;
        return next.capability.credentials;
      } catch (error) {
        failure = authorizationError(error);
        retryAt = failure.retryAfterMs === null ? Infinity : now() + failure.retryAfterMs;
        throw failure;
      }
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
};

/** Exact-version reads use restore authority even while the operation uploads or prunes. */
export const managedBackupReadSession = (
  binding: BackupGrantResponse,
  renew: () => Promise<BackupGrantResponse>,
  now = () => performance.now(),
) => {
  let session: ReturnType<typeof managedBackupSession> | undefined;
  let pending: Promise<BackupCredentials> | undefined;
  let failure: ManagedBackupAuthorizationError | undefined;
  let retryAt = 0;
  return (failedAccessKeyId?: string): Promise<BackupCredentials> => {
    if (pending) return pending;
    if (failure && now() < retryAt) return Promise.reject(failure);
    pending = tryPromise(async () => {
      session ??= managedBackupSession(await renew(), 'restore', renew, now, binding);
      const credentials = await session(failedAccessKeyId);
      failure = undefined;
      return credentials;
    })
      .catch((error: unknown) => {
        failure = authorizationError(error);
        retryAt = failure.retryAfterMs === null ? Infinity : now() + failure.retryAfterMs;
        throw failure;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
};
