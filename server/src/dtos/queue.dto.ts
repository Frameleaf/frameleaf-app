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
import { QUEUE_PROBLEM_CAUSES } from 'src/queue/run-failure-cause.js';

const QueueNameParamSchema = z
  .object({
    name: QueueNameSchema,
  })
  .meta({ id: 'QueueNameParamDto' });

const QueueCommandSchemaDto = z
  .object({
    command: QueueCommandSchema,
    force: z.boolean().optional().describe('Force the command execution (if applicable)'),
    includeSetAside: z.boolean().optional().describe('Include quarantined assets in a forced processing run'),
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

// Approved design (2026-11-04): one job at a time, from the jobs manager's rows and details.
const QueueJobParamSchema = z
  .object({
    name: QueueNameSchema,
    id: z.uuidv4().describe('Job ID'),
  })
  .meta({ id: 'QueueJobParamDto' });

const QueueRunOneSchema = z
  .object({
    assetId: z.uuidv4().describe('The photo or video to run this task on'),
  })
  .meta({ id: 'QueueRunOneDto' });

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
    followUp: z
      .int()
      .optional()
      .describe(
        'Of the waiting, delayed and paused jobs, how many are later steps of items the queue already started. Only for queues with such steps',
      ),
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
    hasUnfinishedWork: z
      .boolean()
      .describe('Whether durable work remains, including delayed, paused and unadmitted work'),
    statistics: QueueStatisticsSchema,
  })
  .meta({ id: 'QueueResponseDto' });

/**
 * FL-1486: Background work › Advanced. Its own enums: `JobRunFailureCause` and the queue fields above are decoded
 * strictly by the native apps, so richer values are only ever sent here.
 */
export const QueueProblemCauseSchema = z
  .enum(QUEUE_PROBLEM_CAUSES)
  .describe(
    "What went wrong: drive (an external library can't be reached), missing (the file is gone), damaged, unsupported (a format that can't be read), writeDenied (a folder could not be written to), mlUnavailable (the machine-learning helper did not answer), tooLong (the job ran past its deadline), or other",
  )
  .meta({ id: 'QueueProblemCause' });
const QueueProblemSchema = z
  .object({
    cause: QueueProblemCauseSchema,
    count: z.int().min(1).describe('Photos, videos or jobs with this problem that still need a look'),
    unit: z
      .enum(['photos', 'videos', 'jobs'])
      .describe('What count counts: jobs for work that is no photo’s')
      .meta({ id: 'QueueProblemUnit' }),
    queues: z.array(QueueNameSchema).describe('The queues whose failed jobs have this problem'),
    message: z
      .string()
      .nullable()
      .describe('One raw error message, from a job that may show it on a photo the caller may see; null when none may'),
  })
  .meta({ id: 'QueueProblemDto' });
export const QueueIdleReasonSchema = z
  .enum(['paused', 'quietHours', 'waitingFor', 'featureOff'])
  .describe(
    'Why a queue is not running: paused (by a person, or by the server while it moves the library), quietHours (closed until closedUntil), waitingFor (its jobs wait for the waitingFor queue), featureOff',
  )
  .meta({ id: 'QueueIdleReason' });
const QueueTaskSchema = z
  .object({
    name: QueueNameSchema,
    reason: QueueIdleReasonSchema.nullable().describe('Why it is not running; null when nothing holds it'),
    pausedAt: z.iso.datetime().optional().describe('For paused: when a person paused it; absent when the server did'),
    closedUntil: z.iso.datetime().optional().describe('For quietHours: when it opens again'),
    waitingFor: QueueNameSchema.optional().describe('For waitingFor: the queue it waits for'),
  })
  .meta({ id: 'QueueTaskDto' });
const QueueOverviewResponseSchema = z
  .object({
    problems: z.array(QueueProblemSchema).describe('Failures by what went wrong, across every queue, most first'),
    tasks: z.array(QueueTaskSchema).describe('One per queue'),
  })
  .meta({ id: 'QueueOverviewResponseDto' });
const QueueProblemActionSchema = z
  .object({
    cause: QueueProblemCauseSchema,
    action: z
      .enum(['retry', 'stop'])
      .describe('retry: put the failed jobs back; stop: stop trying (unsupported files)')
      .meta({ id: 'QueueProblemAction' }),
  })
  .meta({ id: 'QueueProblemActionDto' });
const QueueProblemActionResponseSchema = z
  .object({ count: z.int().min(0).describe('Jobs put back, or photos stopped') })
  .meta({ id: 'QueueProblemActionResponseDto' });

/**
 * FL-349: the storage template migration — moving originals to the paths the storage template names —
 * as one status for the native apps' Migration page. It is the `storageTemplateMigration` queue.
 */
const StorageMigrationStatusResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether the storage template is turned on; a run moves nothing while it is off'),
    template: z.string().describe('The storage template originals are moved to'),
    isActive: z.boolean().describe('Whether a migration is running now'),
    isPaused: z.boolean().describe('Whether the storage template migration queue is paused'),
    hasUnfinishedWork: z
      .boolean()
      .describe('Whether durable work remains, including delayed, paused and unadmitted work'),
    statistics: QueueStatisticsSchema,
    candidates: z
      .int()
      .min(0)
      .describe('Uploaded originals a re-file checks; those already in place are not moved (FL-365)'),
  })
  .meta({ id: 'StorageMigrationStatusResponseDto' });

export class StorageMigrationStatusResponseDto extends createZodDto(StorageMigrationStatusResponseSchema) {}
export class QueueNameParamDto extends createZodDto(QueueNameParamSchema) {}
export class QueueJobParamDto extends createZodDto(QueueJobParamSchema) {}
export class QueueRunOneDto extends createZodDto(QueueRunOneSchema) {}
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
export class QueueOverviewResponseDto extends createZodDto(QueueOverviewResponseSchema) {}
export class QueueProblemActionDto extends createZodDto(QueueProblemActionSchema) {}
export class QueueProblemActionResponseDto extends createZodDto(QueueProblemActionResponseSchema) {}
