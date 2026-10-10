import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const MAX_BUCKET_HASHES = 2000;
export const Sha256Schema = z
  .string()
  .regex(/^[a-f\d]{64}$/i)
  .toLowerCase();
export const BackupDeviceWriteSchema = z
  .object({
    deviceKey: z.uuid().describe('Stable random client device identity, scoped to this owner'),
    displayName: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
    platform: z.string().trim().min(1).max(50),
    appVersion: z.string().trim().min(1).max(100),
    lastSuccessfulBackupAt: z.iso.datetime().nullable().describe('Device-reported success; not server verification'),
    pendingCount: z.int().min(0).max(2_147_483_647),
  })
  .meta({ id: 'BackupDeviceWriteDto' });
export class BackupDeviceWriteDto extends createZodDto(BackupDeviceWriteSchema) {}
export const BackupDevicePageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .meta({ id: 'BackupDevicePageDto' });
export class BackupDevicePageDto extends createZodDto(BackupDevicePageSchema) {}
const DateTime = z.string().meta({ format: 'date-time' });
const BackupDeviceSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    deviceKey: z.uuid(),
    displayName: z.string(),
    model: z.string(),
    platform: z.string(),
    appVersion: z.string(),
    reportedAt: DateTime,
    lastSuccessfulBackupAt: DateTime.nullable(),
    pendingCount: z.int(),
    quietForDays: z.int().nullable().describe('Elapsed whole days since reported success; null if never reported'),
  })
  .meta({ id: 'BackupDeviceDto' });
export class BackupDeviceDto extends createZodDto(BackupDeviceSchema) {}
export class BackupDeviceListDto extends createZodDto(
  z
    .object({ devices: z.array(BackupDeviceSchema), nextOffset: z.int().nullable() })
    .meta({ id: 'BackupDeviceListDto' }),
) {}
export const BucketDigestSchema = z.object({ count: z.int().min(0).max(MAX_BUCKET_HASHES), digest: Sha256Schema });
export const ReconciliationStartSchema = z
  .object({
    buckets: z
      .array(BucketDigestSchema)
      .length(256)
      .describe(
        'First byte buckets in index order. Digest SHA256 of sorted distinct raw32-byte hashes; empty digest SHA256(empty). Maximum2000 hashes per bucket; larger sets refused.',
      ),
  })
  .meta({ id: 'ReconciliationStartDto' });
export class ReconciliationStartDto extends createZodDto(ReconciliationStartSchema) {}
export const ReconciliationBucketSchema = z
  .object({
    bucket: z.int().min(0).max(255),
    hashes: z.array(Sha256Schema).max(MAX_BUCKET_HASHES),
  })
  .meta({ id: 'ReconciliationBucketDto' });
export class ReconciliationBucketDto extends createZodDto(ReconciliationBucketSchema) {}
export const ReconciliationResultSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    startedAt: DateTime,
    checkedAt: DateTime.describe('Inventory snapshot time, not a promise after commit'),
    completedAt: DateTime.nullable(),
    differingBuckets: z.array(z.int()),
    pendingBuckets: z.array(z.int()),
    itemsChecked: z.int(),
    itemsMissing: z
      .int()
      .describe('Provided SHA256 hashes absent from current registered inventory; not a filesystem loss diagnosis'),
    missingHashes: z.array(Sha256Schema),
    evidence: z
      .literal('registered-current-originals')
      .describe(
        'Current database inventory, excludes offline/last-checked-missing; not a fresh filesystem integrity check',
      ),
  })
  .meta({ id: 'ReconciliationResultDto' });
export class ReconciliationResultDto extends createZodDto(ReconciliationResultSchema) {}
export class ReconciliationHistoryDto extends createZodDto(
  z
    .object({ runs: z.array(ReconciliationResultSchema.omit({ missingHashes: true })), nextOffset: z.int().nullable() })
    .meta({ id: 'ReconciliationHistoryDto' }),
) {}
