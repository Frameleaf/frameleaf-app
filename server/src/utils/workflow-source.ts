import { CronTime } from 'cron';
import { createHash } from 'node:crypto';
import z from 'zod';
import { SearchFilterSchema } from 'src/dtos/search.dto.js';
import { ImageEnrichmentFilterSchema } from 'src/enum.js';

export const WorkflowSourceSchema = z
  .strictObject({
    filter: SearchFilterSchema,
    imageEnrichment: ImageEnrichmentFilterSchema.optional(),
    semantic: z
      .strictObject({
        query: z.string().trim().min(1).max(2000).optional(),
        queryAssetId: z.uuid().optional(),
        maxDistance: z.number().min(0).max(2).meta({ format: 'double' }),
      })
      .refine((value) => !!value.query !== !!value.queryAssetId, 'Choose text or a reference photo')
      .optional(),
    rollingDates: z
      .array(
        z.strictObject({
          field: z.enum(['takenAt', 'localDateTime', 'createdAt', 'updatedAt']),
          days: z.number().int().positive().max(36_500),
        }),
      )
      .max(4)
      .optional(),
  })
  .meta({ id: 'WorkflowSourceDto' });
// Paused imports retain invalid cron text; enabling and execution use the validator below.
export const WorkflowScheduleInputSchema = z
  .strictObject({ cron: z.string().trim().max(160) })
  .meta({ id: 'WorkflowScheduleDto' });
export const WorkflowScheduleSchema = z
  .strictObject({
    cron: z
      .string()
      .trim()
      .refine((cron) => {
        if (cron.split(/\s+/).length !== 5) return false;
        try {
          new CronTime(cron, 'UTC').getNextDateFrom(new Date(), 'UTC');
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid five-field cron schedule'),
  })
  .meta({ id: 'WorkflowScheduleDto' });
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;
export type WorkflowSchedule = z.infer<typeof WorkflowScheduleSchema>;

export function resolveWorkflowSource(source: WorkflowSource, at: Date): WorkflowSource {
  const result = WorkflowSourceSchema.parse(JSON.parse(JSON.stringify(source)));
  for (const rolling of result.rollingDates ?? []) {
    result.filter[rolling.field] = { gte: new Date(at.getTime() - rolling.days * 86_400_000) };
  }
  delete result.rollingDates;
  return result;
}
export function nextWorkflowOccurrence(schedule: WorkflowSchedule, after: Date, timezone: string): Date {
  return new CronTime(schedule.cron, timezone).getNextDateFrom(after, timezone).toJSDate();
}

export const workflowDefinitionHash = (definition: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(definition, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : value,
      ),
    )
    .digest('hex');
