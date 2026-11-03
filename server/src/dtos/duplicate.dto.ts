import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';

const DuplicateResponseSchema = z
  .object({
    duplicateId: z.uuidv4().describe('Duplicate group ID'),
    assets: z.array(AssetResponseSchema).describe('Duplicate assets'),
    reviewRequiredReasons: z
      .array(z.string())
      .optional()
      .describe('Safety reasons that prevent unattended disposal of the non-suggested copies'),
    suggestedKeepAssetIds: z
      .array(z.uuidv4())
      .describe(
        'Suggested asset IDs to keep based on format preference (RAW, HEIC/HEIF/HIF, then other formats), file size and EXIF data',
      ),
  })
  .meta({ id: 'DuplicateResponseDto' });

const DuplicateResolveGroupSchema = z
  .object({
    duplicateId: z.uuidv4(),
    keepAssetIds: z.array(z.uuidv4()).describe('Asset IDs to keep'),
    trashAssetIds: z.array(z.uuidv4()).describe('Asset IDs to trash or delete'),
  })
  .meta({ id: 'DuplicateResolveGroupDto' });

const DuplicateResolveSchema = z
  .object({
    groups: z.array(DuplicateResolveGroupSchema).min(1).describe('List of duplicate groups to resolve'),
  })
  .meta({ id: 'DuplicateResolveDto' });

/** FL-520: "How alike they must be", as the maximum distances to estimate (repeated or comma-separated in the query). */
const DuplicateEstimateQuerySchema = z
  .object({
    maxDistances: z
      .preprocess(
        (value) => (Array.isArray(value) ? value : String(value).split(',')).map(Number),
        z
          .array(z.number().min(0.001).max(0.1).meta({ format: 'double' }))
          .min(1)
          .max(5),
      )
      .describe('The distances to estimate groups for, from 0.001 (nearly identical) to 0.1'),
  })
  .meta({ id: 'DuplicateEstimateQueryDto' });

const DuplicateEstimateChoiceSchema = z
  .object({
    maxDistance: z.number().meta({ format: 'double' }),
    groups: z.int().nonnegative().describe('About how many look-alike groups this choice makes in this library'),
  })
  .meta({ id: 'DuplicateEstimateChoiceDto' });

const DuplicateEstimateResponseSchema = z
  .object({
    comparable: z.int().nonnegative().describe('Photos and videos that are compared'),
    groups: z.int().nonnegative().describe('Look-alike groups found so far'),
    choices: z.array(DuplicateEstimateChoiceSchema).describe('An estimate for each distance asked for'),
    seconds: z.int().nonnegative().describe('About how long comparing every photo again takes'),
    sampled: z.int().nonnegative().describe('How many photos the estimate is based on'),
  })
  .meta({ id: 'DuplicateEstimateResponseDto' });

const DuplicateRecompareSchema = z
  .object({
    when: z
      .enum(['now', 'tonight'])
      .describe('now: start comparing every photo again; tonight: in the next overnight run')
      .meta({ id: 'DuplicateRecompareWhen' }),
  })
  .meta({ id: 'DuplicateRecompareDto' });

export class DuplicateEstimateQueryDto extends createZodDto(DuplicateEstimateQuerySchema) {}
export class DuplicateEstimateResponseDto extends createZodDto(DuplicateEstimateResponseSchema) {}
export class DuplicateRecompareDto extends createZodDto(DuplicateRecompareSchema) {}

export class DuplicateResponseDto extends createZodDto(DuplicateResponseSchema) {}
export class DuplicateResolveGroupDto extends createZodDto(DuplicateResolveGroupSchema) {}
export class DuplicateResolveDto extends createZodDto(DuplicateResolveSchema) {}
