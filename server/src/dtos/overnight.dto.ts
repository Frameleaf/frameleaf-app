import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { OvernightStepTimingSchema } from 'src/enum.js';

/** FL-363: the overnight schedule's steps, in the order a night runs them. */
const OvernightStepSchema = z
  .enum(['cleanup', 'folders', 'icloud', 'fileChecks'])
  .describe('A step of the overnight schedule')
  .meta({ id: 'OvernightStep' });

const OvernightStepResultSchema = z
  .enum(['done', 'off', 'skipped', 'stopped', 'failed', 'unfinished'])
  .describe(
    'What a step did: done; off (switched off or not set up); skipped (not its night); stopped (the stop time came first); failed (it did not start); unfinished (still running when the run moved on)',
  )
  .meta({ id: 'OvernightStepResult' });

const OvernightResultsSchema = z
  .object({
    cleanup: OvernightStepResultSchema.optional(),
    folders: OvernightStepResultSchema.optional(),
    icloud: OvernightStepResultSchema.optional(),
    fileChecks: OvernightStepResultSchema.optional(),
  })
  .meta({ id: 'OvernightResultsDto' });

const OvernightResponseSchema = z
  .object({
    timezone: z.string().describe('The server time zone the schedule runs in'),
    nextRunAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the next run starts'),
    steps: z
      .array(
        z
          .object({
            id: OvernightStepSchema,
            on: z.boolean().describe('Whether the step is set up and switched on'),
            timing: OvernightStepTimingSchema,
          })
          .meta({ id: 'OvernightStepStatusDto' }),
      )
      .describe('The steps, in the order a night runs them'),
    run: z
      .object({
        startedAt: z.string().meta({ format: 'date-time' }),
        manual: z.boolean().describe('Started with Run now'),
        step: OvernightStepSchema,
        results: OvernightResultsSchema,
      })
      .meta({ id: 'OvernightRunDto' })
      .nullable()
      .describe('The run in progress'),
    nights: z
      .array(
        z
          .object({
            startedAt: z.string().meta({ format: 'date-time' }),
            finishedAt: z.string().meta({ format: 'date-time' }),
            manual: z.boolean(),
            results: OvernightResultsSchema,
          })
          .meta({ id: 'OvernightNightDto' }),
      )
      .describe('The most recent runs, newest first'),
  })
  .meta({ id: 'OvernightResponseDto' });

export class OvernightResponseDto extends createZodDto(OvernightResponseSchema) {}
