import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import {
  MediaHealthCategorySchema,
  MediaHealthSeveritySchema,
  MediaHealthStatus,
  MediaHealthStatusSchema,
  MediaOperationStatusSchema,
} from 'src/enum.js';
import { stringToBool } from 'src/validation.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** Where a candidate was found (FL-69): library storage, an external library, or a recovery location. */
const MediaHealthRootKindSchema = z
  .enum(['managed', 'library', 'recovery'])
  .describe('Kind of search location')
  .meta({ id: 'MediaHealthRootKind' });

/** One recorded checksum, as lowercase hex (FL-69): what "exact match" was measured against. */
const MediaHealthChecksumSchema = z
  .object({
    algorithm: z.enum(['sha1', 'sha256']).describe('Checksum algorithm').meta({ id: 'MediaHealthChecksumAlgorithm' }),
    value: z.string().describe('Checksum as lowercase hex'),
  })
  .meta({ id: 'MediaHealthChecksumDto' });

/**
 * Who relinked or recovered a finding's original, from where and when (FL-69). Administrators only:
 * for anybody else the operator locations stay private and this is null.
 */
const MediaHealthProvenanceSchema = z
  .object({
    action: z.enum(['relinked', 'recovered']).describe('What was done').meta({ id: 'MediaHealthProvenanceAction' }),
    userId: z.string().nullable().describe('The account that did it'),
    rootId: z.string().nullable().describe('Search location the copy came from'),
    rootKind: MediaHealthRootKindSchema.nullable(),
    rootLabel: z.string().nullable().describe('Name of the search location'),
    at: z.string().meta({ format: 'date-time' }).nullable().describe('When it was done'),
    previousPath: z.string().nullable().describe('The path the original had before'),
    sourcePath: z.string().nullable().describe('The verified copy that was used'),
  })
  .meta({ id: 'MediaHealthProvenanceDto' });

const MediaHealthCandidateSchema = z
  .object({
    id: z.uuidv4().describe('Candidate ID'),
    healthId: z.uuidv4().describe('Media health finding ID'),
    candidatePath: z.string().describe('Candidate file path'),
    status: MediaHealthStatusSchema,
    visualMatchScore: z.number().meta({ format: 'double' }).nullable().describe('Visual match score from 0 to 1'),
    evidence: JsonObjectSchema,
    resolution: JsonObjectSchema,
    checkedAt: z.string().meta({ format: 'date-time' }),
    rootId: z.string().nullable().describe('Search location the candidate was found in'),
    rootKind: MediaHealthRootKindSchema.nullable(),
    checksumMatch: z.boolean().describe('The candidate has exactly the checksum recorded for the original'),
    decodeValid: z.boolean().nullable().describe('The candidate decoded successfully; null when not checked'),
    chosen: z.boolean().describe('The reviewer chose this candidate for the finding'),
    checksums: z.array(MediaHealthChecksumSchema).describe('The checksums the candidate matched, as measured'),
  })
  .meta({ id: 'MediaHealthCandidateDto' });

const MediaHealthItemSchema = z
  .object({
    id: z.uuidv4().describe('Media health finding ID'),
    assetId: z.uuidv4().describe('Asset ID'),
    category: MediaHealthCategorySchema,
    status: MediaHealthStatusSchema,
    severity: MediaHealthSeveritySchema,
    originalPath: z.string().describe('Original media path'),
    originalFileName: z.string().describe('Original media filename'),
    evidence: JsonObjectSchema,
    resolution: JsonObjectSchema,
    checkedAt: z.string().meta({ format: 'date-time' }),
    dismissedAt: z.string().meta({ format: 'date-time' }).nullable(),
    resolvedAt: z.string().meta({ format: 'date-time' }).nullable(),
    asset: AssetResponseSchema,
    candidates: z.array(MediaHealthCandidateSchema),
    expectedChecksums: z
      .array(MediaHealthChecksumSchema)
      .describe('The checksums recorded for the original, which a copy must match exactly'),
    provenance: MediaHealthProvenanceSchema.nullable(),
  })
  .meta({ id: 'MediaHealthItemDto' });

const MediaHealthBucketSchema = z
  .object({
    timeBucket: z.string().describe('Timeline bucket date'),
    count: z.int().describe('Number of findings in the bucket'),
    items: z.array(MediaHealthItemSchema),
  })
  .meta({ id: 'MediaHealthBucketDto' });

const MediaHealthRunResponseSchema = z
  .object({
    id: z.uuidv4().describe('Media health run ID'),
    category: MediaHealthCategorySchema,
    status: z.string().describe('Run status'),
    startedAt: z.string().meta({ format: 'date-time' }),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable(),
    totalAssets: z.int(),
    checkedAssets: z.int(),
    foundAssets: z.int(),
    error: z.string().nullable(),
  })
  .meta({ id: 'MediaHealthRunResponseDto' });

const MediaHealthListResponseSchema = z
  .object({
    buckets: z.array(MediaHealthBucketSchema),
    total: z.int(),
    run: MediaHealthRunResponseSchema.nullable(),
  })
  .meta({ id: 'MediaHealthListResponseDto' });

/**
 * Whose findings a Library Care read covers (FL-69). An owner always reviews their own; an
 * administrator may also review one other account or every account. Nobody's Locked media is ever
 * included except the reader's own, in their unlocked session.
 */
const MediaHealthScopeSchema = z.object({
  ownerId: z.uuidv4().optional().describe('Account to review; administrators only for another account'),
  allAccounts: stringToBool.optional().describe('Review every account; administrators only'),
});

const MediaHealthListQuerySchema = MediaHealthScopeSchema.extend({
  category: MediaHealthCategorySchema.optional(),
  status: MediaHealthStatusSchema.optional(),
  needsAttention: stringToBool.optional().describe('Only findings that still need a decision'),
  size: z.coerce.number().int().min(1).max(200).default(100).optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
}).meta({ id: 'MediaHealthListQueryDto' });

const MediaHealthSummaryQuerySchema = MediaHealthScopeSchema.meta({ id: 'MediaHealthSummaryQueryDto' });

const MediaHealthBulkActionSchema = z
  .object({
    ids: z.array(z.uuidv4()).min(1).max(1000).describe('Media health finding IDs'),
  })
  .meta({ id: 'MediaHealthBulkActionDto' });

const MediaHealthDeleteCorruptSchema = MediaHealthBulkActionSchema.extend({
  confirmText: z.string().describe('Typed confirmation text'),
}).meta({ id: 'MediaHealthDeleteCorruptDto' });

const MediaHealthLocateSchema = MediaHealthBulkActionSchema.extend({
  rootIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(50)
    .optional()
    .describe('Search locations; library storage and external libraries when omitted'),
}).meta({ id: 'MediaHealthLocateDto' });

const MediaHealthCandidateChoiceSchema = z
  .object({
    findingId: z.uuidv4().describe('Media health finding ID'),
    candidateId: z.uuidv4().describe('Candidate ID'),
  })
  .meta({ id: 'MediaHealthCandidateChoiceDto' });

const MediaHealthChooseCandidatesSchema = z
  .object({
    choices: z.array(MediaHealthCandidateChoiceSchema).min(1).max(1000),
  })
  .meta({ id: 'MediaHealthChooseCandidatesDto' });

const MediaHealthRecoverSchema = z
  .object({
    choices: z.array(MediaHealthCandidateChoiceSchema).min(1).max(1000),
    confirmed: z
      .boolean()
      .describe('Must be true: the reviewer checked the checksum and decode evidence and keeps the damaged source'),
  })
  .meta({ id: 'MediaHealthRecoverDto' });

const MediaHealthScanResponseSchema = z
  .object({
    runId: z.uuidv4(),
    operationId: z.uuidv7().nullable().optional().describe('The durable job doing the work, in Activity'),
  })
  .meta({ id: 'MediaHealthScanResponseDto' });

const MediaHealthBulkResultSchema = z
  .object({
    id: z.uuidv4(),
    success: z.boolean(),
    status: MediaHealthStatusSchema.optional(),
    error: z.string().optional(),
  })
  .meta({ id: 'MediaHealthBulkResultDto' });

const MediaHealthBulkResponseSchema = z
  .object({
    results: z.array(MediaHealthBulkResultSchema),
    operationId: z
      .uuidv7()
      .nullable()
      .optional()
      .describe('The durable job applying the accepted findings, in Activity; null when none was accepted'),
  })
  .meta({ id: 'MediaHealthBulkResponseDto' });

const MediaHealthRootSchema = z
  .object({
    id: z.string().describe('Search location ID'),
    kind: MediaHealthRootKindSchema,
    label: z.string(),
    paths: z.array(z.string()).describe('Folders searched, for review'),
  })
  .meta({ id: 'MediaHealthRootDto' });

const MediaHealthRootsResponseSchema = z
  .object({ roots: z.array(MediaHealthRootSchema) })
  .meta({ id: 'MediaHealthRootsResponseDto' });

/** The latest scan or search, as Library Care shows it (FL-69). A view of its `media_operation` row. */
const MediaHealthOperationSchema = z
  .object({
    id: z.uuidv7().describe('Media operation ID'),
    mode: z
      .enum(['scan', 'locate'])
      .describe('A library scan or a search for originals')
      .meta({ id: 'MediaHealthOperationMode' }),
    status: MediaOperationStatusSchema,
    progress: z.number().meta({ format: 'double' }),
    processedUnits: z.int(),
    totalUnits: z.int().nullable(),
    pauseRequestedAt: z.string().meta({ format: 'date-time' }).nullable(),
    cancelRequestedAt: z.string().meta({ format: 'date-time' }).nullable(),
    autoRetries: z.int(),
    error: z.string().nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'MediaHealthOperationDto' });

const MediaHealthActivitySchema = z
  .object({
    id: z.uuidv7().describe('Media operation ID'),
    action: z
      .enum(['scan', 'locate', 'relink-missing-media', 'recover-damaged-media', 'trash-damaged-media'])
      .describe('What the job did')
      .meta({ id: 'MediaHealthActivityAction' }),
    status: MediaOperationStatusSchema,
    items: z.int().describe('Items the job covered'),
    createdAt: z.string().meta({ format: 'date-time' }),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'MediaHealthActivityDto' });

const MediaHealthQueuesSchema = z
  .object({
    missing: z.int().describe('Missing originals that still need a decision'),
    missingVerified: z.int().describe('Missing originals with a verified exact copy'),
    damagedConfirmed: z.int(),
    damagedSuspected: z.int(),
    unsupportedRaw: z.int().describe('Kept apart from damage: the decoder cannot read the format'),
    duplicates: z.int().describe('Duplicate groups waiting for review'),
    importReview: z.int().nullable().describe('Imported items that need review; null when unavailable'),
    enrichmentPending: z.int().describe('Items whose metadata has not been read yet'),
  })
  .meta({ id: 'MediaHealthQueuesDto' });

const MediaHealthRunsSchema = z
  .object({
    missing: MediaHealthRunResponseSchema.nullable(),
    corrupt: MediaHealthRunResponseSchema.nullable(),
  })
  .meta({ id: 'MediaHealthRunsDto' });

/** The Library care settings that decide what Library Care offers (FL-69, settings-catalog.mjs:905-977). */
const MediaHealthCareSettingsSchema = z
  .object({
    healthScan: z.boolean().describe('Incremental health scans run on a schedule'),
    checksumScan: z.boolean().describe('Health scans verify original checksums'),
    integrityAudit: z.boolean().describe('Database and file reference audits run on their schedules'),
    rawRecovery: z.boolean().describe('Searches for originals include RAW originals'),
    duplicateReview: z.boolean().describe('Near-duplicates are grouped for review'),
  })
  .meta({ id: 'MediaHealthCareSettingsDto' });

const MediaHealthSummaryResponseSchema = z
  .object({
    queues: MediaHealthQueuesSchema,
    care: MediaHealthCareSettingsSchema,
    operation: MediaHealthOperationSchema.nullable(),
    runs: MediaHealthRunsSchema,
    recent: z.array(MediaHealthActivitySchema),
    recoveryAvailable: z.boolean().describe('At least one recovery location is configured for this reader'),
  })
  .meta({ id: 'MediaHealthSummaryResponseDto' });

export class MediaHealthCandidateDto extends createZodDto(MediaHealthCandidateSchema) {}
export class MediaHealthItemDto extends createZodDto(MediaHealthItemSchema) {}
export class MediaHealthBucketDto extends createZodDto(MediaHealthBucketSchema) {}
export class MediaHealthRunResponseDto extends createZodDto(MediaHealthRunResponseSchema) {}
export class MediaHealthListResponseDto extends createZodDto(MediaHealthListResponseSchema) {}
export class MediaHealthListQueryDto extends createZodDto(MediaHealthListQuerySchema) {}
export class MediaHealthSummaryQueryDto extends createZodDto(MediaHealthSummaryQuerySchema) {}
export class MediaHealthBulkActionDto extends createZodDto(MediaHealthBulkActionSchema) {}
export class MediaHealthDeleteCorruptDto extends createZodDto(MediaHealthDeleteCorruptSchema) {}
export class MediaHealthLocateDto extends createZodDto(MediaHealthLocateSchema) {}
export class MediaHealthChooseCandidatesDto extends createZodDto(MediaHealthChooseCandidatesSchema) {}
export class MediaHealthRecoverDto extends createZodDto(MediaHealthRecoverSchema) {}
export class MediaHealthScanResponseDto extends createZodDto(MediaHealthScanResponseSchema) {}
export class MediaHealthBulkResponseDto extends createZodDto(MediaHealthBulkResponseSchema) {}
export class MediaHealthRootsResponseDto extends createZodDto(MediaHealthRootsResponseSchema) {}
export class MediaHealthOperationDto extends createZodDto(MediaHealthOperationSchema) {}
export class MediaHealthSummaryResponseDto extends createZodDto(MediaHealthSummaryResponseSchema) {}

export type MediaHealthCandidateResponse = z.infer<typeof MediaHealthCandidateSchema>;
export type MediaHealthItemResponse = z.infer<typeof MediaHealthItemSchema>;
export type MediaHealthRootResponse = z.infer<typeof MediaHealthRootSchema>;
export type MediaHealthActivityResponse = z.infer<typeof MediaHealthActivitySchema>;

export const CORRUPT_MEDIA_DELETE_CONFIRM_TEXT = 'MOVE CORRUPT MEDIA TO TRASH';
export const CORRUPT_MEDIA_DELETE_RECENT_MS = 24 * 60 * 60 * 1000;

export const CORRUPT_DELETE_STATUSES = new Set<MediaHealthStatus>([MediaHealthStatus.CorruptConfirmed]);

/**
 * Statuses that are settled (FL-69): nothing is left to decide. Everything else "needs attention",
 * which is what Library Care shows by default. Unsupported RAW and suspected damage stay open on
 * purpose: they are kept, not resolved, until validation says otherwise.
 */
export const SETTLED_MEDIA_HEALTH_STATUSES: readonly MediaHealthStatus[] = [
  MediaHealthStatus.Relinked,
  MediaHealthStatus.Resolved,
  MediaHealthStatus.Dismissed,
  MediaHealthStatus.Trashed,
  MediaHealthStatus.Deleted,
];

export const NEEDS_ATTENTION_MEDIA_HEALTH_STATUSES: readonly MediaHealthStatus[] = Object.values(
  MediaHealthStatus,
).filter((status) => !SETTLED_MEDIA_HEALTH_STATUSES.includes(status));
