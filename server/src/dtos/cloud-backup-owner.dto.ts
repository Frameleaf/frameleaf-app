import { createZodDto } from 'nestjs-zod';
import z from 'zod';

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
