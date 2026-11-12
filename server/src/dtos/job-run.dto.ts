import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { RunRead } from 'src/queue/run-query.js';
import { QueueName, QueueNameSchema } from 'src/enum.js';
import { RUN_FAILURE_CAUSES } from 'src/queue/run-failure-cause.js';
import { stringToBool } from 'src/validation.js';

export const JobRunOutcomeSchema = z.enum([
  'completed',
  'failed',
  'needsAttention',
  'cancelled',
  'active',
  'retrying',
  'delayed',
  'paused',
  'waiting',
  'blocked',
]);
export const JobRunStateSchema = z.enum([
  'running',
  'retrying',
  'delayed',
  'paused',
  'waiting',
  'blocked',
  'unavailable',
  'needs_attention',
  'completed',
  'completed_with_errors',
  'cancelled',
]);
export const JobRunReasonSchema = z.enum([
  'worker_unavailable',
  'no_dispatch_backlog',
  'first_setup_pending',
  'dependency_unavailable',
  'dependency_wait',
  'dependency_failed',
  'retry_backoff',
  'scheduled_delay',
  'queue_paused',
  'needs_attention',
  'stage_failed',
  'enumerating',
  'workload-disabled',
  'destination-unavailable',
  'destination-configuration',
  'destination-consent',
  'destination-budget',
  'source-unavailable',
  'local-capacity',
]);
export const JobRunFailureCauseSchema = z
  .enum(RUN_FAILURE_CAUSES)
  .describe(
    "Why a photo was left over: drive (its external library can't be reached), missing (the file is gone), damaged, unsupported (a format that can't be read), or other",
  )
  .meta({ id: 'JobRunFailureCause' });
const counts = z.object({
  total: z.int().min(0),
  completed: z.int().min(0),
  failed: z.int().min(0),
  needsAttention: z.int().min(0),
  cancelled: z.int().min(0),
  active: z.int().min(0),
  retrying: z.int().min(0),
  delayed: z.int().min(0),
  paused: z.int().min(0),
  waiting: z.int().min(0),
  blocked: z.int().min(0),
});
const progress = z.object({
  stageTotals: counts,
  lastProgressAt: z.iso.datetime().nullable(),
  lastStage: z.string().nullable(),
  reasons: z.array(JobRunReasonSchema),
});
const page = z.object({
  take: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});
export class JobRunSearchDto extends createZodDto(
  page
    .extend({
      foldNightly: stringToBool
        .optional()
        .describe(
          'Show only the newest nightly run, with its earlier nights (Recent work); a nightly run with a newer one is left out',
        ),
    })
    .meta({ id: 'JobRunSearchDto' }),
) {}
export class JobRunItemSearchDto extends createZodDto(page.meta({ id: 'JobRunItemSearchDto' })) {}
export class JobRunFailuresSearchDto extends createZodDto(
  z
    .object({
      foldNightly: stringToBool
        .optional()
        .describe(
          "As Recent work's card counts them (foldNightly): a folded night's runs together, without the photos newer work left over again",
        ),
    })
    .meta({ id: 'JobRunFailuresSearchDto' }),
) {}
export class JobRunIdParamDto extends createZodDto(z.object({ id: z.uuid() })) {}
export const JobRunResponseSchema = counts
  .extend({
    id: z.uuid(),
    kind: z.string(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    enumerationDone: z.boolean(),
    state: JobRunStateSchema,
    noDispatchBacklog: z.boolean(),
    held: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Selected items an import's first setup still holds back: until Library Care's file check ends, or while setup is paused",
      ),
    canRelease: z
      .boolean()
      .optional()
      .describe('Some of its work is held (first setup or a paused setup) and can be released from the Jobs page'),
    countsPhotos: z
      .boolean()
      .optional()
      .describe('The counts are photos; when false they are tasks (the run works on something other than photos)'),
    failedQueues: z
      .array(QueueNameSchema)
      .optional()
      .describe('Queues with failed or needs-attention jobs in this run'),
    nightly: z.boolean().optional().describe("The overnight schedule's work"),
    pausedQueues: z
      .array(QueueNameSchema)
      .optional()
      .describe('Paused queues that unstarted work of this run waits on; resuming them lets it carry on'),
    unreachableLibraries: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("Names of up to three external libraries whose files work of this run waits for (can't be reached)"),
    failureCauses: z
      .array(z.object({ cause: JobRunFailureCauseSchema, count: z.int().min(1) }))
      .optional()
      .describe(
        'Photos left over (failed or needing attention) by cause, most telling first; stopped ones are left out. Absent when nothing failed',
      ),
    leftOver: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Photos that still need a look: the sum of failureCauses, present whenever it is. Cards use it rather than failed + needsAttention, which keep counting stopped photos and a live run's photos still being worked on",
      ),
    earlierRuns: z
      .array(
        z.object({
          id: z.uuid(),
          createdAt: z.iso.datetime(),
          finishedAt: z.iso.datetime().nullable(),
          total: z.int().min(0),
          leftOver: z.int().min(0).describe('Photos it left over'),
        }),
      )
      .max(6)
      .optional()
      .describe('With foldNightly, on the newest nightly run: the previous nights, newest first'),
    leftOverStreak: z
      .object({
        photos: z.int().min(1).describe('Photos this run left over (stopped ones aside)'),
        nights: z.int().min(1).describe('Nights in a row, this one included, that left all of them over'),
        capped: z
          .boolean()
          .optional()
          .describe('Every night it could count back through left them all: it may be longer ("N or more nights")'),
      })
      .optional()
      .describe('With foldNightly, on the newest nightly run: how long the same photos have been left over'),
    libraryName: z.string().optional().describe("A folder scan's library, while it exists"),
    countedOnce: z
      .boolean()
      .optional()
      .describe(
        'With foldNightly, on the night card: false when its photos could not be counted once each (too many, or their tasks are pruned); its numbers are then tasks (stageTotals)',
      ),
    origin: z
      .string()
      .optional()
      .describe(
        'What brought its photos in: phone, computer, client (an app or API key), link (a shared link), library (a folder scan) or import. More may come; absent for other work and runs from before',
      ),
    ownerId: z.uuid().optional().describe('Whose photos came in'),
    ownerName: z.string().optional().describe('The name of the account whose photos came in'),
    label: z.string().optional().describe("The phone's, computer's or app's own name, when it gave one"),
    itemCount: z.int().min(0).optional().describe('Photos and videos that came in with it'),
    steps: z
      .array(counts.extend({ queue: QueueNameSchema }).meta({ id: 'JobRunStepDto' }))
      .optional()
      .describe('With an origin, while it runs: its tasks counted by queue (tasks, not photos: faces count each face)'),
  })
  .extend(progress.shape)
  .meta({ id: 'JobRunResponseDto' });
export class JobRunResponseDto extends createZodDto(JobRunResponseSchema) {}
export class JobRunPageDto extends createZodDto(
  z
    .object({
      items: z.array(JobRunResponseSchema),
      hasNextPage: z.boolean(),
      fileCheck: z
        .object({
          running: z.boolean().describe('Some of the checks are still going'),
          startedAt: z.iso.datetime(),
          finishedAt: z.iso.datetime().nullable().describe('When the last one finished; null while any still runs'),
          checked: z.int().min(0).describe('Files checked so far; while a check runs this is often still 0'),
          total: z.int().min(0).describe('Files to check; 0 when not known yet'),
          damaged: z.int().min(0).describe('Files the finished checks found damaged'),
          missing: z.int().min(0).describe('Files the finished checks found missing'),
          failed: z
            .boolean()
            .optional()
            .describe("A finished check failed or was cancelled: it didn't finish its work"),
        })
        .optional()
        .describe(
          "With foldNightly, on the first page: Library care's checks for missing and damaged files, running now or finished in the last 12 hours",
        ),
    })
    .meta({ id: 'JobRunPageDto' }),
) {}
const item = progress.extend({ id: z.string(), outcome: JobRunOutcomeSchema }).meta({ id: 'JobRunItemResponseDto' });
export class JobRunItemResponseDto extends createZodDto(item) {}
export class JobRunItemPageDto extends createZodDto(
  z
    .object({
      items: z.array(item),
      hasNextPage: z.boolean(),
    })
    .meta({ id: 'JobRunItemPageDto' }),
) {}

const JobRunFailureSampleSchema = z
  .object({
    assetId: z.uuid().describe('The photo or video'),
    fileName: z.string().describe('The name of its file'),
    ownerName: z.string().describe('The name of the account whose library it is in'),
    pictureAllowed: z.boolean().describe('The caller may see its picture: false on another account’s photo'),
  })
  .meta({ id: 'JobRunFailureSampleDto' });
const JobRunFailureCauseGroupSchema = z
  .object({
    cause: JobRunFailureCauseSchema,
    count: z.int().min(0).describe('Photos of this cause that still need a look'),
    stopped: z.int().min(0).describe('Photos of this cause whose processing was stopped (Stop trying)'),
    repaired: z.int().min(0).describe('Of the photos needing a look, damaged files Library care already repaired'),
    libraries: z.array(z.string()).max(3).describe("For drive: up to three external libraries that can't be reached"),
    queues: z.array(QueueNameSchema).describe('Queues whose failed jobs these photos have (the per-photo lists)'),
    message: z
      .string()
      .nullable()
      .describe('One raw error message, from a photo in the samples and a job that may show it; null when none may'),
    samples: z
      .array(JobRunFailureSampleSchema)
      .max(6)
      .describe('Up to six of the photos the caller may see: never another account’s Locked or hidden media'),
  })
  .meta({ id: 'JobRunFailureCauseDto' });
export class JobRunFailuresDto extends createZodDto(
  z
    .object({
      photos: z.int().min(0).describe('Photos left over, stopped ones included'),
      countsPhotos: z.boolean().describe('The counts are photos; when false they are tasks'),
      causes: z.array(JobRunFailureCauseGroupSchema).describe('One per cause with photos, most telling first'),
      superseded: z
        .int()
        .min(0)
        .optional()
        .describe(
          'With foldNightly: photos left over here that newer work left over again; they are counted on its card, not here',
        ),
    })
    .meta({ id: 'JobRunFailuresResponseDto' }),
) {}
export const JobRunFailureActionSchema = z
  .enum(['retry', 'stop'])
  .describe('retry: try again now (drive or other); stop: stop trying (unsupported)')
  .meta({ id: 'JobRunFailureAction' });
export class JobRunFailureActionDto extends createZodDto(
  z
    .object({ cause: JobRunFailureCauseSchema, action: JobRunFailureActionSchema })
    .meta({ id: 'JobRunFailureActionDto' }),
) {}
export class JobRunFailureActionResponseDto extends createZodDto(
  z
    .object({ count: z.int().min(0).describe('Photos tried again or stopped') })
    .meta({ id: 'JobRunFailureActionResponseDto' }),
) {}

/** The public summary of a run: counts and progress only, never a selection, payload or error text. */
export const mapJobRun = (row: RunRead): JobRunResponseDto => ({
  id: row.id,
  kind: row.kind,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  enumerationDone: row.enumerationDone,
  total: row.total,
  completed: row.completed,
  failed: row.failed,
  needsAttention: row.needsAttention,
  cancelled: row.cancelled,
  active: row.active,
  retrying: row.retrying,
  delayed: row.delayed,
  paused: row.paused,
  waiting: row.waiting,
  blocked: row.blocked,
  stageTotals: row.stageTotals,
  state: row.state,
  lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
  lastStage: row.lastStage,
  reasons: row.reasons,
  noDispatchBacklog: row.noDispatchBacklog,
  held: row.held,
  canRelease: row.canRelease,
  countsPhotos: row.countsPhotos,
  failedQueues: row.failedQueues as QueueName[],
  nightly: row.nightly,
  pausedQueues: row.pausedQueues as QueueName[],
  ...(row.unreachableLibraries && { unreachableLibraries: row.unreachableLibraries }),
  ...(row.failureCauses && { failureCauses: row.failureCauses }),
  ...(row.leftOver !== undefined && { leftOver: row.leftOver }),
  ...(row.earlierRuns && {
    earlierRuns: row.earlierRuns.map((earlier) => ({
      id: earlier.id,
      createdAt: earlier.createdAt.toISOString(),
      finishedAt: earlier.finishedAt?.toISOString() ?? null,
      total: earlier.total,
      leftOver: earlier.leftOver,
    })),
  }),
  ...(row.leftOverStreak && { leftOverStreak: row.leftOverStreak }),
  ...(row.libraryName && { libraryName: row.libraryName }),
  ...(row.countedOnce !== undefined && { countedOnce: row.countedOnce }),
  ...(row.origin && { origin: row.origin }),
  ...(row.ownerId && { ownerId: row.ownerId }),
  ...(row.ownerName && { ownerName: row.ownerName }),
  ...(row.label && { label: row.label }),
  ...(row.itemCount !== undefined && { itemCount: row.itemCount }),
  ...(row.steps && { steps: row.steps.map((step) => ({ ...step, queue: step.queue as QueueName })) }),
});
