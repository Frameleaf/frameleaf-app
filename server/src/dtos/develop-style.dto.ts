import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetDevelopRevisionResponseDto } from 'src/dtos/asset-develop.dto.js';

export class DevelopStyleDto extends createZodDto(
  z
    .object({
      availableEdits: z.int().nonnegative(),
      learnedEdits: z.int().nonnegative().nullable(),
      trainedAt: z.iso.datetime().nullable(),
    })
    .meta({ id: 'DevelopStyleDto' }),
) {}

export class DevelopStyleApplyDto extends createZodDto(
  z
    .object({
      batchId: z.uuidv4(),
      assetIds: z.array(z.uuidv4()).min(1).max(500).optional(),
    })
    .meta({ id: 'DevelopStyleApplyDto' }),
) {}

export class DevelopStyleBatchDto extends createZodDto(
  z
    .object({
      batchId: z.uuidv4(),
      versions: z.array(AssetDevelopRevisionResponseDto.schema),
      failed: z.int().nonnegative(),
    })
    .meta({ id: 'DevelopStyleBatchDto' }),
) {}

export class DevelopStyleUndoDto extends createZodDto(
  z
    .object({
      removed: z.int().nonnegative(),
      remaining: z.int().nonnegative(),
    })
    .meta({ id: 'DevelopStyleUndoDto' }),
) {}
