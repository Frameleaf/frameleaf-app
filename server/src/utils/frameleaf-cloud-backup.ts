import z from 'zod';
import { FrameleafCloudError, cloudErrorCode, pausedMessageOf } from 'src/utils/frameleaf-cloud.js';

/**
 * Frameleaf Cloud's managed backup contract (FL-164, CLD-302), as the cloud publishes it in
 * `packages/contracts/src/backup/{grant,usage,escrow,runs}.ts` (FC-33 BAK-001, FC-38 BAK-002). Every schema
 * is strict like the cloud's: a grant's metadata that carried a secret, or an escrow blob with a field it
 * should not have, fails to parse. The bucket key never appears in any of them: the cloud never receives it.
 *
 * Routes (instance token, DPoP-bound; `{api}` from discovery):
 * - `GET {api}/v2/backup/locations`: enabled cities and unauthenticated probe URLs.
 * - `POST {api}/v2/backup/grant`: a selected location ID; rotation uses an empty body. The answer carries a
 *   bucket-scoped access key once. The backup agent rotates at the start of every operation and keeps
 *   the secret in memory for that operation only.
 * - `GET {api}/v1/backup/usage`: the latest hourly measurement.
 * - `POST {api}/v1/backup/runs`: run telemetry (counts, bytes, times, never a path).
 * - `PUT {api}/v1/backup/settings`: the key mode and whether a schedule is on.
 * - `PUT`, `GET`, `DELETE {api}/v1/backup/escrow`: the wrapped key, server key mode only.
 */

/** `fl-<region>-<instanceId>`: the account's data region (`eu` or `na`) and this server's UUIDv7. */
const BackupBucketName = z
  .string()
  .regex(/^fl-(eu|na)-[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);

const Timestamp = z.iso.datetime({ offset: true });

/**
 * Why Frameleaf Cloud made the storage read-only: `purge_hold`, `entitlement`, `unlinked`, `suspended`,
 * `purging`, `plan_full` (FL-301, FC-91) so far. Open-ended: a reason this server does not know is shown
 * generically, and `readOnly` alone decides whether backups pause. One this server cannot read at all reads as
 * `unknown`, so it never fails the answer it came in.
 */
export const BackupReadOnlyReasonSchema = z.string().min(1).max(64).catch('unknown');

export const backupCitySchema = z.strictObject({
  locationId: z.string().regex(/^loc-\d{2}$/),
  cityId: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/),
  city: z.string().min(1).max(80),
  country: z.string().min(1).max(80),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});
export type BackupCity = z.infer<typeof backupCitySchema>;
const brandedEndpoint = z
  .url()
  .refine((value) => /^https:\/\/s3\.[a-z]{2}-[a-z]+-\d\.backup\.frameleaf\.cloud\/?$/.test(value));
export const backupLocationSchema = backupCitySchema.extend({ probeUrl: brandedEndpoint });
export type BackupLocation = z.infer<typeof backupLocationSchema>;
export const backupLocationsSchema = z.strictObject({
  version: z.literal(2),
  locations: z.array(backupLocationSchema).max(16),
});
export const backupGrantRequestSchema = z.strictObject({ locationId: backupCitySchema.shape.locationId });
export const managedStorageRef = (storageId: string): string => `frameleaf-storage:${storageId}`;

export const backupGrantMetadataSchema = z.strictObject({
  version: z.literal(2),
  provider: z.literal('frameleaf'),
  storageId: z.uuid(),
  location: backupCitySchema,
  // This is the explicit SigV4 signing region, independent of the connection hostname.
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  endpoint: brandedEndpoint,
  bucket: BackupBucketName,
  accessKeyId: z.string().min(16).max(128).nullable(),
  expiresAt: Timestamp.nullable(),
  rotateAfterSec: z.int().min(0),
  quotaBytes: z.int().min(0),
  readOnly: z.boolean(),
  // FL-301: the cloud may name why the grant is read-only (`plan_full`); the usage answer always does
  readOnlyReason: BackupReadOnlyReasonSchema.nullable().optional(),
  versioning: z.literal(true),
  sseC: z.strictObject({ required: z.literal(true), algorithm: z.literal('AES256') }),
  policy: z.strictObject({ denies: z.array(z.string().regex(/^s3:[A-Za-z]+$/)).min(1) }),
  previousKeyExpiresAt: Timestamp.nullable(),
});
export type BackupGrantMetadata = z.infer<typeof backupGrantMetadataSchema>;

export const backupGrantResponseSchema = backupGrantMetadataSchema.extend({
  credentials: z.strictObject({
    accessKeyId: z.string().min(16).max(128),
    secretAccessKey: z.string().min(16).max(128),
  }),
});
export type BackupGrantResponse = z.infer<typeof backupGrantResponseSchema>;

/** What the grant's IAM policy must deny for this server to trust it with backups (BAK-001). */
export const REQUIRED_BACKUP_DENIES = ['s3:DeleteObjectVersion', 's3:PutBucketVersioning', 's3:DeleteBucket'] as const;

/** Why a grant cannot be used, or null: it must require SSE-C, keep versioning and deny version deletion. */
export const backupGrantProblem = (grant: BackupGrantMetadata): string | null => {
  const missing = REQUIRED_BACKUP_DENIES.filter((action) => !grant.policy.denies.includes(action));
  if (missing.length > 0) {
    return `Frameleaf Cloud offered backup storage whose access policy does not deny ${missing.join(', ')}. Backups stay paused.`;
  }
  return null;
};

export const backupUsageSchema = z.strictObject({
  measuredAt: Timestamp.nullable(),
  bytesCurrent: z.int().min(0),
  bytesNoncurrent: z.int().min(0),
  objects: z.int().min(0),
  includedBytes: z.int().min(0),
  accountBytesCurrent: z.int().min(0),
  extraBlocks: z.int().min(0),
  allowanceBytes: z.int().min(0),
  blockBytes: z.literal(1_000_000_000_000),
  readOnly: z.boolean(),
  readOnlyReason: BackupReadOnlyReasonSchema.nullable(),
});
export type BackupUsage = z.infer<typeof backupUsageSchema>;

const BASE64 = /^[\d+/A-Za-z]+={0,2}$/;
const base64Bytes = (value: string) =>
  Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
const Base64 = (min: number, max: number) =>
  z
    .string()
    .max(Math.ceil(max / 3) * 4)
    .regex(BASE64)
    .refine((value) => value.length % 4 === 0 && base64Bytes(value) >= min && base64Bytes(value) <= max, {
      message: `must be base64 of ${min} to ${max} bytes`,
    });

export const keyEscrowBlobSchema = z.strictObject({
  version: z.int().min(1).max(1000),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z.literal(131_072),
    r: z.literal(8),
    p: z.literal(1),
    salt: Base64(16, 64),
  }),
  cipher: z.literal('aes-256-gcm'),
  nonce: Base64(12, 12),
  ciphertext: Base64(17, 4096),
});
export type KeyEscrowBlob = z.infer<typeof keyEscrowBlobSchema>;

export const keyEscrowRecordSchema = keyEscrowBlobSchema.extend({ updatedAt: Timestamp });
export type KeyEscrowRecord = z.infer<typeof keyEscrowRecordSchema>;

/** `POST /v1/backup/runs`: telemetry only. A manifest key other than `m/<extended ISO>.json.gz` is left out. */
export const backupRunReportSchema = z.strictObject({
  runId: z.uuid(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled']),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  bytesUploaded: z.int().min(0),
  objectsUploaded: z.int().min(0),
  objectsSkipped: z.int().min(0),
  manifestKey: z
    .string()
    .max(64)
    .regex(/^m\/\d{4}-\d{2}-\d{2}T[\d.:-]+Z\.json\.gz$/)
    .nullable(),
  errorCode: z
    .string()
    .regex(/^[\d_a-z-]{1,64}$/)
    .nullable(),
});
export type BackupRunReport = z.infer<typeof backupRunReportSchema>;

export const backupAgentSettingsSchema = z.strictObject({
  keyMode: z.enum(['server', 'own-stored', 'own-memory']),
  scheduleEnabled: z.boolean(),
});
export type BackupAgentSettings = z.infer<typeof backupAgentSettingsSchema>;

const grantRevokedDataSchema = z.object({ reason: z.enum(['unlinked', 'suspended', 'revoked', 'purged']) });

/** Absolute URLs of the backup routes, from discovery's `api`; never a hard-coded host. */
export const backupEndpoints = (document: { api: string }) => {
  const api = document.api.replace(/\/+$/, '');
  return {
    locations: `${api}/v2/backup/locations`,
    grant: `${api}/v2/backup/grant`,
    rotate: `${api}/v2/backup/grant/rotate`,
    usage: `${api}/v1/backup/usage`,
    runs: `${api}/v1/backup/runs`,
    settings: `${api}/v1/backup/settings`,
    escrow: `${api}/v1/backup/escrow`,
  };
};

/** FL-234: the refusal recorded when cloud backup is not part of this server's Frameleaf Cloud plan. */
export const MANAGED_ENTITLEMENT_MISSING_REFUSAL = 'Cloud backup is not part of this server’s Frameleaf Cloud plan.';

const REVOKED_REASONS: Record<z.infer<typeof grantRevokedDataSchema>['reason'], string> = {
  unlinked: 'This server was unlinked from Frameleaf Cloud, so its managed backup storage was withdrawn.',
  suspended: 'This server is suspended on Frameleaf Cloud, so its managed backup storage was withdrawn.',
  revoked: 'Frameleaf Cloud withdrew this server’s managed backup storage.',
  purged: 'This server’s managed backup storage was deleted on Frameleaf Cloud.',
};

/**
 * What a refused grant, rotation or backup call means, for an administrator, and whether to try again
 * later. `grant-revoked` and a suspected copy stop and are shown as they are; a rate limit, a region
 * without storage or an unreachable cloud wait and try again. Never a secret, never provider output.
 */
export const managedBackupRefusal = (
  error: unknown,
): { message: string; retry: boolean; retryAfterSeconds: number | null; cloneSuspected: boolean } => {
  const code = cloudErrorCode(error);
  const retryAfterSeconds = error instanceof FrameleafCloudError ? error.retryAfterSeconds : null;
  const envelope = error instanceof FrameleafCloudError ? error.envelope : null;
  switch (code) {
    case 'grant-revoked': {
      const data = grantRevokedDataSchema.safeParse(envelope?.data);
      return {
        message: data.success ? REVOKED_REASONS[data.data.reason] : REVOKED_REASONS.revoked,
        retry: false,
        retryAfterSeconds: null,
        cloneSuspected: false,
      };
    }
    case 'clone_suspected': {
      return {
        message:
          'Frameleaf Cloud thinks this server may be a copy of another one, so it refused backup storage. Confirm this server in your Frameleaf account, then back up again.',
        retry: false,
        retryAfterSeconds: null,
        cloneSuspected: true,
      };
    }
    case 'entitlement-missing': {
      return {
        message: MANAGED_ENTITLEMENT_MISSING_REFUSAL,
        retry: false,
        retryAfterSeconds: null,
        cloneSuspected: false,
      };
    }
    case 'escrow-not-allowed': {
      return {
        message: 'Key escrow is only available when this server generates its own backup key.',
        retry: false,
        retryAfterSeconds: null,
        cloneSuspected: false,
      };
    }
    case 'rate-limited': {
      const fromData = Number((envelope?.data as { retryAfterSec?: unknown } | null)?.retryAfterSec);
      return {
        message: 'Frameleaf Cloud asked this server to wait before it requests backup storage again.',
        retry: true,
        retryAfterSeconds: retryAfterSeconds ?? (Number.isFinite(fromData) && fromData > 0 ? fromData : null),
        cloneSuspected: false,
      };
    }
    case 'service-paused': {
      // FC-62: new backup grants are paused for now; existing grants, reads and rotations carry on
      return {
        message: pausedMessageOf(error) ?? 'Frameleaf Cloud has paused new backup storage for now. Try again later.',
        retry: true,
        retryAfterSeconds,
        cloneSuspected: false,
      };
    }
    case 'region-unavailable': {
      return {
        message: 'Managed backup storage isn’t available in your data region right now. Backups try again later.',
        retry: true,
        retryAfterSeconds,
        cloneSuspected: false,
      };
    }
    default: {
      return {
        message:
          error instanceof FrameleafCloudError && error.status === null
            ? 'Frameleaf Cloud could not be reached. Managed backups try again later.'
            : `Frameleaf Cloud refused backup storage: ${error instanceof Error ? error.message : String(error)}`,
        retry: !(error instanceof FrameleafCloudError) || error.status === null || (error.status ?? 0) >= 500,
        retryAfterSeconds,
        cloneSuspected: false,
      };
    }
  }
};
