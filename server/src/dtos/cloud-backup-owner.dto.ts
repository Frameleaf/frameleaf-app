import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { CloudBackupTargetSettingSchema } from 'src/dtos/cloud-backup.dto.js';

export const OwnerBackupPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export class OwnerBackupPageDto extends createZodDto(OwnerBackupPageSchema.meta({ id: 'OwnerBackupPageDto' })) {}
export const OwnerBackupHistorySchema = OwnerBackupPageSchema.extend({
  manifestKey: z
    .string()
    .regex(/^m\/\d{8}T\d{6}Z\.json\.gz$/)
    .max(300),
  query: z.string().max(200).optional(),
}).meta({ id: 'OwnerBackupHistoryDto' });
export class OwnerBackupHistoryDto extends createZodDto(OwnerBackupHistorySchema) {}
const Item = z.object({
  assetId: z.string(),
  name: z.string(),
  backupDate: z.string(),
  state: z.enum(['trashed', 'deleted']).meta({ id: 'OwnerBackupItemState' }),
  trashDate: z.string().nullable().describe('Known current trash timestamp; distinct from physical deletion'),
  deletionDate: z.object({
    state: z.enum(['available', 'unavailable']).meta({ id: 'OwnerBackupDeletionDateState' }),
    at: z.string().nullable(),
  }),
  thumbnailAvailable: z
    .boolean()
    .describe('An eligible recorded thumbnail; remote availability/integrity is checked when read'),
});
export class OwnerBackupHistoryResponseDto extends createZodDto(
  z
    .object({
      items: z.array(Item),
      total: z.int(),
      nextOffset: z.int().nullable(),
    })
    .meta({ id: 'OwnerBackupHistoryResponseDto' }),
) {}
export class OwnerBackupsResponseDto extends createZodDto(
  z
    .object({
      backups: z.array(
        z.object({
          manifestKey: z.string(),
          backupDate: z.string(),
          status: z.enum(['complete', 'degraded']).meta({ id: 'OwnerBackupKeptStatus' }),
        }),
      ),
      nextOffset: z.int().nullable(),
    })
    .meta({ id: 'OwnerBackupsResponseDto' }),
) {}

export class OwnerBackupRestoreDto extends createZodDto(
  z
    .object({
      manifestKey: OwnerBackupHistorySchema.shape.manifestKey,
      assetIds: z
        .array(z.uuid())
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length, 'Choose unique items'),
    })
    .meta({ id: 'OwnerBackupRestoreDto' }),
) {}
export class OwnerBackupRestoreResponseDto extends createZodDto(
  z
    .object({
      operationId: z.uuid(),
      status: z.string(),
    })
    .meta({ id: 'OwnerBackupRestoreResponseDto' }),
) {}

/** FL-234: the activation chain an owner's app polls; never bucket, key, usage, error or user details. */
export class CloudBackupOwnerSetupResponseDto extends createZodDto(
  z
    .object({
      target: CloudBackupTargetSettingSchema,
      entitlement: z
        .enum(['not-applicable', 'pending', 'seen'])
        .describe(
          'not-applicable: not Frameleaf-managed storage; pending: not linked to Frameleaf Cloud, or the plan does not include cloud backup; seen: linked and not refused for the plan',
        )
        .meta({ id: 'CloudBackupOwnerSetupEntitlement' }),
      bucketClaimed: z.boolean().describe('A bucket holds this server’s Frameleaf claim'),
      claimedAt: z.string().nullable().describe('When the bucket was claimed'),
      keyLoaded: z.boolean().describe('The backup key is loaded on this server'),
      firstRun: z
        .enum(['not-started', 'queued', 'running', 'done', 'failed'])
        .describe(
          'done: a backup has succeeded; queued/running: a backup is waiting or in progress; failed: the last run failed; not-started: no run yet',
        )
        .meta({ id: 'CloudBackupOwnerSetupFirstRun' }),
      nextRunAt: z.string().nullable().describe('The next scheduled backup, when cloud backup is set up and on'),
    })
    .meta({ id: 'CloudBackupOwnerSetupResponseDto' }),
) {}
