import { createZodDto } from 'nestjs-zod';
import z from 'zod';

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
export class JobRunSearchDto extends createZodDto(
  z
    .object({
      take: z.coerce.number().int().min(1).max(100).default(25),
      skip: z.coerce.number().int().min(0).default(0),
    })
    .meta({ id: 'JobRunSearchDto' }),
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
  })
  .extend(progress.shape)
  .meta({ id: 'JobRunResponseDto' });
export class JobRunResponseDto extends createZodDto(JobRunResponseSchema) {}
export class JobRunPageDto extends createZodDto(
  z
    .object({
      items: z.array(JobRunResponseSchema),
      hasNextPage: z.boolean(),
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
