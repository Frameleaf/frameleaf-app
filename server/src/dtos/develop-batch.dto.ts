import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({
  fileName: z.string().min(1).max(1024),
  checksum,
  itemId: z.uuidv4().optional(),
  skip: z.boolean().optional(),
});
const returned = z
  .object({
    id: z.uuidv4(),
    checksum,
    confirmationId: z.uuidv4(),
    expectedCurrentRevisionId: z.uuidv4().nullable(),
    revisionId: z.uuidv4().nullable(),
    status: z
      .enum(['confirmed', 'imported', 'completed', 'conflict', 'failed', 'cancelled'])
      .meta({ id: 'DevelopBatchReturnStatus' }),
    progress: z.int().meta({ format: 'int32' }),
    error: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .meta({ id: 'DevelopBatchReturnResponseDto' });
const item = z
  .object({
    id: z.uuidv4(),
    assetId: z.uuidv4().nullable(),
    exportId: z.uuidv4().nullable(),
    fileName: z.string().nullable(),
    exportName: z.string().nullable(),
    sourceChecksum: checksum.nullable(),
    available: z.boolean(),
    hasSidecar: z.boolean(),
    preparationStatus: z
      .enum(['pending', 'prepared', 'failed', 'unavailable'])
      .meta({ id: 'DevelopBatchPreparationStatus' }),
    error: z.string().nullable(),
    errorCode: z.string().nullable(),
    returns: z.array(returned),
  })
  .meta({ id: 'DevelopBatchItemResponseDto' });
const batch = z
  .object({
    id: z.uuidv4(),
    status: z.enum(['open', 'completed', 'cancelled']).meta({ id: 'DevelopBatchStatus' }),
    createdAt: z.string().meta({ format: 'date-time' }),
    includeSidecars: z.boolean(),
    items: z.array(item),
  })
  .meta({ id: 'DevelopBatchResponseDto' });
const match = z
  .object({
    index: z.int().meta({ format: 'int32' }),
    fileName: z.string(),
    checksum,
    itemId: z.uuidv4().nullable(),
    status: z.enum(['matched', 'ambiguous', 'unmatched', 'skipped']).meta({ id: 'DevelopBatchMatchStatus' }),
  })
  .meta({ id: 'DevelopBatchMatchResponseDto' });
export class DevelopBatchCreateDto extends createZodDto(
  z
    .object({ assetIds: z.array(z.uuidv4()).min(1), includeSidecars: z.boolean().default(true) })
    .meta({ id: 'DevelopBatchCreateDto' }),
) {}
export class DevelopBatchResponseDto extends createZodDto(batch) {}
export class DevelopBatchListQueryDto extends createZodDto(z.object({ cursor: z.uuidv4().optional() })) {}
export class DevelopBatchSummaryDto extends createZodDto(
  batch
    .pick({ id: true, status: true, createdAt: true, includeSidecars: true })
    .extend({ itemCount: z.int().nonnegative().meta({ format: 'int32' }) })
    .meta({ id: 'DevelopBatchSummaryDto' }),
) {}
export class DevelopBatchListResponseDto extends createZodDto(
  z
    .object({ items: z.array(DevelopBatchSummaryDto.schema), nextCursor: z.uuidv4().nullable() })
    .meta({ id: 'DevelopBatchListResponseDto' }),
) {}
export class DevelopBatchItemResponseDto extends createZodDto(item) {}
export class DevelopBatchMatchDto extends createZodDto(
  z.object({ files: z.array(file).min(1) }).meta({ id: 'DevelopBatchMatchDto' }),
) {}
export class DevelopBatchMatchResponseDto extends createZodDto(match) {}
export class DevelopBatchConfirmDto extends createZodDto(
  z.object({ files: z.array(file.extend({ itemId: z.uuidv4() })).min(1) }).meta({ id: 'DevelopBatchConfirmDto' }),
) {}
export class DevelopBatchImportDto extends createZodDto(
  z
    .object({
      confirmationId: z.uuidv4(),
      renditionChecksum: checksum,
      file: z.any().optional().meta({ type: 'string', format: 'binary' }),
    })
    .meta({ id: 'DevelopBatchImportDto' }),
) {}
export class DevelopBatchItemParamDto extends createZodDto(z.object({ id: z.uuidv4(), itemId: z.uuidv4() })) {}
export class DevelopBatchCapabilitiesDto extends createZodDto(
  z
    .object({ version: z.literal(1).meta({ id: 'DevelopBatchProtocolVersion', type: 'integer', format: 'int32' }) })
    .meta({ id: 'DevelopBatchCapabilitiesDto' }),
) {}
export class DevelopBatchManifestDto extends createZodDto(
  z
    .object({
      version: z.literal(1).meta({ id: 'DevelopBatchProtocolVersion', type: 'integer', format: 'int32' }),
      batchId: z.uuidv4(),
      skipped: z.array(z.object({ itemId: z.uuidv4(), reason: z.string() })),
      items: z.array(
        item.pick({
          id: true,
          assetId: true,
          exportId: true,
          fileName: true,
          exportName: true,
          sourceChecksum: true,
          hasSidecar: true,
        }),
      ),
    })
    .meta({ id: 'DevelopBatchManifestDto' }),
) {}
