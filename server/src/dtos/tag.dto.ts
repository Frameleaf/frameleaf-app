import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { MaybeDehydrated } from 'src/types.js';
import { Tag } from 'src/database.js';
import { asDateTimeString } from 'src/utils/date.js';
import { hexColor } from 'src/validation.js';

const TagCreateSchema = z
  .object({
    name: z
      .string()
      .regex(/^[^/]*$/, `Tag name cannot contain slash characters ("/")`)
      .describe('Tag name'),
    parentId: z.uuidv4().nullish().describe('Parent tag ID'),
    color: hexColor.nullable().optional().describe('Tag color (hex)'),
  })
  .meta({ id: 'TagCreateDto' });

export const TagUpdateSchema = z
  .object({
    name: z
      .string()
      .regex(/^[^/]*$/, `Tag name cannot contain slash characters ("/")`)
      .optional()
      .describe('Tag name'),
    color: hexColor.nullable().optional().describe('Tag color (hex)'),
    parentId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe(
        'Move the tag under this parent tag; null moves it to the top level. The tag and all its descendants take the new path',
      ),
  })
  .meta({ id: 'TagUpdateDto' });

const TagUpsertSchema = z
  .object({
    tags: z.array(z.string()).describe('Tag names to upsert'),
  })
  .meta({ id: 'TagUpsertDto' });

const TagBulkAssetsSchema = z
  .object({
    tagIds: z.array(z.uuidv4()).describe('Tag IDs'),
    assetIds: z.array(z.uuidv4()).describe('Asset IDs'),
  })
  .meta({ id: 'TagBulkAssetsDto' });

const TagBulkAssetsResponseSchema = z
  .object({
    count: z.int().describe('Number of assets tagged'),
  })
  .meta({ id: 'TagBulkAssetsResponseDto' });

export const TagResponseSchema = z
  .object({
    id: z.uuidv4().describe('Tag ID'),
    parentId: z.string().optional().describe('Parent tag ID'),
    name: z.string().describe('Tag name'),
    value: z.string().describe('Tag value (full path)'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
    color: z.string().optional().describe('Tag color (hex)'),
  })
  .meta({ id: 'TagResponseDto' });

/**
 * FL-46: how many items carry each tag, as the Tags browser counts them. `total` is what "Show all"
 * opens (the tag filter matches a tag and every tag under it); `count` is the items carrying exactly
 * this tag. Only Timeline items are counted, so nothing archived, Locked or hidden, and a tag the
 * session may not see is left out.
 */
const TagStatisticsResponseSchema = z
  .object({
    id: z.uuidv4().describe('Tag ID'),
    count: z.int().min(0).describe('Timeline items tagged with exactly this tag'),
    total: z.int().min(0).describe('Timeline items tagged with this tag or any tag nested under it'),
  })
  .meta({ id: 'TagStatisticsResponseDto' });

export class TagCreateDto extends createZodDto(TagCreateSchema) {}
export class TagUpdateDto extends createZodDto(TagUpdateSchema) {}
export class TagUpsertDto extends createZodDto(TagUpsertSchema) {}
export class TagBulkAssetsDto extends createZodDto(TagBulkAssetsSchema) {}
export class TagBulkAssetsResponseDto extends createZodDto(TagBulkAssetsResponseSchema) {}
export class TagResponseDto extends createZodDto(TagResponseSchema) {}
export class TagStatisticsResponseDto extends createZodDto(TagStatisticsResponseSchema) {}

export function mapTag(entity: MaybeDehydrated<Tag>): TagResponseDto {
  return {
    id: entity.id,
    parentId: entity.parentId ?? undefined,
    name: entity.value.split('/').at(-1) as string,
    value: entity.value,
    createdAt: asDateTimeString(entity.createdAt),
    updatedAt: asDateTimeString(entity.updatedAt),
    color: entity.color ?? undefined,
  };
}
