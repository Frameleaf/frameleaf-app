import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ASSET_LEDGER_STATES } from 'src/schema/tables/asset-ledger.table.js';

/** FL-921: the nothing-lost ledger, where every original the server accepted is now. */

/** The most rows one page of the ledger returns. */
export const MAX_LEDGER_PAGE = 1000;

const AssetLedgerStateSchema = z
  .enum(ASSET_LEDGER_STATES)
  .describe(
    'Where an original is now: kept, in the Trash, removed, sharing an identical file (merged), or missing with no record of a removal',
  )
  .meta({ id: 'AssetLedgerState' });

const AssetLedgerCountsSchema = z
  .object({
    kept: z.int().min(0).describe('Originals in the library'),
    trashed: z.int().min(0).describe('Originals in the Trash'),
    removed: z.int().min(0).describe('Originals somebody removed, or whose time in the Trash ran out'),
    merged: z.int().min(0).describe('Originals that share an identical file; their own copy went to Unused files'),
    missing: z.int().min(0).describe('Originals that are gone with no record of a removal'),
  })
  .meta({ id: 'AssetLedgerCountsDto' });

const AssetLedgerSummarySchema = z
  .object({
    total: z.int().min(0).describe('Every original the server has accepted for this account'),
    states: AssetLedgerCountsSchema,
  })
  .meta({ id: 'AssetLedgerSummaryResponseDto' });

const AssetLedgerMissingOwnerSchema = z
  .object({
    ownerId: z.string().describe('The account the originals belonged to'),
    count: z.int().min(0).describe('Originals of that account that are missing'),
    since: z.string().meta({ format: 'date-time' }).describe('When the first of them was found missing'),
  })
  .meta({ id: 'AssetLedgerMissingOwnerDto' });

const AssetLedgerAdminSummarySchema = z
  .object({
    total: z.int().min(0).describe('Every original the server has accepted, for every account'),
    states: AssetLedgerCountsSchema,
    missingByOwner: z
      .array(AssetLedgerMissingOwnerSchema)
      .describe('The accounts with originals the server cannot account for, most first. No file is named.'),
  })
  .meta({ id: 'AssetLedgerAdminSummaryResponseDto' });

const AssetLedgerItemSchema = z
  .object({
    assetId: z.string().describe('The id the original had, or has, in the library'),
    checksum: z.string().describe('Its content checksum, base64'),
    originalFileName: z.string().describe('Its file name'),
    addedAt: z.string().meta({ format: 'date-time' }).describe('When the server accepted it'),
    addedVia: z
      .string()
      .describe(
        'How it arrived, for example upload, library-scan, import, partner-copy, studio, recovered or unknown. More may be added.',
      ),
    state: AssetLedgerStateSchema,
    stateAt: z.string().meta({ format: 'date-time' }).describe('When it came to be in this state'),
    stateBy: z.string().nullable().describe('The account that put it there; null when Frameleaf did'),
    reason: z
      .string()
      .nullable()
      .describe(
        'Why, when there is a reason, for example deleted, trash-expired, library-removed, account-removed, identical-file, not-found or found. More may be added.',
      ),
  })
  .meta({ id: 'AssetLedgerItemDto' });

const AssetLedgerListSchema = z
  .object({
    items: z.array(AssetLedgerItemSchema).describe('The newest change first'),
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null on the last page'),
  })
  .meta({ id: 'AssetLedgerListResponseDto' });

const AssetLedgerQuerySchema = z
  .object({
    state: AssetLedgerStateSchema.optional().describe('Only originals in this state'),
    cursor: z.string().max(128).optional().describe('The nextCursor of the previous page'),
    size: z.coerce.number().int().min(1).max(MAX_LEDGER_PAGE).default(200).optional().describe('Items per page'),
  })
  .meta({ id: 'AssetLedgerQueryDto' });

export class AssetLedgerSummaryResponseDto extends createZodDto(AssetLedgerSummarySchema) {}
export class AssetLedgerAdminSummaryResponseDto extends createZodDto(AssetLedgerAdminSummarySchema) {}
export class AssetLedgerListResponseDto extends createZodDto(AssetLedgerListSchema) {}
export class AssetLedgerQueryDto extends createZodDto(AssetLedgerQuerySchema) {}
