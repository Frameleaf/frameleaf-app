import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { stringToBool } from 'src/validation.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** A client-chosen identifier: one editor instance, or one attempt at a write. */
const IdentifierSchema = z
  .string()
  .regex(/^[\w.:-]{1,128}$/)
  .describe('Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters');

/**
 * The stored document: Freecut's graph wrapped in the four fields the server owns.
 *
 * `graph` is passed through opaquely. The server measures and digests it and never reads inside
 * it, so a field this version has never heard of survives a save and a reload unchanged.
 */
const StudioProjectEnvelopeSchema = z
  .object({
    schemaVersion: z.int().describe('Envelope shape version; the server accepts exactly one'),
    engine: z.string().describe('The engine that produced the graph; `freecut`'),
    engineRevision: z.string().min(1).max(200).describe('Pinned engine revision the editor was built from'),
    graph: JsonObjectSchema.describe('Opaque engine document, stored and returned byte for byte'),
  })
  .meta({ id: 'StudioProjectEnvelopeDto' });

/** An exact instant on the timeline, in seconds, as a reduced fraction (FL-93). */
const StudioTimeSchema = z
  .object({
    num: z.int().min(0).describe('Numerator; zero is the start of the sequence'),
    den: z.int().min(1).describe('Denominator'),
  })
  .meta({ id: 'StudioTimeDto' });

/** What a save says it contains: command ids and how often each appeared. Display only. */
const StudioCommandSummarySchema = z
  .object({
    counts: z.record(z.string(), z.int().min(0)).describe('Command id to how many times it appeared'),
    total: z.int().min(0).describe('Commands in the batch'),
  })
  .meta({ id: 'StudioCommandSummaryDto' });

const StudioProjectLeaseSchema = z
  .object({
    heldByYou: z.boolean().describe('This client holds the write lease'),
    heldByAnother: z.boolean().describe('A live lease belongs to another editor instance'),
    expiresAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the current lease lapses'),
    leaseMs: z.int().describe('Lease length the server grants'),
    renewMs: z.int().describe('How often the holder should renew'),
    autosaveDebounceMs: z.int().describe('Pause in editing after which the client saves'),
  })
  .meta({ id: 'StudioProjectLeaseDto' });

/**
 * A reviewer's view of whether the current graph could be shown to them.
 *
 * Review fails closed: when any source the graph references is unavailable to the acting
 * account, the graph and its digest are withheld entirely rather than shown with holes.
 */
const StudioProjectResourcesSchema = z
  .object({
    complete: z.boolean().describe('Every referenced source resolved for the acting account'),
    refusedCount: z.int().min(0).describe('References that were refused for the acting account'),
    checkedAt: z.string().meta({ format: 'date-time' }).describe('When the resolution ran'),
  })
  .meta({ id: 'StudioProjectResourcesDto' });

const StudioProjectAccessSchema = z
  .enum(['owner', 'reviewer'])
  .describe('`owner` may write; `reviewer` reaches the project through a shared space, read-only')
  .meta({ id: 'StudioProjectAccess' });

/**
 * Where a project sits in its owner's library (FL-91). The archive and the trash are the owner's
 * shelves; a reviewer only ever sees active projects.
 */
const StudioProjectShelfSchema = z
  .enum(['active', 'archived', 'trashed'])
  .describe('`active`, `archived` (put away, read-only) or `trashed` (restorable until `purgeAfter`)')
  .meta({ id: 'StudioProjectShelf' });

const StudioProjectSortSchema = z
  .enum(['updated', 'recent', 'name'])
  .describe('`updated` newest change first, `recent` last opened first, `name` alphabetical')
  .meta({ id: 'StudioProjectSort' });

const StudioProjectSchema = z
  .object({
    id: z.uuidv7().describe('Studio project ID'),
    ownerId: z.uuidv4().describe('The only account that may write'),
    name: z.string(),
    spaceId: z.uuidv4().nullable().describe('Shared space whose members may review the project'),
    revision: z.int().min(0).describe('Head revision number; 0 until the first save'),
    access: StudioProjectAccessSchema,
    lease: StudioProjectLeaseSchema,
    shelf: StudioProjectShelfSchema,
    archivedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the owner archived it'),
    deletedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When it was moved to the trash'),
    purgeAfter: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When a trashed project is deleted for good; its library media is never touched'),
    lastOpenedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When an editor last opened it; null for a reviewer'),
    thumbnailAssetId: z
      .uuidv4()
      .nullable()
      .describe('Library asset the owner chose as the poster; null for a reviewer'),
    duplicatedFromId: z.uuidv7().nullable().describe('The project this one was duplicated from; null for a reviewer'),
    importedFromBundle: z
      .boolean()
      .describe('The project was read in from a portable bundle; always false for a reviewer'),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'StudioProjectDto' });

const StudioProjectDetailSchema = StudioProjectSchema.extend({
  /** The head document, or null before the first save and when review withholds it. */
  envelope: StudioProjectEnvelopeSchema.nullable(),
  digest: z.string().nullable().describe('Key-sorted SHA-256 of the head envelope; null when withheld'),
  /** True when the graph exists but the acting account may not see it. */
  withheld: z.boolean().describe('The graph was withheld because a source is unavailable to you'),
  resources: StudioProjectResourcesSchema.nullable(),
}).meta({ id: 'StudioProjectDetailDto' });

const StudioProjectListResponseSchema = z
  .object({
    items: z.array(StudioProjectSchema),
    total: z.int().describe('Matching projects, before paging'),
  })
  .meta({ id: 'StudioProjectListResponseDto' });

const StudioProjectSearchSchema = z
  .object({
    take: z.coerce.number().int().min(1).max(200).default(50).optional(),
    skip: z.coerce.number().int().min(0).default(0).optional(),
  })
  .meta({ id: 'StudioProjectSearchDto' });

/** The project library's query (FL-91): one shelf, optionally filtered by name, in one order. */
const StudioProjectLibrarySearchSchema = StudioProjectSearchSchema.extend({
  shelf: StudioProjectShelfSchema.optional().describe('Which shelf to list; `active` when omitted'),
  query: z.string().trim().max(200).optional().describe('Case-insensitive part of the name'),
  sort: StudioProjectSortSchema.optional(),
}).meta({ id: 'StudioProjectLibrarySearchDto' });

const StudioProjectDeleteQuerySchema = z
  .object({
    permanent: stringToBool
      .optional()
      .describe('Delete for good instead of moving to the trash. Library media is never touched either way.'),
  })
  .meta({ id: 'StudioProjectDeleteQueryDto' });

const StudioProjectDuplicateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Name of the copy; the client supplies the translated default'),
  })
  .meta({ id: 'StudioProjectDuplicateDto' });

const StudioProjectTrashEmptyResponseSchema = z
  .object({
    count: z.int().min(0).describe('Projects deleted for good'),
  })
  .meta({ id: 'StudioProjectTrashEmptyResponseDto' });

const StudioProjectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    clientId: IdentifierSchema.describe('This editor instance; it receives the lease'),
    spaceId: z.uuidv4().nullable().optional().describe('Share the project with a shared space for review'),
    envelope: StudioProjectEnvelopeSchema.optional().describe('An initial document, saved as revision 1'),
    requestKey: IdentifierSchema.optional().describe('Idempotency key for the initial save'),
  })
  .meta({ id: 'StudioProjectCreateDto' });

const StudioProjectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    spaceId: z.uuidv4().nullable().optional().describe('Set or clear the reviewing shared space'),
    archived: z.boolean().optional().describe('Archive (read-only, off the active shelf) or bring back'),
    thumbnailAssetId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe('A library asset you can read, shown as the poster; null clears it'),
  })
  .meta({ id: 'StudioProjectUpdateDto' });

const StudioProjectLeaseRequestSchema = z
  .object({
    clientId: IdentifierSchema,
    takeover: z
      .boolean()
      .optional()
      .describe('Take a live lease away from another of your editor instances; never implicit'),
  })
  .meta({ id: 'StudioProjectLeaseRequestDto' });

/** One canonical Studio command (FL-92), as the editor issued it. Checked against the catalogue. */
const StudioCommandEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(100).describe('Published command id (studio/frameleaf-studio-commands.json)'),
    payload: z.record(z.string(), z.unknown()).describe('Command payload; graph-shaped values pass through unread'),
    revision: z.int().min(0).describe('The head revision the command was issued against'),
    idempotencyKey: z.string().min(1).max(128),
    issuedAt: z.number().meta({ format: 'double' }).describe('Epoch milliseconds'),
  })
  .meta({ id: 'StudioCommandEnvelopeDto' });

const StudioProjectSaveSchema = z
  .object({
    clientId: IdentifierSchema,
    requestKey: IdentifierSchema.describe('Stable per attempt; a retry carries the same key'),
    expectedRevision: z.int().min(0).describe('The head this document was built on'),
    envelope: StudioProjectEnvelopeSchema,
    summary: StudioCommandSummarySchema.optional(),
    commands: z
      .array(StudioCommandEnvelopeSchema)
      .max(500)
      .optional()
      .describe(
        'The canonical commands the engine applied to produce this document (FL-92). Each is checked against the catalogue and the head, and the revision summary is counted from them.',
      ),
  })
  .meta({ id: 'StudioProjectSaveDto' });

const StudioProjectRestoreSchema = z
  .object({
    clientId: IdentifierSchema,
    requestKey: IdentifierSchema,
    expectedRevision: z.int().min(0).describe('The current head; the restore appends after it'),
    revision: z.int().min(1).describe('The historical revision to bring back'),
  })
  .meta({ id: 'StudioProjectRestoreDto' });

const StudioProjectSaveResponseSchema = z
  .object({
    revision: z.int().min(0).describe('The head after this request'),
    revisionId: z.uuidv7().nullable().describe('The revision row; null when nothing was written'),
    digest: z.string().describe('Digest of the head envelope'),
    replayed: z.boolean().describe('This request key was already accepted; the earlier result is returned'),
    unchanged: z.boolean().describe('The document equals the head, so no revision was written'),
    lease: StudioProjectLeaseSchema,
  })
  .meta({ id: 'StudioProjectSaveResponseDto' });

const StudioProjectRevisionSchema = z
  .object({
    id: z.uuidv7(),
    revision: z.int().min(1),
    authorId: z.uuidv4().nullable(),
    digest: z.string().nullable().describe('Null for a reviewer; the digest travels with the graph'),
    graphBytes: z.int(),
    summary: StudioCommandSummarySchema,
    restoredFromRevision: z.int().nullable().describe('Set when this revision restored an earlier one'),
    createdAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'StudioProjectRevisionDto' });

const StudioProjectHistoryResponseSchema = z
  .object({
    items: z.array(StudioProjectRevisionSchema).describe('Newest first'),
    total: z.int(),
  })
  .meta({ id: 'StudioProjectHistoryResponseDto' });

const StudioProjectRevisionDetailSchema = StudioProjectRevisionSchema.extend({
  envelope: StudioProjectEnvelopeSchema.nullable(),
  withheld: z.boolean(),
  resources: StudioProjectResourcesSchema.nullable(),
}).meta({ id: 'StudioProjectRevisionDetailDto' });

const StudioRevisionParamSchema = z.object({
  id: z.uuidv7(),
  revision: z.coerce.number().int().min(1),
});

const StudioProjectDiffQuerySchema = z
  .object({
    against: z.coerce.number().int().min(1).describe('The earlier revision to compare with'),
  })
  .meta({ id: 'StudioProjectDiffQueryDto' });

/**
 * What changed between two revisions, without the values.
 *
 * The graph is opaque and may carry private text (clip names, captions, comments), so a diff
 * reports paths and counts only. That is enough to see that a colour grade changed on the third
 * clip, and nothing more.
 */
const StudioProjectDiffSchema = z
  .object({
    from: z.int().min(1),
    to: z.int().min(1),
    identical: z.boolean().describe('The two envelopes have the same digest'),
    byteDelta: z.int().describe('Size change of the serialized graph'),
    added: z.int().min(0),
    removed: z.int().min(0),
    changed: z.int().min(0),
    paths: z.array(z.string()).describe('Changed graph paths, aggregated and capped'),
    truncated: z.boolean().describe('More paths changed than are listed'),
    commands: StudioCommandSummarySchema.describe('Commands the saves between the two revisions reported'),
  })
  .meta({ id: 'StudioProjectDiffDto' });

const StudioCommentSchema = z
  .object({
    id: z.uuidv7(),
    projectId: z.uuidv7(),
    authorId: z.uuidv4(),
    revision: z.int().min(0).describe('The revision the reviewer was looking at'),
    time: StudioTimeSchema,
    text: z.string(),
    resolvedAt: z.string().meta({ format: 'date-time' }).nullable(),
    resolvedById: z.uuidv4().nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'StudioCommentDto' });

const StudioCommentListResponseSchema = z
  .object({
    items: z.array(StudioCommentSchema).describe('Oldest first'),
    total: z.int(),
  })
  .meta({ id: 'StudioCommentListResponseDto' });

const StudioCommentCreateSchema = z
  .object({
    revision: z.int().min(0),
    time: StudioTimeSchema,
    text: z.string().trim().min(1).max(2000),
    requestKey: IdentifierSchema.optional(),
  })
  .meta({ id: 'StudioCommentCreateDto' });

const StudioCommentUpdateSchema = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    resolved: z.boolean().optional(),
  })
  .meta({ id: 'StudioCommentUpdateDto' });

const StudioCommentParamSchema = z.object({
  id: z.uuidv7(),
  commentId: z.uuidv7(),
});

export class StudioProjectEnvelopeDto extends createZodDto(StudioProjectEnvelopeSchema) {}
export class StudioTimeDto extends createZodDto(StudioTimeSchema) {}
export class StudioCommandSummaryDto extends createZodDto(StudioCommandSummarySchema) {}
export class StudioProjectLeaseDto extends createZodDto(StudioProjectLeaseSchema) {}
export class StudioProjectResourcesDto extends createZodDto(StudioProjectResourcesSchema) {}
export class StudioProjectDto extends createZodDto(StudioProjectSchema) {}
export class StudioProjectDetailDto extends createZodDto(StudioProjectDetailSchema) {}
export class StudioProjectListResponseDto extends createZodDto(StudioProjectListResponseSchema) {}
export class StudioProjectSearchDto extends createZodDto(StudioProjectSearchSchema) {}
export class StudioProjectLibrarySearchDto extends createZodDto(StudioProjectLibrarySearchSchema) {}
export class StudioProjectDeleteQueryDto extends createZodDto(StudioProjectDeleteQuerySchema) {}
export class StudioProjectDuplicateDto extends createZodDto(StudioProjectDuplicateSchema) {}
export class StudioProjectTrashEmptyResponseDto extends createZodDto(StudioProjectTrashEmptyResponseSchema) {}
export class StudioProjectCreateDto extends createZodDto(StudioProjectCreateSchema) {}
export class StudioProjectUpdateDto extends createZodDto(StudioProjectUpdateSchema) {}
export class StudioProjectLeaseRequestDto extends createZodDto(StudioProjectLeaseRequestSchema) {}
export class StudioProjectSaveDto extends createZodDto(StudioProjectSaveSchema) {}
export class StudioProjectRestoreDto extends createZodDto(StudioProjectRestoreSchema) {}
export class StudioProjectSaveResponseDto extends createZodDto(StudioProjectSaveResponseSchema) {}
export class StudioProjectRevisionDto extends createZodDto(StudioProjectRevisionSchema) {}
export class StudioProjectHistoryResponseDto extends createZodDto(StudioProjectHistoryResponseSchema) {}
export class StudioProjectRevisionDetailDto extends createZodDto(StudioProjectRevisionDetailSchema) {}
export class StudioRevisionParamDto extends createZodDto(StudioRevisionParamSchema) {}
export class StudioProjectDiffQueryDto extends createZodDto(StudioProjectDiffQuerySchema) {}
export class StudioProjectDiffDto extends createZodDto(StudioProjectDiffSchema) {}
export class StudioCommentDto extends createZodDto(StudioCommentSchema) {}
export class StudioCommentListResponseDto extends createZodDto(StudioCommentListResponseSchema) {}
export class StudioCommentCreateDto extends createZodDto(StudioCommentCreateSchema) {}
export class StudioCommentUpdateDto extends createZodDto(StudioCommentUpdateSchema) {}
export class StudioCommentParamDto extends createZodDto(StudioCommentParamSchema) {}

/* Workspace layout (FL-91) */

/** The largest layout document accepted, measured as JSON. A layout is panels and sizes, not media. */
export const STUDIO_WORKSPACE_MAX_BYTES = 256 * 1024;

const StudioWorkspaceSchema = z
  .object({
    layout: JsonObjectSchema.nullable().describe(
      'The engine layout as the same JSON value it was saved as (key order and spacing are not kept); null when none is stored',
    ),
    engineRevision: z.string().nullable().describe('The engine revision that wrote the layout'),
    savedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'StudioWorkspaceDto' });

const StudioWorkspaceSaveSchema = z
  .object({
    layout: JsonObjectSchema.refine(
      (value) => JSON.stringify(value).length <= STUDIO_WORKSPACE_MAX_BYTES,
      'The layout is larger than 256 KiB',
    ).describe('The engine layout; stored and returned as the same JSON value (key order and spacing are not kept)'),
    engineRevision: z.string().min(1).max(200).describe('The pinned engine revision writing it'),
  })
  .meta({ id: 'StudioWorkspaceSaveDto' });

export class StudioWorkspaceDto extends createZodDto(StudioWorkspaceSchema) {}
export class StudioWorkspaceSaveDto extends createZodDto(StudioWorkspaceSaveSchema) {}
