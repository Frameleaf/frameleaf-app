import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { HistoryBuilder } from 'src/decorators.js';
import {
  JobNameSchema,
  QueueCommandSchema,
  QueueJobStatusSchema,
  QueueJobWorkerKindSchema,
  QueueNameSchema,
} from 'src/enum.js';

const QueueNameParamSchema = z
  .object({
    name: QueueNameSchema,
  })
  .meta({ id: 'QueueNameParamDto' });

const QueueCommandSchemaDto = z
  .object({
    command: QueueCommandSchema,
    force: z.boolean().optional().describe('Force the command execution (if applicable)'),
  })
  .meta({ id: 'QueueCommandDto' });

const QueueUpdateSchema = z
  .object({
    isPaused: z.boolean().optional().describe('Whether to pause the queue'),
  })
  .meta({ id: 'QueueUpdateDto' });

const QueueDeleteSchema = z
  .object({
    failed: z
      .boolean()
      .optional()
      .describe('If true, will also remove failed jobs from the queue.')
      .meta(new HistoryBuilder().added('v2.4.0').alpha('v2.4.0').getExtensions()),
  })
  .meta({ id: 'QueueDeleteDto' });

const QueueJobSearchSchema = z
  .object({
    // A single ?status=failed arrives as a string (the SDK explodes one-element arrays), so wrap it.
    status: z
      .preprocess((val) => (typeof val === 'string' ? [val] : val), z.array(QueueJobStatusSchema))
      .optional()
      .describe('Filter jobs by status'),
    ownerId: z.uuidv4().optional().describe('Only jobs whose item belongs to this account (FL-71 account filter)'),
  })
  .meta({ id: 'QueueJobSearchDto' });

const QueueOwnerStatisticsSearchSchema = z
  .object({
    ownerId: z.uuidv4().describe('The account whose jobs are counted'),
  })
  .meta({ id: 'QueueOwnerStatisticsSearchDto' });

/** FL-71: the Job manager's Account column (`JobsManager.jsx` 760, 784). Administrators only. */
const QueueJobAccountSchema = z
  .object({
    id: z.uuidv4().describe('Account ID'),
    name: z.string().describe('Account name'),
  })
  .meta({ id: 'QueueJobAccountDto' });

/** FL-71: the Job manager's Worker column (`JobsManager.jsx` 761, 786-795). */
const QueueJobWorkerSchema = z
  .object({
    kind: QueueJobWorkerKindSchema,
    name: z.string().nullable().describe('The processing destination name, for a machine-learning worker'),
  })
  .meta({ id: 'QueueJobWorkerDto' });

const QueueJobResponseSchema = z
  .object({
    id: z.string().optional().describe('Job ID'),
    name: JobNameSchema,
    data: z.record(z.string(), z.unknown()).describe('Job data payload'),
    timestamp: z.int().describe('Job creation timestamp'),
    attemptsMade: z.int().optional().describe('How many times the job has been attempted'),
    failedReason: z.string().optional().describe('Why the last attempt failed, for a failed job'),
    account: QueueJobAccountSchema.optional().describe(
      'The account whose item the job works on, when the job names an asset, person, library or account',
    ),
    worker: QueueJobWorkerSchema.describe('Where the job runs or ran'),
  })
  .meta({ id: 'QueueJobResponseDto' });

const QueueRetryFailedResponseSchema = z
  .object({
    count: z.int().nonnegative().describe('How many failed jobs were put back in the queue'),
  })
  .meta({ id: 'QueueRetryFailedResponseDto' });

export const QueueStatisticsSchema = z
  .object({
    active: z.int().describe('Number of active jobs'),
    completed: z.int().describe('Number of completed jobs'),
    failed: z.int().describe('Number of failed jobs'),
    delayed: z.int().describe('Number of delayed jobs'),
    waiting: z.int().describe('Number of waiting jobs'),
    paused: z.int().describe('Number of paused jobs'),
  })
  .meta({ id: 'QueueStatisticsDto' });

/**
 * FL-71 (J-1): one account's jobs in a queue, for the Job manager's account filter. Jobs are
 * attributed through the item they name; at most QUEUE_OWNER_SCAN_LIMIT jobs of each state are
 * read, and `truncated` says a state had more than that, so its count is a lower bound.
 */
const QueueOwnerStatisticsResponseSchema = QueueStatisticsSchema.extend({
  truncated: z.boolean().describe('Whether a state had more jobs than were scanned, so its count is a lower bound'),
}).meta({ id: 'QueueOwnerStatisticsResponseDto' });

const QueueResponseSchema = z
  .object({
    name: QueueNameSchema,
    isPaused: z.boolean().describe('Whether the queue is paused'),
    statistics: QueueStatisticsSchema,
  })
  .meta({ id: 'QueueResponseDto' });

export class QueueNameParamDto extends createZodDto(QueueNameParamSchema) {}
export class QueueCommandDto extends createZodDto(QueueCommandSchemaDto) {}
export class QueueUpdateDto extends createZodDto(QueueUpdateSchema) {}
export class QueueDeleteDto extends createZodDto(QueueDeleteSchema) {}
export class QueueJobSearchDto extends createZodDto(QueueJobSearchSchema) {}
export class QueueJobResponseDto extends createZodDto(QueueJobResponseSchema) {}
export class QueueRetryFailedResponseDto extends createZodDto(QueueRetryFailedResponseSchema) {}
export class QueueOwnerStatisticsSearchDto extends createZodDto(QueueOwnerStatisticsSearchSchema) {}
export class QueueOwnerStatisticsResponseDto extends createZodDto(QueueOwnerStatisticsResponseSchema) {}
export class QueueStatisticsDto extends createZodDto(QueueStatisticsSchema) {}
export class QueueResponseDto extends createZodDto(QueueResponseSchema) {}
