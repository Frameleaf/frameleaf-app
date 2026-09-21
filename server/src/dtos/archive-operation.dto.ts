import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  AssetOrder,
  AssetOrderBy,
  AssetOrderBySchema,
  AssetOrderSchema,
  TimeBucketDateType,
  TimeBucketDateTypeSchema,
} from 'src/enum.js';

export class ArchiveOperationCreateDto extends createZodDto(
  z
    .object({
      ids: z.array(z.uuid()).min(1).max(10_000),
      requestKey: z.uuid(),
      scope: z.literal('selected-owned-assets').meta({ id: 'ArchiveOperationScope' }),
    })
    .meta({ id: 'ArchiveOperationCreateDto' }),
) {}

export class ArchiveOperationCommandDto extends createZodDto(
  z
    .object({ command: z.enum(['cancel', 'retry', 'undo']).meta({ id: 'ArchiveOperationCommand' }) })
    .meta({ id: 'ArchiveOperationCommandDto' }),
) {}

export class ArchiveOperationResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      scope: z.string(),
      count: z.number().int().nonnegative(),
      prepared: z.boolean(),
      requestKey: z.uuid(),
      cancelled: z.boolean(),
      undo: z.boolean(),
      pending: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      revoked: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
      undone: z.number().int().nonnegative(),
      conflict: z.number().int().nonnegative(),
    })
    .meta({ id: 'ArchiveOperationResponseDto' }),
) {}

export const ArchiveTimelineQuerySchema = z.strictObject({
  scope: z.strictObject({ kind: z.literal('library').meta({ id: 'ArchiveTimelineScope' }) }),
  filters: z.strictObject({
    visibility: z.literal('timeline').meta({ id: 'ArchiveTimelineVisibility' }),
    withStacked: z.literal(true),
    withPartners: z.boolean(),
    order: AssetOrderSchema.default(AssetOrder.Desc),
    orderBy: AssetOrderBySchema.default(AssetOrderBy.TakenAt),
    dateType: TimeBucketDateTypeSchema.default(TimeBucketDateType.Taken),
  }),
});
export class ArchiveOperationPrepareDto extends createZodDto(
  z
    .strictObject({
      requestKey: z.uuid(),
      query: ArchiveTimelineQuerySchema,
    })
    .meta({ id: 'ArchiveOperationPrepareDto' }),
) {}

export class ArchiveOperationConfirmDto extends createZodDto(
  z
    .strictObject({
      requestKey: z.uuid(),
    })
    .meta({ id: 'ArchiveOperationConfirmDto' }),
) {}
