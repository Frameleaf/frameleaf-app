import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AlbumIconSchema } from 'src/dtos/album.dto.js';
import {
  ClassificationMatchDecision,
  ClassificationMatchDecisionSchema,
  ClassificationMediaType,
  ClassificationMediaTypeSchema,
  ClassificationRuleActionSchema,
} from 'src/enum.js';

/**
 * Classification rules (FL-60): the rules behind a person's own smart albums.
 *
 * A rule reads only its owner's media and writes only to its owner's own album, tags and archive
 * state. It never grants anybody access. Archiving is never implied: it has to be asked for with
 * `archive` and consented to with `archiveConsent` in the same request.
 */

/** Largest set a rule is applied to inline; anything bigger runs as a durable bulk job. */
export const CLASSIFICATION_INLINE_LIMIT = 500;

/** Largest sample a preview reads. */
export const CLASSIFICATION_PREVIEW_MAX_SAMPLE = 2000;

/** Items a preview or a plan shows as thumbnails. */
export const CLASSIFICATION_PREVIEW_ITEMS = 24;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u{0000}-\u{001F}\u{007F}]/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const phrase = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !CONTROL_CHARACTERS.test(value), { error: 'A phrase cannot contain control characters' });

const day = z
  .string()
  .regex(DAY, { error: 'Expected a date as YYYY-MM-DD' })
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { error: 'Not a valid date' });

const criteriaShape = {
  personIds: z.array(z.uuidv4()).max(50).describe('Match any of these people'),
  tagIds: z.array(z.uuidv4()).max(50).describe('Match any of these tags, or a tag beneath one of them'),
  takenAfter: day.nullable().describe('Taken on or after this day (YYYY-MM-DD)'),
  takenBefore: day.nullable().describe('Taken on or before this day (YYYY-MM-DD)'),
  mediaType: ClassificationMediaTypeSchema,
  visualQueries: z.array(phrase).max(10).describe('Visual category phrases compared with each item'),
  threshold: z
    .number()
    .meta({ format: 'double' })
    .min(0)
    .max(1)
    .describe('The confidence a visual phrase has to reach'),
};

const withCriteriaDefaults = {
  personIds: criteriaShape.personIds.default([]),
  tagIds: criteriaShape.tagIds.default([]),
  takenAfter: criteriaShape.takenAfter.default(null),
  takenBefore: criteriaShape.takenBefore.default(null),
  mediaType: criteriaShape.mediaType.default(ClassificationMediaType.Any),
  visualQueries: criteriaShape.visualQueries.default([]),
  threshold: criteriaShape.threshold.default(0.25),
};

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !CONTROL_CHARACTERS.test(value), { error: 'A tag cannot contain control characters' });

const dateOrder = (value: { takenAfter?: string | null; takenBefore?: string | null }) =>
  !value.takenAfter || !value.takenBefore || value.takenAfter <= value.takenBefore;
const dateOrderError = { error: 'The start date must be on or before the end date', path: ['takenBefore'] };

const ClassificationRuleCriteriaSchema = z
  .object(withCriteriaDefaults)
  .refine(dateOrder, dateOrderError)
  .meta({ id: 'ClassificationRuleCriteriaDto' });

const ClassificationRuleCreateSchema = z
  .object({
    ...withCriteriaDefaults,
    albumName: z.string().trim().min(1).max(120).describe('Name of the smart album'),
    description: z.string().max(2000).nullable().optional().describe('Description of the smart album'),
    icon: AlbumIconSchema.optional().describe('Icon of the smart album'),
    parentId: z.uuidv4().optional().describe('Collection to create the smart album inside'),
    action: ClassificationRuleActionSchema.optional().describe('Defaults to the server default rule action'),
    tagName: tagName.nullable().optional().describe('The rule-owned tag a match receives; null tags nothing'),
    archive: z.boolean().default(false).describe('Archive matches; requires archiveConsent'),
    archiveConsent: z.boolean().optional().describe('The owner explicitly agrees that matches are archived'),
    enabled: z.boolean().default(true),
  })
  .refine(dateOrder, dateOrderError)
  .meta({ id: 'ClassificationRuleCreateDto' });

const ClassificationRuleUpdateSchema = z
  .object({
    personIds: criteriaShape.personIds.optional(),
    tagIds: criteriaShape.tagIds.optional(),
    takenAfter: criteriaShape.takenAfter.optional(),
    takenBefore: criteriaShape.takenBefore.optional(),
    mediaType: criteriaShape.mediaType.optional(),
    visualQueries: criteriaShape.visualQueries.optional(),
    threshold: criteriaShape.threshold.optional(),
    action: ClassificationRuleActionSchema.optional(),
    tagName: tagName.nullable().optional().describe('The rule-owned tag a match receives; null tags nothing'),
    archive: z.boolean().optional().describe('Archive matches; turning it on requires archiveConsent'),
    archiveConsent: z.boolean().optional().describe('The owner explicitly agrees that matches are archived'),
    enabled: z.boolean().optional().describe('A disabled rule keeps what it applied and stops changing anything'),
  })
  .refine(dateOrder, dateOrderError)
  .meta({ id: 'ClassificationRuleUpdateDto' });

const ClassificationTagSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'ClassificationTagDto' });

const ClassificationRuleCountsSchema = z
  .object({
    matched: z.int().min(0),
    suggested: z.int().min(0),
    accepted: z.int().min(0),
    rejected: z.int().min(0),
  })
  .meta({ id: 'ClassificationRuleCountsDto' });

const ClassificationRuleResponseSchema = z
  .object({
    id: z.string(),
    albumId: z.string(),
    albumName: z.string(),
    enabled: z.boolean(),
    ...criteriaShape,
    action: ClassificationRuleActionSchema,
    tag: ClassificationTagSchema.nullable(),
    archive: z.boolean(),
    archiveConsentAt: z.string().meta({ format: 'date-time' }).nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    lastAppliedAt: z.string().meta({ format: 'date-time' }).nullable(),
    counts: ClassificationRuleCountsSchema,
  })
  .meta({ id: 'ClassificationRuleResponseDto' });

const ClassificationRuleQuerySchema = z
  .object({ albumId: z.uuidv4().optional().describe('Only the rule behind this album') })
  .meta({ id: 'ClassificationRuleQueryDto' });

const ClassificationPreviewSchema = z
  .object({
    ...withCriteriaDefaults,
    sampleSize: z
      .int()
      .min(1)
      .max(CLASSIFICATION_PREVIEW_MAX_SAMPLE)
      .default(500)
      .describe('How many of the newest items a visual preview reads'),
  })
  .refine(dateOrder, dateOrderError)
  .meta({ id: 'ClassificationPreviewDto' });

const ClassificationScoredAssetSchema = z
  .object({
    assetId: z.string(),
    score: z.number().meta({ format: 'double' }).nullable(),
  })
  .meta({ id: 'ClassificationScoredAssetDto' });

const ClassificationPreviewResponseSchema = z
  .object({
    exact: z.boolean().describe('True when `matched` counts the whole library, false for a bounded sample'),
    sampled: z.int().min(0).describe('Items read: the whole library when exact, otherwise the newest items'),
    matched: z.int().min(0).describe('Items that match among those read'),
    items: z.array(ClassificationScoredAssetSchema).describe('The first matches, best first'),
    visualSearchAvailable: z.boolean().describe('False when visual phrases cannot be compared right now'),
  })
  .meta({ id: 'ClassificationPreviewResponseDto' });

const ClassificationPlanResponseSchema = z
  .object({
    matched: z.int().min(0).describe('Items the rule matches now'),
    added: z.int().min(0).describe('Items that would be added or suggested'),
    removed: z.int().min(0).describe('Items the rule applied that no longer match'),
    items: z.array(ClassificationScoredAssetSchema).describe('The first items that would be added'),
    assetIds: z.array(z.string()).describe('Every item applying would change, for the apply call or a bulk job'),
    truncated: z.boolean().describe('True when there were more changes than one apply can carry'),
    durable: z.boolean().describe('True when applying must run as a durable bulk job'),
    visualSearchAvailable: z.boolean(),
  })
  .meta({ id: 'ClassificationPlanResponseDto' });

const ClassificationApplySchema = z
  .object({
    assetIds: z
      .array(z.uuidv4())
      .max(CLASSIFICATION_INLINE_LIMIT)
      .describe('Items from the plan; empty records the check when nothing changed'),
  })
  .meta({ id: 'ClassificationApplyDto' });

const ClassificationApplyResponseSchema = z
  .object({
    added: z.int().min(0),
    suggested: z.int().min(0),
    removed: z.int().min(0),
    unchanged: z.int().min(0),
    lastAppliedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'ClassificationApplyResponseDto' });

const ClassificationMatchQuerySchema = z
  .object({
    decision: ClassificationMatchDecisionSchema.default(ClassificationMatchDecision.Suggested),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(500).default(100),
  })
  .meta({ id: 'ClassificationMatchQueryDto' });

const ClassificationMatchSchema = z
  .object({
    assetId: z.string(),
    score: z.number().meta({ format: 'double' }).nullable(),
    decision: ClassificationMatchDecisionSchema,
    tagContributed: z.boolean(),
    archiveContributed: z.boolean(),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'ClassificationMatchDto' });

const ClassificationMatchPageSchema = z
  .object({
    total: z.int().min(0),
    items: z.array(ClassificationMatchSchema),
    nextPage: z.int().nullable(),
  })
  .meta({ id: 'ClassificationMatchPageDto' });

const ClassificationDecisionSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).max(CLASSIFICATION_INLINE_LIMIT),
    decision: z
      .enum([ClassificationMatchDecision.Accepted, ClassificationMatchDecision.Rejected])
      .describe('Keep the matches, or turn them down and undo what the rule applied')
      .meta({ id: 'ClassificationReviewDecision' }),
  })
  .meta({ id: 'ClassificationDecisionDto' });

const ClassificationDecisionResponseSchema = z
  .object({ updated: z.int().min(0), skipped: z.int().min(0) })
  .meta({ id: 'ClassificationDecisionResponseDto' });

const ClassificationContributionSchema = z
  .object({
    ruleId: z.string(),
    albumId: z.string(),
    albumName: z.string(),
    decision: ClassificationMatchDecisionSchema,
    score: z.number().meta({ format: 'double' }).nullable(),
    tag: ClassificationTagSchema.nullable().describe('The tag this rule added, when it added one'),
    archived: z.boolean().describe('True when this rule archived the item'),
  })
  .meta({ id: 'ClassificationContributionDto' });

const ClassificationSettingsSchema = z
  .object({
    visualCategories: z.boolean().describe('Whether rules may use visual category phrases'),
    visualSearchAvailable: z.boolean().describe('Whether visual phrases can be compared right now'),
    defaultAction: ClassificationRuleActionSchema,
    inlineLimit: z.int().describe('Changes above this many run as a durable bulk job'),
  })
  .meta({ id: 'ClassificationSettingsDto' });

export class ClassificationRuleCriteriaDto extends createZodDto(ClassificationRuleCriteriaSchema) {}
export class ClassificationRuleCreateDto extends createZodDto(ClassificationRuleCreateSchema) {}
export class ClassificationRuleUpdateDto extends createZodDto(ClassificationRuleUpdateSchema) {}
export class ClassificationRuleResponseDto extends createZodDto(ClassificationRuleResponseSchema) {}
export class ClassificationRuleQueryDto extends createZodDto(ClassificationRuleQuerySchema) {}
export class ClassificationPreviewDto extends createZodDto(ClassificationPreviewSchema) {}
export class ClassificationPreviewResponseDto extends createZodDto(ClassificationPreviewResponseSchema) {}
export class ClassificationPlanResponseDto extends createZodDto(ClassificationPlanResponseSchema) {}
export class ClassificationApplyDto extends createZodDto(ClassificationApplySchema) {}
export class ClassificationApplyResponseDto extends createZodDto(ClassificationApplyResponseSchema) {}
export class ClassificationMatchQueryDto extends createZodDto(ClassificationMatchQuerySchema) {}
export class ClassificationMatchPageDto extends createZodDto(ClassificationMatchPageSchema) {}
export class ClassificationDecisionDto extends createZodDto(ClassificationDecisionSchema) {}
export class ClassificationDecisionResponseDto extends createZodDto(ClassificationDecisionResponseSchema) {}
export class ClassificationContributionDto extends createZodDto(ClassificationContributionSchema) {}
export class ClassificationSettingsDto extends createZodDto(ClassificationSettingsSchema) {}

export type ClassificationCriteria = z.infer<typeof ClassificationRuleCriteriaSchema>;
