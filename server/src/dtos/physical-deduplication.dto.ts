import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  AssetTypeSchema,
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
});

export type PhysicalDeduplicationRetainedState = z.infer<typeof PhysicalDeduplicationRetainedStateSchema>;
export type PhysicalDeduplicationCopyState = z.infer<typeof PhysicalDeduplicationCopyStateSchema>;

const PhysicalDeduplicationRetainedResponseSchema = PhysicalDeduplicationRetainedStateSchema.extend({
  ownerName: z.string().describe('Display name of the retained account'),
  canView: z.boolean().describe('Whether the requesting administrator may view this asset and its thumbnail'),
}).meta({ id: 'PhysicalDeduplicationRetainedDto' });

const PhysicalDeduplicationCopyResponseSchema = PhysicalDeduplicationCopyStateSchema.extend({
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
    reclaimableBytes: z.number().int().nonnegative(),
    deletedBytes: z.number().int().nonnegative(),
    retained: z.array(PhysicalDeduplicationRetainedResponseSchema),
    copies: z.array(PhysicalDeduplicationCopyResponseSchema),
    copiesTruncated: z
      .boolean()
      .describe('True when more copies were reviewed than the stored preview keeps; totals still cover all of them'),
  })
  .meta({ id: 'PhysicalDeduplicationPlanDto' });

const PhysicalDeduplicationPreviewResponseSchema = z
  .object({
    plan: PhysicalDeduplicationPlanResponseSchema.nullable().describe('The latest plan, or null when none has run'),
    savedMasterUserId: z.string().nullable().describe('The saved `physicalDeduplication.masterUserId`'),
    enabled: z.boolean().describe('The saved `physicalDeduplication.enabled`'),
    running: z.boolean().describe('Whether a deduplication preview or apply job is queued or active'),
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

export class PhysicalDeduplicationPlanDto extends createZodDto(PhysicalDeduplicationPlanResponseSchema) {}
export class PhysicalDeduplicationPreviewResponseDto extends createZodDto(
  PhysicalDeduplicationPreviewResponseSchema,
) {}
export class PhysicalDeduplicationPreviewRequestDto extends createZodDto(PhysicalDeduplicationPreviewRequestSchema) {}
