import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationSchema } from 'src/dtos/media-operation.dto.js';
import { MemoryExportResponseSchema } from 'src/dtos/memory.dto.js';
import { QueueNameSchema } from 'src/enum.js';

/**
 * One server job queue's current run, for the notifications panel (FL-72).
 *
 * A run starts when a queue gets work and ends once it has stayed empty for a short grace period,
 * so a queue that drains for a moment between two bursts keeps one bar. Within a run `total` grows
 * as work is added and holds steady as work finishes: it never goes backwards. Counts only: which
 * assets the jobs are for is never part of it.
 */
const QueueRunSchema = z
  .object({
    name: QueueNameSchema,
    isPaused: z.boolean().describe('Whether the queue is paused'),
    canPause: z.boolean().describe('Whether this queue can be paused; background tasks cannot'),
    active: z.int().min(0).describe('Jobs running now'),
    waiting: z.int().min(0).describe('Jobs waiting to start, including those held by a paused queue'),
    processed: z.int().min(0).describe('Jobs finished, completed or failed, since this run started'),
    total: z.int().min(0).describe('processed + active + waiting'),
    startedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When this run was first seen with work'),
  })
  .meta({ id: 'QueueRunDto' });

/**
 * Everything running in the background that the signed-in account may see, in one answer, so the
 * notifications panel polls one route instead of one per source (FL-104, FL-72).
 *
 * - `operations`: the account's own unfinished media operations, paused ones included.
 * - `memoryExports`: the account's own highlight exports still being written.
 * - `queues`: the server's job queues that have work. Administrators only; everybody else gets an
 *   empty list and `canManageQueues: false`, never a count of somebody else's work.
 */
const RunningJobsResponseSchema = z
  .object({
    operations: z.array(MediaOperationSchema),
    memoryExports: z.array(MemoryExportResponseSchema),
    queues: z.array(QueueRunSchema).describe('Server job queues with work; always empty for non-administrators'),
    canManageQueues: z.boolean().describe('Whether the viewer may see and pause the server job queues'),
  })
  .meta({ id: 'RunningJobsResponseDto' });

export class QueueRunDto extends createZodDto(QueueRunSchema) {}
export class RunningJobsResponseDto extends createZodDto(RunningJobsResponseSchema) {}
