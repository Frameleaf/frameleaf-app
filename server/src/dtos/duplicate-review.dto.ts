import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import {
  DuplicateDecisionKindSchema,
  DuplicateGroupBlockSchema,
  DuplicateGroupKindSchema,
  DuplicateQualityReasonSchema,
  MediaOperationBulkActionSchema,
} from 'src/enum.js';

/**
 * The fast duplicate review (FL-61).
 *
 * The review list is the owner's own duplicate groups, each read as a whole: a group the session
 * cannot see completely (photos suppressed while it is not unlocked) or that holds another account's
 * photo is listed but not decidable, so no decision is ever made on part of a group. Locked photos are
 * never part of a group here, as they are never part of duplicate review.
 */
const DuplicateReviewQualitySchema = z
  .object({
    assetId: z.uuidv4(),
    reasons: z.array(DuplicateQualityReasonSchema).describe('Evidence for or against keeping this copy'),
  })
  .meta({ id: 'DuplicateReviewQualityDto' });

const DuplicateReviewGroupSchema = z
  .object({
    duplicateId: z.uuidv4().describe('Duplicate group ID'),
    assets: z.array(AssetResponseSchema).describe('The photos of the group this session may see'),
    suggestedKeepAssetIds: z
      .array(z.uuidv4())
      .describe('The suggested keeper, from resolution, format and original provenance. Never set for a burst'),
    kind: DuplicateGroupKindSchema,
    editable: z.boolean().describe('Whether this session may decide the group'),
    blockedReason: DuplicateGroupBlockSchema.nullable(),
    hiddenMemberCount: z.int().min(0).describe('Photos of the group this session does not see'),
    totalBytes: z.int().min(0).describe('Size of the originals shown, in bytes'),
    qualities: z.array(DuplicateReviewQualitySchema),
  })
  .meta({ id: 'DuplicateReviewGroupDto' });

const DuplicateDecisionGroupSchema = z
  .object({
    decisionId: z.uuidv7(),
    duplicateId: z.uuidv4(),
    decision: DuplicateDecisionKindSchema,
    memberIds: z.array(z.uuidv4()),
    keepAssetIds: z.array(z.uuidv4()),
    trashAssetIds: z.array(z.uuidv4()),
    applied: z.boolean(),
    undone: z.boolean(),
    undoing: z.boolean().describe('An undo job has started on this decision'),
  })
  .meta({ id: 'DuplicateDecisionGroupDto' });

const DuplicateDecisionBatchSchema = z
  .object({
    operationId: z.uuidv7().describe('The durable job that applied these decisions'),
    createdAt: z.string().meta({ format: 'date-time' }),
    groups: z.array(DuplicateDecisionGroupSchema),
    undoable: z.boolean().describe('Every decision of the job is applied and none has been undone'),
  })
  .meta({ id: 'DuplicateDecisionBatchDto' });

const DuplicateActiveGroupSchema = z
  .object({
    duplicateId: z.uuidv4(),
    memberIds: z.array(z.uuidv4()),
  })
  .meta({ id: 'DuplicateActiveGroupDto' });

const DuplicateActiveOperationSchema = z
  .object({
    operationId: z.uuidv7(),
    action: MediaOperationBulkActionSchema,
    groups: z.array(DuplicateActiveGroupSchema),
  })
  .meta({ id: 'DuplicateActiveOperationDto' });

const DuplicateDecisionHistorySchema = z
  .object({
    recent: z.array(DuplicateDecisionBatchSchema).describe('The most recent decision jobs, newest first'),
    active: z.array(DuplicateActiveOperationSchema).describe('Decision and undo jobs still running'),
  })
  .meta({ id: 'DuplicateDecisionHistoryDto' });

export class DuplicateReviewGroupDto extends createZodDto(DuplicateReviewGroupSchema) {}
export class DuplicateReviewQualityDto extends createZodDto(DuplicateReviewQualitySchema) {}
export class DuplicateDecisionGroupDto extends createZodDto(DuplicateDecisionGroupSchema) {}
export class DuplicateDecisionBatchDto extends createZodDto(DuplicateDecisionBatchSchema) {}
export class DuplicateActiveGroupDto extends createZodDto(DuplicateActiveGroupSchema) {}
export class DuplicateActiveOperationDto extends createZodDto(DuplicateActiveOperationSchema) {}
export class DuplicateDecisionHistoryDto extends createZodDto(DuplicateDecisionHistorySchema) {}
