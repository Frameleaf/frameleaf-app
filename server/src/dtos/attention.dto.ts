import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QueueNameSchema } from 'src/enum.js';

/**
 * FL-421: what needs an administrator on this server, worked out from the server's own records each
 * time it is asked. Facts only: a client words each item in its own language and links it to the
 * page that puts it right.
 */
export const ATTENTION_KINDS = ['backup', 'storage', 'work', 'version'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** `now` needs the person today; `soon` can wait until they have a moment. */
export const ATTENTION_LEVELS = ['now', 'soon'] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

export const ATTENTION_REASONS = [
  // backup
  'not-backed-up',
  'backup-failed',
  'backup-behind',
  // storage
  'nearly-full',
  'out-of-space',
  // work
  'work-failed',
  'work-paused',
  // version
  'new-version',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** How one kind of check came out: `off` when it is switched off, `unknown` when it could not be read. */
export const ATTENTION_CHECK_STATES = ['ok', 'attention', 'off', 'unknown'] as const;
export type AttentionCheckState = (typeof ATTENTION_CHECK_STATES)[number];

export const ATTENTION_BACKUP_PLACES = ['cloud', 'buddy', 'local'] as const;
export type AttentionBackupPlace = (typeof ATTENTION_BACKUP_PLACES)[number];

const AttentionKindSchema = z
  .enum(ATTENTION_KINDS)
  .describe('What an attention item is about')
  .meta({ id: 'AttentionKind' });
const AttentionLevelSchema = z
  .enum(ATTENTION_LEVELS)
  .describe('How soon it needs the administrator: now, or when they can')
  .meta({ id: 'AttentionLevel' });
const AttentionReasonSchema = z
  .enum(ATTENTION_REASONS)
  .describe('What was found, one value per kind of finding')
  .meta({ id: 'AttentionReason' });
const AttentionCheckStateSchema = z
  .enum(ATTENTION_CHECK_STATES)
  .describe('How a check came out')
  .meta({ id: 'AttentionCheckState' });
const AttentionBackupPlaceSchema = z
  .enum(ATTENTION_BACKUP_PLACES)
  .describe('Where a backup is kept; local is the copy of the library data on this server')
  .meta({ id: 'AttentionBackupPlace' });

const AttentionStorageSchema = z
  .object({
    availableBytes: z.int().min(0).describe('Space left on the drive the library is on'),
    totalBytes: z.int().min(0).describe('Size of that drive'),
    usedPercent: z.number().min(0).max(100).meta({ format: 'double' }).describe('How full the drive is'),
  })
  .meta({ id: 'AttentionStorageDto' });

const AttentionBackupSchema = z
  .object({
    place: AttentionBackupPlaceSchema.nullable().describe('The place the finding is about; null when there is none'),
    lastSuccessAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When this place last finished a backup'),
    days: z.int().min(0).nullable().describe('Whole days since it last finished, when it is behind'),
  })
  .meta({ id: 'AttentionBackupDto' });

const AttentionWorkSchema = z
  .object({
    count: z.int().min(0).describe('Items that failed, or that wait behind a pause, across these kinds of work'),
    queues: z
      .array(z.object({ name: QueueNameSchema, count: z.int().min(0) }).meta({ id: 'AttentionWorkQueueDto' }))
      .describe('Each kind of work involved, most items first'),
  })
  .meta({ id: 'AttentionWorkDto' });

const AttentionVersionSchema = z
  .object({
    current: z.string().describe('The version this server runs'),
    available: z.string().describe('The newest version offered'),
  })
  .meta({ id: 'AttentionVersionDto' });

const AttentionItemSchema = z
  .object({
    id: z.string().describe('Stable for the same finding across reads, for example backup:cloud'),
    kind: AttentionKindSchema,
    reason: AttentionReasonSchema,
    level: AttentionLevelSchema,
    since: z.string().meta({ format: 'date-time' }).nullable().describe('When it started, when the server knows'),
    storage: AttentionStorageSchema.nullable().describe('The drive, for a storage item'),
    backup: AttentionBackupSchema.nullable().describe('The place, for a backup item'),
    work: AttentionWorkSchema.nullable().describe('The kinds of work, for a work item'),
    version: AttentionVersionSchema.nullable().describe('The versions, for a version item'),
  })
  .meta({ id: 'AttentionItemDto' });

const AttentionCheckSchema = z
  .object({ kind: AttentionKindSchema, state: AttentionCheckStateSchema })
  .meta({ id: 'AttentionCheckDto' });

const AttentionResponseSchema = z
  .object({
    checkedAt: z.string().meta({ format: 'date-time' }).describe('When the checks were made'),
    items: z.array(AttentionItemSchema).describe('What needs attention, the most urgent first'),
    checks: z.array(AttentionCheckSchema).describe('How each kind of check came out, in a fixed order'),
    dismissed: z
      .array(z.string())
      .describe('Overview items an administrator dismissed (FL-363); they stop counting as needing attention'),
  })
  .meta({ id: 'AttentionResponseDto' });

/** FL-363: dismiss an Overview item, or bring it back. Ids are the client's, for example "studio". */
const AttentionDismissSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9:-]+$/)
      .describe('The item to dismiss or bring back'),
    dismissed: z.boolean().describe('True dismisses it; false brings it back'),
  })
  .meta({ id: 'AttentionDismissDto' });

export type AttentionItem = z.infer<typeof AttentionItemSchema>;
export type AttentionCheck = z.infer<typeof AttentionCheckSchema>;

export class AttentionResponseDto extends createZodDto(AttentionResponseSchema) {}
export class AttentionDismissDto extends createZodDto(AttentionDismissSchema) {}
