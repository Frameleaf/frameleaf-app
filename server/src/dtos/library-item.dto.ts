import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import { BookmarkResponseSchema } from 'src/dtos/bookmark.dto.js';

const itemKind = z.enum(['asset', 'bookmark']).meta({ id: 'LibraryItemKind' });
const cursor = z.object({ kind: itemKind, id: z.uuidv4() });
export const LibraryItemSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('asset').meta({ id: 'LibraryAssetItemKind' }), asset: AssetResponseSchema }),
    z.object({ kind: z.literal('bookmark').meta({ id: 'LibraryBookmarkItemKind' }), bookmark: BookmarkResponseSchema }),
  ])
  .meta({ id: 'LibraryItemDto' });
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export class LibraryItemsQueryDto extends createZodDto(
  z
    .object({
      afterKind: itemKind.optional(),
      afterId: z.uuidv4().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    })
    .refine(({ afterKind, afterId }) => !!afterKind === !!afterId, 'Both cursor fields are required')
    .meta({ id: 'LibraryItemsQueryDto' }),
) {}

export class LibraryItemsResponseDto extends createZodDto(
  z
    .object({
      items: z.array(LibraryItemSchema),
      nextCursor: cursor.nullable(),
      assetCount: z.int().min(0),
      bookmarkCount: z.int().min(0),
      itemCount: z.int().min(0),
    })
    .meta({ id: 'LibraryItemsResponseDto' }),
) {}

export class BookmarkIdsDto extends createZodDto(
  z.object({ ids: z.array(z.uuidv4()).max(500) }).meta({ id: 'BookmarkIdsDto' }),
) {}
