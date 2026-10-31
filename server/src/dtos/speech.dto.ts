import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import { SearchFilterSchema } from 'src/dtos/search.dto.js';
import { ImageEnrichmentFilterSchema } from 'src/enum.js';

const SpeechScopeSchema = z.enum(['library', 'albums']).meta({ id: 'SpeechScope' });
const SpeechIndexErrorSchema = z.enum(['unavailable', 'failed']).meta({ id: 'SpeechIndexError' });
export const SpeechSettingsSchema = z
  .object({
    enabled: z.boolean(),
    scope: SpeechScopeSchema,
    albumIds: z.array(z.uuid()).max(1000),
    destinationId: z.uuid().nullable(),
  })
  .meta({ id: 'SpeechSettings' });
export const SpeechRevisionSchema = z.object({
  expectedGeneration: z
    .uuid()
    .nullable()
    .describe('The generation last read; null only before the first configuration. Stale writes return 409.'),
});
export class SpeechRevisionDto extends createZodDto(SpeechRevisionSchema.meta({ id: 'SpeechRevisionDto' })) {}
export class SpeechSettingsUpdateDto extends createZodDto(SpeechSettingsSchema.extend(SpeechRevisionSchema.shape)) {}
export class SpeechCapabilitiesDto extends createZodDto(
  z.object({ version: z.int().min(1).max(1) }).meta({ id: 'SpeechCapabilitiesDto' }),
) {}
export class SpeechStatusDto extends createZodDto(
  SpeechSettingsSchema.extend({
    generation: z.uuid().nullable(),
    indexed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    workerAvailable: z.boolean(),
    error: SpeechIndexErrorSchema.nullable(),
  }).meta({ id: 'SpeechStatusDto' }),
) {}
export class SpeechSearchDto extends createZodDto(
  z
    .object({
      query: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          'Literal Unicode letter/number tokens, case insensitive, no stemming. Terms are ANDed; straight or smart double quotes require consecutive tokens. Unspaced Chinese/Japanese/Korean characters are indexed individually and contiguous input remains consecutive. Between 1 and 64 normalized tokens total; each token at most 2046 UTF-8 bytes.',
        ),
      assetId: z
        .uuid()
        .optional()
        .describe('Restrict to one matching video, including when loading its next occurrence page.'),
      hitCursor: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'The item nextHitCursor; requires assetId and the same query and filters. Separate from video pagination; binds the completed transcript identity. Stale cursors return 409 with code speech_cursor_stale.',
        ),
      filter: SearchFilterSchema.optional(),
      imageEnrichment: ImageEnrichmentFilterSchema.optional(),
      size: z.number().int().min(1).max(100).default(25),
      cursor: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'Video keyset cursor bound to this owner, literal query, filters, scope, model and index version. Stale cursors return 409 with code speech_cursor_stale. Newly completed videos may appear on later pages.',
        ),
    })
    .meta({ id: 'SpeechSearchDto' }),
) {}
export const SpeechHitSchema = z
  .object({
    text: z.string(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .meta({ id: 'SpeechHit' });
export class SpeechSearchResponseDto extends createZodDto(
  z
    .object({
      items: z.array(
        z
          .object({
            asset: AssetResponseSchema,
            transcriptId: z
              .uuid()
              .describe(
                'Completed index identity. Revalidate the same query restricted to assetId before playback; reject a changed transcriptId.',
              ),
            hits: z.array(SpeechHitSchema),
            hitsTotal: z.number().int().nonnegative(),
            nextHitCursor: z.string().nullable(),
          })
          .meta({ id: 'SpeechSearchItem' }),
      ),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().nullable(),
    })
    .meta({ id: 'SpeechSearchResponseDto' }),
) {}
