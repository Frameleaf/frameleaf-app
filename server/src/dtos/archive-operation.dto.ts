import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { BULK_MAX_ITEMS } from 'src/utils/bulk-operation.js';

/**
 * Transactional archive operations (FL-32, ported from PR #133).
 *
 * - `selected-owned-assets`: an explicit selection, frozen as submitted.
 * - `matching-owned-timeline`: every asset of the owner's own normal Timeline this session can see,
 *   counted and frozen by the server in one statement and held until the owner confirms that count.
 */
export enum ArchiveOperationScope {
  SelectedOwnedAssets = 'selected-owned-assets',
  MatchingOwnedTimeline = 'matching-owned-timeline',
}

export const ArchiveOperationScopeSchema = z
  .enum(ArchiveOperationScope)
  .describe('What an archive operation covers')
  .meta({ id: 'ArchiveOperationScope' });

const RequestKeySchema = z
  .uuidv4()
  .describe('Client idempotency key; the same key answers with the same operation instead of starting another');

export const ArchiveOperationCreateSchema = z
  .strictObject({
    requestKey: RequestKeySchema,
    assetIds: z.array(z.uuidv4()).min(1).max(BULK_MAX_ITEMS).describe('The selection, in order'),
  })
  .meta({ id: 'ArchiveOperationCreateDto' });

export const ArchiveOperationPrepareSchema = z
  .strictObject({
    requestKey: RequestKeySchema,
    scope: z
      .literal(ArchiveOperationScope.MatchingOwnedTimeline)
      .describe('Only the owner’s own normal Timeline can be prepared on the server')
      .meta({ id: 'ArchiveOperationPrepareScope' }),
  })
  .meta({ id: 'ArchiveOperationPrepareDto' });

export const ArchiveOperationConfirmSchema = z
  .strictObject({ requestKey: RequestKeySchema.describe('The request key the selection was prepared with') })
  .meta({ id: 'ArchiveOperationConfirmDto' });

export const ArchiveOperationUndoSchema = z
  .strictObject({ requestKey: RequestKeySchema })
  .meta({ id: 'ArchiveOperationUndoDto' });

export const ArchiveOperationResponseSchema = z
  .object({
    id: z.uuidv4().describe('Archive operation ID'),
    scope: ArchiveOperationScopeSchema,
    requestKey: z.uuidv4().describe('The request key the operation was created with'),
    count: z.int().min(0).describe('Assets frozen into this operation'),
    prepared: z.boolean().describe('Counted and frozen, waiting for the owner to confirm; nothing has changed yet'),
    expiresAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When an unconfirmed prepared selection stops being confirmable'),
    createdAt: z.string().meta({ format: 'date-time' }),
    archiveJobId: z.uuidv7().nullable().describe('The durable bulk job that archives the frozen set'),
    undoJobId: z.uuidv7().nullable().describe('The durable bulk job that undoes it, once requested'),
    pending: z.int().min(0).describe('Not reached yet'),
    archived: z.int().min(0).describe('Archived by this operation and not undone'),
    skipped: z
      .int()
      .min(0)
      .describe('Left as they were: no longer in the Timeline, or stopped before they were reached'),
    undone: z.int().min(0).describe('Restored by Undo'),
    conflict: z.int().min(0).describe('Changed after the archive, so Undo left them as they are'),
    undoable: z.boolean().describe('Undo is available for this operation'),
    currentSession: z
      .boolean()
      .describe('The operation was submitted or confirmed from the session asking, so it may offer its Undo'),
  })
  .meta({ id: 'ArchiveOperationResponseDto' });

export class ArchiveOperationCreateDto extends createZodDto(ArchiveOperationCreateSchema) {}
export class ArchiveOperationPrepareDto extends createZodDto(ArchiveOperationPrepareSchema) {}
export class ArchiveOperationConfirmDto extends createZodDto(ArchiveOperationConfirmSchema) {}
export class ArchiveOperationUndoDto extends createZodDto(ArchiveOperationUndoSchema) {}
export class ArchiveOperationResponseDto extends createZodDto(ArchiveOperationResponseSchema) {}
