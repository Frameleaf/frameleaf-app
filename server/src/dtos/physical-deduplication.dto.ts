import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  AssetTypeSchema,
  MediaOperationStatusSchema,
  PhysicalDeduplicationDecisionSchema,
  PhysicalDeduplicationPlanModeSchema,
  PhysicalDeduplicationSkipReasonSchema,
} from 'src/enum.js';

/**
 * Physical deduplication preview contract (FL-71).
 *
 * The dry-run job stores one `PhysicalDeduplicationMigrationState` record in system metadata.
 * The per-copy evidence below is part of that stored record; the response DTOs add what only
 * the reading request can know: owner display names and whether the requesting administrator
 * may view each asset's thumbnail. Thumbnail pixels are never embedded here. The web client
 * fetches them through the ordinary `/assets/{id}/thumbnail` endpoint, which enforces asset
 * access on its own, and `canView` is the same `AssetRead` access check evaluated for the
 * requester at read time so the page never has to request a thumbnail it would be refused.
 */

/** Upper bound of duplicate copies kept in one stored preview. */
export const PHYSICAL_DEDUPLICATION_PREVIEW_LIMIT = 500;

const checksum = z.string().describe('Hex-encoded SHA-1 checksum of the original file');

/**
 * What the preview's detail line shows beside owner and size (FL-73, prototype
 * PhysicalDedupManager.jsx:315-318): pixel dimensions, and for a video its length. Optional in the
 * stored record, which older previews wrote without them.
 */
const mediaDetail = {
  width: z.int().nonnegative().nullable().optional().describe('Width in pixels, when known'),
  height: z.int().nonnegative().nullable().optional().describe('Height in pixels, when known'),
  duration: z.int().nonnegative().nullable().optional().describe('Video length in milliseconds, when known'),
};

const mediaDetailResponse = {
  width: z.int().nonnegative().nullable().describe('Width in pixels, when known'),
  height: z.int().nonnegative().nullable().describe('Height in pixels, when known'),
  duration: z.int().nonnegative().nullable().describe('Video length in milliseconds, when known'),
};

const PhysicalDeduplicationRetainedStateSchema = z.object({
  assetId: z.string().describe('Asset that keeps the original file'),
  ownerId: z.string().describe('Owner of the retained asset (the retained account)'),
  originalFileName: z.string(),
  originalPath: z.string().describe('Path of the retained original file'),
  type: AssetTypeSchema,
  sizeInBytes: z.number().int().nonnegative(),
  checksum,
  referencesBefore: z
    .number()
    .int()
    .nonnegative()
    .describe('Assets that reference this original before the plan is applied (including the retained asset)'),
  referencesAfter: z
    .number()
    .int()
    .nonnegative()
    .describe('Assets that would reference this original after the plan is applied'),
  fileAvailable: z
    .boolean()
    .optional()
    .describe('Whether the retained original was on disk when the preview ran (FL-73); absent on older records'),
  ...mediaDetail,
});

const PhysicalDeduplicationCopyStateSchema = z.object({
  assetId: z.string().describe('Duplicate asset owned by a non-retained account'),
  ownerId: z.string(),
  originalFileName: z.string(),
  originalPath: z.string().describe('Path of the duplicate copy on disk'),
  type: AssetTypeSchema,
  sizeInBytes: z.number().int().nonnegative(),
  checksum,
  retainedAssetId: z.string().nullable().describe('Retained original this copy matches, if any'),
  checksumMatch: z.boolean().describe('Whether checksum and byte size match a retained original'),
  decision: PhysicalDeduplicationDecisionSchema,
  reason: PhysicalDeduplicationSkipReasonSchema.nullable().describe('Present when the decision is skip'),
  ...mediaDetail,
});

export type PhysicalDeduplicationRetainedState = z.infer<typeof PhysicalDeduplicationRetainedStateSchema>;
export type PhysicalDeduplicationCopyState = z.infer<typeof PhysicalDeduplicationCopyStateSchema>;

const PhysicalDeduplicationRetainedResponseSchema = PhysicalDeduplicationRetainedStateSchema.extend({
  ...mediaDetailResponse,
  ownerName: z.string().describe('Display name of the retained account'),
  canView: z.boolean().describe('Whether the requesting administrator may view this asset and its thumbnail'),
  fileAvailable: z
    .boolean()
    .describe('Whether the retained original file is on disk now, checked on every read (FL-71 UT-24)'),
  hiddenCopies: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Copies this retained original would share that are Locked media of another account; counted, never named (FL-73)',
    ),
}).meta({ id: 'PhysicalDeduplicationRetainedDto' });

const PhysicalDeduplicationCopyResponseSchema = PhysicalDeduplicationCopyStateSchema.extend({
  ...mediaDetailResponse,
  ownerName: z.string().describe('Display name of the copy owner'),
  canView: z.boolean().describe('Whether the requesting administrator may view this asset and its thumbnail'),
}).meta({ id: 'PhysicalDeduplicationCopyDto' });

const PhysicalDeduplicationPlanResponseSchema = z
  .object({
    mode: PhysicalDeduplicationPlanModeSchema,
    ranAt: z.iso.datetime().describe('When the plan was produced'),
    masterUserId: z.string().describe('Account whose originals are retained by this plan'),
    masterUserName: z.string().describe('Display name of the retained account'),
    scopeUserId: z
      .string()
      .nullable()
      .describe('When set, only copies owned by this account were reviewed; null means every account'),
    scopeUserName: z.string().nullable(),
    eligibleAssets: z.number().int().nonnegative(),
    linkedAssets: z.number().int().nonnegative(),
    skippedExternal: z.number().int().nonnegative(),
    skippedMissingMaster: z.number().int().nonnegative(),
    reclaimableBytes: z
      .number()
      .int()
      .nonnegative()
      .describe('Estimate: bytes of the copies to share, with their generated files, that applying would free'),
    deletedBytes: z
      .number()
      .int()
      .nonnegative()
      .describe('Measured: bytes actually removed from disk by applying this plan so far'),
    logicalBytes: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Logical asset bytes (FL-73): the sizes of every asset that references a shared original once this plan is applied, counted once per asset',
      ),
    sharedOriginalBytes: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Physical shared-original bytes (FL-73): the retained originals those assets share, counted once per file',
      ),
    retained: z.array(PhysicalDeduplicationRetainedResponseSchema),
    copies: z.array(PhysicalDeduplicationCopyResponseSchema),
    copiesTruncated: z
      .boolean()
      .describe('True when more copies were reviewed than the stored preview keeps; totals still cover all of them'),
    planId: z.string().describe('Short name of this plan, typed to confirm applying it (FL-73)'),
    fingerprint: z.string().describe('Digest over the plan evidence; changes with every preview (FL-73)'),
    applicableCopies: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Copies listed with a share decision: the most this plan can apply. Copies past the list limit wait for a later plan',
      ),
    hiddenCopies: z
      .number()
      .int()
      .nonnegative()
      .describe('Copies left out of the rows because they are Locked media of another account; counted, never named'),
  })
  .meta({ id: 'PhysicalDeduplicationPlanDto' });

/**
 * One applied plan (FL-73): the durable job's progress and outcome, for every administrator. Counts
 * and names only; the copies it covers are never listed here.
 */
const PhysicalDeduplicationApplySchema = z
  .object({
    operationId: z.string().describe('The media operation applying the plan'),
    planId: z.string(),
    fingerprint: z.string(),
    status: MediaOperationStatusSchema,
    requestedById: z.string().describe('Administrator who applied the plan; the job is theirs to pause or cancel'),
    requestedByName: z.string(),
    mine: z.boolean().describe('Whether the requesting administrator applied it'),
    retrying: z.boolean().describe('Waiting for its one automatic retry'),
    pauseRequested: z.boolean(),
    total: z.number().int().nonnegative().describe('Copies in the reviewed plan'),
    processed: z.number().int().nonnegative(),
    progress: z.number().meta({ format: 'double' }),
    applied: z.number().int().nonnegative(),
    alreadyApplied: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative().describe('Copies left alone because their evidence changed'),
    failed: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative(),
    reclaimedBytes: z.number().int().nonnegative().describe('Bytes actually removed from disk so far'),
    error: z.string().nullable(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PhysicalDeduplicationApplyDto' });

const PhysicalDeduplicationPreviewResponseSchema = z
  .object({
    plan: PhysicalDeduplicationPlanResponseSchema.nullable().describe('The latest plan, or null when none has run'),
    savedMasterUserId: z.string().nullable().describe('The saved `physicalDeduplication.masterUserId`'),
    enabled: z.boolean().describe('The saved `physicalDeduplication.enabled`'),
    running: z.boolean().describe('Whether a deduplication preview is queued or active'),
    applying: z.boolean().describe('Whether a reviewed plan is being applied (FL-73)'),
    applies: z.array(PhysicalDeduplicationApplySchema).describe('Recently applied plans, newest first (FL-73)'),
  })
  .meta({ id: 'PhysicalDeduplicationPreviewResponseDto' });

const PhysicalDeduplicationPreviewRequestSchema = z
  .object({
    masterUserId: z
      .uuidv4()
      .optional()
      .describe('Account to retain originals in for this preview; defaults to the saved master account'),
    scopeUserId: z.uuidv4().optional().describe('Limit the review to copies owned by this account'),
  })
  .meta({ id: 'PhysicalDeduplicationPreviewRequestDto' });

const fingerprint = z
  .string()
  .regex(/^[\da-f]{64}$/)
  .describe('The fingerprint of the plan on screen, from the preview');
const excludedRetainedAssetIds = z
  .array(z.uuidv4())
  .max(PHYSICAL_DEDUPLICATION_PREVIEW_LIMIT)
  .optional()
  .describe('Retained originals whose group the administrator decided to leave as they are');

const PhysicalDeduplicationReviewRequestSchema = z
  .object({ fingerprint, excludedRetainedAssetIds })
  .meta({ id: 'PhysicalDeduplicationReviewRequestDto' });

const PhysicalDeduplicationReviewResponseSchema = z
  .object({
    planId: z.string(),
    fingerprint: z.string(),
    reviewToken: z.string().describe('Binds the plan to these per-group decisions; applying must present it'),
    confirmation: z.string().describe('The phrase to type to apply this plan'),
    excludedRetainedAssetIds: z.array(z.string()),
    copies: z.number().int().nonnegative().describe('Copies the reviewed plan will share'),
    retainedOriginals: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative(),
    hiddenCopies: z
      .number()
      .int()
      .nonnegative()
      .describe('Copies in the reviewed plan that are Locked media of another account; counted, never named'),
    reviewedAt: z.iso.datetime(),
  })
  .meta({ id: 'PhysicalDeduplicationReviewResponseDto' });

const PhysicalDeduplicationApplyRequestSchema = z
  .object({
    fingerprint,
    excludedRetainedAssetIds,
    reviewToken: z
      .string()
      .regex(/^[\da-f]{64}$/)
      .describe('From the review of this plan'),
    confirmation: z.string().max(90).describe('`APPLY <planId>`, typed by the administrator'),
  })
  .meta({ id: 'PhysicalDeduplicationApplyRequestDto' });

/** How a retained original read on disk when an applied plan was verified (FL-73). */
const PhysicalDeduplicationRetainedFileSchema = z
  .enum(['intact', 'missing', 'changed'])
  .describe('The retained original on disk: still the reviewed bytes, gone, or different bytes')
  .meta({ id: 'PhysicalDeduplicationRetainedFile' });

/** What is at a copy's own former path when an applied plan was verified (FL-73). */
const PhysicalDeduplicationCopyFileSchema = z
  .enum(['removed', 'present', 'changed'])
  .describe("The copy's own former file: removed from disk, still the reviewed bytes, or different bytes now")
  .meta({ id: 'PhysicalDeduplicationCopyFile' });

const PhysicalDeduplicationVerificationItemSchema = z
  .object({
    assetId: z.string(),
    ownerName: z.string(),
    originalFileName: z.string(),
    type: AssetTypeSchema,
    canView: z.boolean().describe('Whether the requesting administrator may view this asset and its thumbnail'),
    retainedFile: PhysicalDeduplicationRetainedFileSchema,
    linked: z.boolean().describe('Whether the asset still resolves to the retained original'),
    copyFile: PhysicalDeduplicationCopyFileSchema,
    restored: z.boolean().describe('Whether the asset is back on its own former file'),
    restorable: z
      .boolean()
      .describe(
        'Whether the asset can go back to its own file: it is linked and that file still holds the reviewed bytes',
      ),
  })
  .meta({ id: 'PhysicalDeduplicationVerificationItemDto' });

/**
 * A post-apply verification (FL-73): every retained original hashed again, and every copy the plan
 * applied checked to still resolve to it. Copies of another account's Locked media are counted in
 * the totals and `hiddenCopies`, never listed.
 */
const PhysicalDeduplicationVerificationSchema = z
  .object({
    operationId: z.string(),
    planId: z.string(),
    verifiedAt: z.iso.datetime(),
    copies: z.number().int().nonnegative().describe('Copies the plan applied, listed or not'),
    verified: z
      .number()
      .int()
      .nonnegative()
      .describe('Copies that resolve to a retained original still holding the reviewed bytes'),
    retainedOriginals: z.number().int().nonnegative(),
    retainedIntact: z.number().int().nonnegative(),
    retainedMissing: z.number().int().nonnegative(),
    retainedChanged: z.number().int().nonnegative(),
    notLinked: z.number().int().nonnegative().describe('Copies that no longer resolve to the retained original'),
    restored: z.number().int().nonnegative(),
    restorable: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative().describe('Copies whose own file is gone: that cannot be undone'),
    hiddenCopies: z
      .number()
      .int()
      .nonnegative()
      .describe('Copies that are Locked media of another account; counted, never named'),
    items: z.array(PhysicalDeduplicationVerificationItemSchema),
  })
  .meta({ id: 'PhysicalDeduplicationVerificationDto' });

const PhysicalDeduplicationRestoreRequestSchema = z
  .object({ assetId: z.uuidv4().describe('A copy of the applied plan whose own file is still on disk') })
  .meta({ id: 'PhysicalDeduplicationRestoreRequestDto' });

export type PhysicalDeduplicationVerificationItem = z.infer<typeof PhysicalDeduplicationVerificationItemSchema>;

export class PhysicalDeduplicationVerificationDto extends createZodDto(PhysicalDeduplicationVerificationSchema) {}
export class PhysicalDeduplicationRestoreRequestDto extends createZodDto(PhysicalDeduplicationRestoreRequestSchema) {}
export class PhysicalDeduplicationPlanDto extends createZodDto(PhysicalDeduplicationPlanResponseSchema) {}
export class PhysicalDeduplicationApplyDto extends createZodDto(PhysicalDeduplicationApplySchema) {}
export class PhysicalDeduplicationReviewRequestDto extends createZodDto(PhysicalDeduplicationReviewRequestSchema) {}
export class PhysicalDeduplicationReviewResponseDto extends createZodDto(PhysicalDeduplicationReviewResponseSchema) {}
export class PhysicalDeduplicationApplyRequestDto extends createZodDto(PhysicalDeduplicationApplyRequestSchema) {}
export class PhysicalDeduplicationPreviewResponseDto extends createZodDto(PhysicalDeduplicationPreviewResponseSchema) {}
export class PhysicalDeduplicationPreviewRequestDto extends createZodDto(PhysicalDeduplicationPreviewRequestSchema) {}
