import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import { stringToBool } from 'src/validation.js';

export const BEST_PHOTO_SCORE_VERSION = 1;

/**
 * A photo is marked as a Best Photo from this score up. The same threshold as the Best Photos card on
 * Explore (`BEST_PHOTOS_QUALITY_MIN_SCORE` in the web, the design's `bestPhotosScore >= 90`).
 */
export const BEST_PHOTOS_MIN_SCORE = 0.9;

const BestPhotoScoreSchema = z
  .object({
    score: z.number().meta({ format: 'double' }).min(0).max(1),
    aestheticScore: z.number().meta({ format: 'double' }).min(0).max(1).nullable(),
    technicalScore: z.number().meta({ format: 'double' }).min(0).max(1).nullable(),
    subjectScore: z.number().meta({ format: 'double' }).min(0).max(1).nullable(),
    diversityScore: z.number().meta({ format: 'double' }).min(0).max(1).nullable(),
    scoreVersion: z.int(),
    computedAt: z.string().meta({ format: 'date-time' }),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    bestFrameTimestampMs: z.int().nullable(),
    frameScore: z.number().meta({ format: 'double' }).min(0).max(1).nullable(),
    frameMetadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: 'BestPhotoScoreDto' });

const BestPhotoAssetResponseSchema = AssetResponseSchema.extend({
  bestPhotoScore: BestPhotoScoreSchema,
}).meta({ id: 'BestPhotoAssetResponseDto' });

const BestPhotosResponseSchema = z
  .object({
    total: z.int().min(0),
    count: z.int().min(0),
    items: z.array(BestPhotoAssetResponseSchema),
    nextPage: z.string().nullable(),
  })
  .meta({ id: 'BestPhotosResponseDto' });

const BestPhotosQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    page: z.coerce.number().int().min(1).default(1),
    minScore: z.coerce.number().meta({ format: 'double' }).min(0).max(1).optional(),
    includeArchived: stringToBool.default(false),
  })
  .meta({ id: 'BestPhotosQueryDto' });

export class BestPhotoScoreDto extends createZodDto(BestPhotoScoreSchema) {}
export class BestPhotoAssetResponseDto extends createZodDto(BestPhotoAssetResponseSchema) {}
export class BestPhotosResponseDto extends createZodDto(BestPhotosResponseSchema) {}
export class BestPhotosQueryDto extends createZodDto(BestPhotosQuerySchema) {}
