import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { CLASSIFICATION_INLINE_LIMIT } from 'src/dtos/classification.dto.js';

/**
 * Tidy up (FL-1469): clutter suggested for the Archive. Kinds and strictness are request enums only;
 * responses carry them as plain strings so a later kind never breaks a strict native decoder.
 */
export const TIDY_UP_KINDS = [
  'memes',
  'documents',
  'screenshots',
  'shop',
  'chat',
  'slides',
  'notes',
  'accidental',
] as const;
export type TidyUpKind = (typeof TIDY_UP_KINDS)[number];

export const TIDY_UP_STRICTNESS = ['surer', 'balanced', 'more'] as const;
export type TidyUpStrictness = (typeof TIDY_UP_STRICTNESS)[number];

const TidyUpKindSchema = z.enum(TIDY_UP_KINDS).meta({ id: 'TidyUpKind' });
const TidyUpStrictnessSchema = z.enum(TIDY_UP_STRICTNESS).meta({ id: 'TidyUpStrictness' });

const TidyUpKindParamSchema = z.object({ kind: TidyUpKindSchema }).meta({ id: 'TidyUpKindParamDto' });

const TidyUpKindUpdateSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe('Look for this kind. Turning it off never takes a photo out of the Archive'),
    strictness: TidyUpStrictnessSchema.optional().describe('How alike a photo must look; defaults to balanced'),
    automatic: z
      .boolean()
      .optional()
      .describe('Archive new photos of this kind without asking. Off unless the person turns it on'),
  })
  .meta({ id: 'TidyUpKindUpdateDto' });

const TidyUpKindStatusSchema = z
  .object({
    kind: z.string().describe('memes, documents, screenshots, shop, chat, slides, notes or accidental'),
    enabled: z.boolean(),
    strictness: z.string().describe('surer, balanced or more'),
    automatic: z.boolean().describe('New photos of this kind go straight to the Archive'),
    visual: z.boolean().describe('Needs Visual search to see what is in each photo'),
    available: z.boolean().describe('False when this kind needs Visual search and it is off'),
    waiting: z.int().min(0).describe('Photos on the timeline waiting for review'),
    albumId: z.string().nullable().describe('The album inside Tidied away that holds what this kind archived'),
  })
  .meta({ id: 'TidyUpKindStatusDto' });

const TidyUpStatusSchema = z
  .object({
    kinds: z.array(TidyUpKindStatusSchema),
    waiting: z.int().min(0).describe('Photos waiting for review across every kind, each counted once'),
    tidiedAway: z.int().min(0).describe('Photos Tidy up moved to the Archive and still there'),
    collectionId: z.string().nullable().describe('The Tidied away collection, once a kind has been turned on'),
  })
  .meta({ id: 'TidyUpStatusDto' });

const TidyUpPageQuerySchema = z
  .object({
    kind: TidyUpKindSchema.optional().describe('Only this kind'),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(500).default(100),
  })
  .meta({ id: 'TidyUpPageQueryDto' });

const TidyUpItemSchema = z
  .object({
    assetId: z.string(),
    kinds: z.array(z.string()).describe('Every kind this photo was found by'),
    automatic: z.boolean().describe('Archived without asking because Archive automatically was on'),
  })
  .meta({ id: 'TidyUpItemDto' });

const TidyUpPageSchema = z
  .object({
    total: z.int().min(0),
    items: z.array(TidyUpItemSchema),
    nextPage: z.int().nullable(),
  })
  .meta({ id: 'TidyUpPageDto' });

const TidyUpDecisionSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).max(CLASSIFICATION_INLINE_LIMIT),
    decision: z
      .enum(['archive', 'keep', 'undo'])
      .describe(
        'archive: move suggestions to the Archive. keep: leave them on the timeline (or put an archived one back) and never suggest them again. undo: take back an archive you just made; the photos wait for review again',
      )
      .meta({ id: 'TidyUpDecision' }),
  })
  .meta({ id: 'TidyUpDecisionDto' });

const TidyUpDecisionResponseSchema = z
  .object({ updated: z.int().min(0), skipped: z.int().min(0) })
  .meta({ id: 'TidyUpDecisionResponseDto' });

export class TidyUpKindParamDto extends createZodDto(TidyUpKindParamSchema) {}
export class TidyUpKindUpdateDto extends createZodDto(TidyUpKindUpdateSchema) {}
export class TidyUpKindStatusDto extends createZodDto(TidyUpKindStatusSchema) {}
export class TidyUpStatusDto extends createZodDto(TidyUpStatusSchema) {}
export class TidyUpPageQueryDto extends createZodDto(TidyUpPageQuerySchema) {}
export class TidyUpPageDto extends createZodDto(TidyUpPageSchema) {}
export class TidyUpDecisionDto extends createZodDto(TidyUpDecisionSchema) {}
export class TidyUpDecisionResponseDto extends createZodDto(TidyUpDecisionResponseSchema) {}
