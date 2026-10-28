import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { LibraryItemSchema } from 'src/dtos/library-item.dto.js';
import { SearchFilterSchema } from 'src/dtos/search.dto.js';

export class LibraryItemSearchDto extends createZodDto(
  z
    .strictObject({
      filter: SearchFilterSchema.default({}),
      query: z.string().trim().max(500).default(''),
      mode: z.enum(['text', 'smart']).meta({ id: 'LibraryItemSearchMode' }).default('text'),
      queryAssetId: z.uuid().optional(),
      sort: z.enum(['added', 'color']).meta({ id: 'LibraryItemSearchSort' }).optional(),
      limit: z.int().min(1).max(200).default(100),
      cursor: z.string().max(1024).optional(),
    })
    .refine(
      (query) => query.mode !== 'smart' || (!!query.query !== !!query.queryAssetId && query.sort === undefined),
      'Semantic search requires text or an image and uses relevance order',
    )
    .refine((query) => query.mode !== 'text' || !query.queryAssetId, 'Image similarity uses semantic search')
    .refine(
      (query) => query.sort !== 'color' || !!query.filter.color,
      'Color ordering requires a top-level color filter',
    )
    .meta({ id: 'LibraryItemSearchDto' }),
) {}

export class LibraryItemSearchResponseDto extends createZodDto(
  z
    .object({
      items: z.array(LibraryItemSchema),
      nextCursor: z.string().nullable(),
      count: z.int().min(0),
      countCapped: z.boolean().describe('The count covers bounded ranked candidates; more semantic matches may exist'),
    })
    .meta({ id: 'LibraryItemSearchResponseDto' }),
) {}
