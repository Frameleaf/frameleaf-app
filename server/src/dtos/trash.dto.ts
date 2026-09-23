import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetTypeSchema } from 'src/enum.js';
import { BULK_MAX_ITEMS } from 'src/utils/bulk-operation.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

const TrashResponseSchema = z
  .object({
    count: z.int().describe('Number of items in trash'),
  })
  .meta({ id: 'TrashResponseDto' });

export class TrashResponseDto extends createZodDto(TrashResponseSchema) {}

/* -------------------------------------------------------------------------- */
/* Reviewed trash (FL-47)                                                       */
/* -------------------------------------------------------------------------- */

export enum TrashItemSort {
  Recent = 'recent',
  Size = 'size',
  Name = 'name',
}

const TrashItemSortSchema = z
  .enum(TrashItemSort)
  .describe('Trash order: most recently deleted, largest original, or file name')
  .meta({ id: 'TrashItemSort' });

export const TrashReviewActionSchema = z
  .enum(TrashReviewAction)
  .describe('A reviewed change to items in, or into, the trash')
  .meta({ id: 'TrashReviewAction' });

const TrashSummaryResponseSchema = z
  .object({
    count: z.int().min(0).describe('Items in your trash this session can see'),
    bytes: z.int().min(0).describe('Combined size of their originals, in bytes. Not the space deleting them frees.'),
    pendingDeletion: z
      .int()
      .min(0)
      .describe('Items already permanently deleted whose files are still being removed from storage'),
  })
  .meta({ id: 'TrashSummaryResponseDto' });

const TrashItemsSchema = z
  .object({
    query: z.string().max(255).optional().describe('Words that must all appear in the file name'),
    type: AssetTypeSchema.optional(),
    sort: TrashItemSortSchema.optional(),
    page: z.coerce.number().int().min(1).default(1).optional().describe('Page number, from 1'),
    size: z.coerce.number().int().min(1).max(1000).default(200).optional().describe('Items per page'),
  })
  .meta({ id: 'TrashItemsDto' });

const TrashItemResponseSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    originalFileName: z.string().describe('Original file name'),
    type: AssetTypeSchema,
    fileSizeInByte: z.int().min(0).nullable().describe('Size of the original, in bytes, when known'),
    trashedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the item was moved to the trash'),
    isLocked: z.boolean().describe('Locked media; only listed for its owner in an unlocked session'),
    isOffline: z.boolean().describe('The original is missing from an external library'),
  })
  .meta({ id: 'TrashItemResponseDto' });

const TrashItemsResponseSchema = z
  .object({
    items: z.array(TrashItemResponseSchema),
    total: z.int().min(0).describe('Items matching the filters'),
    nextPage: z.string().nullable().describe('The next page number, or null on the last page'),
  })
  .meta({ id: 'TrashItemsResponseDto' });

const TrashReviewSchema = z
  .object({
    action: TrashReviewActionSchema,
    ids: z
      .array(z.uuidv4())
      .max(BULK_MAX_ITEMS)
      .optional()
      .describe('The chosen items, for trash, restore and delete. Ignored by restore-all and empty.'),
  })
  .meta({ id: 'TrashReviewDto' });

const TrashReviewResponseSchema = z
  .object({
    action: TrashReviewActionSchema,
    count: z.int().min(0).describe('Items the action will change'),
    bytes: z.int().min(0).describe('Combined size of their originals, in bytes'),
    retainedOriginals: z
      .int()
      .min(0)
      .describe('Items whose original another item still uses; deleting them does not free that file'),
    retainedBytes: z.int().min(0).describe('Size of those shared originals, in bytes'),
    names: z.array(z.string()).describe('The first file names, alphabetically'),
    token: z.string().describe('Fingerprint of the reviewed set; apply refuses when the set has changed'),
  })
  .meta({ id: 'TrashReviewResponseDto' });

const TrashApplySchema = TrashReviewSchema.extend({
  token: z.string().min(1).max(128).describe('The token returned by the review'),
}).meta({ id: 'TrashApplyDto' });

export class TrashSummaryResponseDto extends createZodDto(TrashSummaryResponseSchema) {}
export class TrashItemsDto extends createZodDto(TrashItemsSchema) {}
export class TrashItemResponseDto extends createZodDto(TrashItemResponseSchema) {}
export class TrashItemsResponseDto extends createZodDto(TrashItemsResponseSchema) {}
export class TrashReviewDto extends createZodDto(TrashReviewSchema) {}
export class TrashReviewResponseDto extends createZodDto(TrashReviewResponseSchema) {}
export class TrashApplyDto extends createZodDto(TrashApplySchema) {}
