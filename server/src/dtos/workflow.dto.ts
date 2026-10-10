import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import type { WorkflowIssue } from 'src/utils/workflow-definition.js';
import {
  WorkflowIssueCodeSchema,
  WorkflowResultSchema,
  WorkflowRunErrorCodeSchema,
  WorkflowTriggerSchema,
  WorkflowTypeSchema,
} from 'src/enum.js';
import { redactCredentials } from 'src/utils/workflow-definition.js';
import { isoDatetimeToDate } from 'src/validation.js';

const ExtraFieldsSchema = z
  .record(z.string(), z.unknown())
  .describe('Additional fields of an imported definition, kept and exported unchanged');

const WorkflowTriggerResponseSchema = z
  .object({
    trigger: WorkflowTriggerSchema.describe('Trigger type'),
    types: z.array(WorkflowTypeSchema).describe('Workflow types'),
  })
  .meta({ id: 'WorkflowTriggerResponseDto' });

const WorkflowSearchSchema = z
  .object({
    id: z.uuidv4().optional().describe('Workflow ID'),
    trigger: WorkflowTriggerSchema.optional().describe('Workflow trigger type'),
    name: z.string().optional().describe('Workflow name'),
    description: z.string().optional().describe('Workflow description'),
    enabled: z.boolean().optional().describe('Workflow enabled'),
    logging: z.boolean().optional().describe('Workflow logs run results'),
  })
  .meta({ id: 'WorkflowSearchDto' });

const WorkflowStepSchema = z
  .object({
    id: z
      .uuid()
      .optional()
      .describe('Step ID from a previous response. A credential left out of its configuration keeps its stored value'),
    method: z.string().min(1).max(300).describe('Step plugin method, as plugin#method'),
    config: z.record(z.string(), z.unknown()).nullable().describe('Step configuration'),
    enabled: z.boolean().optional().describe('Step is enabled'),
    extra: ExtraFieldsSchema.optional(),
  })
  .meta({ id: 'WorkflowStepDto' });

const WorkflowStepResponseSchema = z
  .object({
    id: z.uuid().describe('Step ID'),
    method: z.string().describe('Step plugin method, as plugin#method'),
    config: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Step configuration, without stored credential values'),
    enabled: z.boolean().describe('Step is enabled'),
    extra: ExtraFieldsSchema,
    storedSecrets: z
      .array(z.string())
      .describe('Configuration paths (keys joined with ".") holding a stored credential that is never returned'),
  })
  .meta({ id: 'WorkflowStepResponseDto' });

const WorkflowShareStepSchema = z
  .object({
    method: z.string().describe('Step plugin method'),
    config: z.record(z.string(), z.unknown()).nullable().describe('Step configuration, without credentials'),
    enabled: z.boolean().optional().describe('Step is enabled'),
    extra: ExtraFieldsSchema,
  })
  .meta({ id: 'WorkflowShareStepDto' });

const WorkflowIssueSchema = z
  .object({
    step: z.int().nonnegative().optional().describe('Index of the step the issue belongs to'),
    code: WorkflowIssueCodeSchema,
    message: z.string().describe('What prevents the workflow from running'),
  })
  .meta({ id: 'WorkflowIssueDto' });

const TriggerInputSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('Workflow trigger type. An unavailable trigger is kept, but the workflow cannot be enabled');

const WorkflowCreateSchema = z
  .object({
    trigger: TriggerInputSchema,
    name: z.string().max(300).nullable().optional().describe('Workflow name'),
    description: z.string().max(2000).nullable().optional().describe('Workflow description'),
    enabled: z.boolean().optional().describe('Workflow enabled'),
    logging: z.boolean().optional().describe('Workflow logs run results'),
    steps: z.array(WorkflowStepSchema).max(100).optional(),
    extra: ExtraFieldsSchema.optional(),
  })
  .meta({ id: 'WorkflowCreateDto' });

const WorkflowUpdateSchema = z
  .object({
    trigger: TriggerInputSchema.optional(),
    name: z.string().max(300).nullable().optional().describe('Workflow name'),
    description: z.string().max(2000).nullable().optional().describe('Workflow description'),
    enabled: z.boolean().optional().describe('Workflow enabled'),
    logging: z.boolean().optional().describe('Workflow logs run results'),
    steps: z.array(WorkflowStepSchema).max(100).optional(),
    extra: ExtraFieldsSchema.optional(),
  })
  .meta({ id: 'WorkflowUpdateDto' });

const WorkflowResponseSchema = z
  .object({
    id: z.uuidv4().describe('Workflow ID'),
    trigger: z.string().describe('Workflow trigger type'),
    name: z.string().nullable().describe('Workflow name'),
    description: z.string().nullable().describe('Workflow description'),
    createdAt: z.string().describe('Creation date'),
    updatedAt: z.string().describe('Update date'),
    enabled: z.boolean().describe('Workflow enabled'),
    logging: z.boolean().describe('Workflow logs run results'),
    steps: z.array(WorkflowStepResponseSchema).describe('Workflow steps'),
    extra: ExtraFieldsSchema,
    issues: z
      .array(WorkflowIssueSchema)
      .describe('What prevents this definition from running on this server; empty when it can run'),
  })
  .meta({ id: 'WorkflowResponseDto' });

const WorkflowShareResponseSchema = z
  .object({
    trigger: z.string().describe('Workflow trigger type'),
    name: z.string().nullable().describe('Workflow name'),
    description: z.string().nullable().describe('Workflow description'),
    steps: z.array(WorkflowShareStepSchema).describe('Workflow steps'),
    extra: ExtraFieldsSchema,
  })
  .meta({ id: 'WorkflowShareResponseDto' });

const WorkflowLogEntrySchema = z
  .object({
    id: z.uuidv4().describe('Workflow log entry ID'),
    at: isoDatetimeToDate.describe('Workflow run date/time'),
    result: WorkflowResultSchema.describe('Workflow run result'),
    runId: z.uuid().describe('Run ID shared by every attempt of one run'),
    attempt: z.int().nonnegative().describe('0 for the first attempt, 1 for the automatic retry, then manual retries'),
    errorCode: WorkflowRunErrorCodeSchema.optional(),
    error: z.string().optional().describe('Why the run failed, without stored credentials'),
    triggerDataId: z.uuid().optional().describe('Workflow trigger data ID'),
    lastStep: z
      .object({
        method: z.string().describe('Method of the step'),
        index: z.int().nonnegative().describe('Index of the step in the workflow'),
      })
      .optional()
      .describe('Last step ran, if the workflow ended early'),
  })
  .meta({ id: 'WorkflowLogEntryDto' });

const WorkflowGetLogsSchema = z.object({
  result: WorkflowResultSchema.optional().describe('Filter by run result'),
  before: isoDatetimeToDate.optional().describe('Filter by runs before a date/time'),
  limit: z.coerce.number().int().positive().max(200).default(50).describe('Maximum number of logs'),
});

const WorkflowRunParamsSchema = z.object({
  id: z.uuid().describe('Workflow ID'),
  runId: z.uuid().describe('Run ID'),
});

export class WorkflowTriggerResponseDto extends createZodDto(WorkflowTriggerResponseSchema) {}
export class WorkflowSearchDto extends createZodDto(WorkflowSearchSchema) {}
export class WorkflowStepDto extends createZodDto(WorkflowStepSchema) {}
export class WorkflowCreateDto extends createZodDto(WorkflowCreateSchema) {}
export class WorkflowUpdateDto extends createZodDto(WorkflowUpdateSchema) {}
export class WorkflowResponseDto extends createZodDto(WorkflowResponseSchema) {}
export class WorkflowShareResponseDto extends createZodDto(WorkflowShareResponseSchema) {}
export class WorkflowLogEntryDto extends createZodDto(WorkflowLogEntrySchema) {}
export class WorkflowGetLogsDto extends createZodDto(WorkflowGetLogsSchema) {}
export class WorkflowRunParamsDto extends createZodDto(WorkflowRunParamsSchema) {}

type Workflow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string | null;
  description: string | null;
  enabled: boolean;
  logging: boolean;
};

/** Unknown fields are kept as written, but a credential-shaped value in them is never returned. */
const redactExtra = (extra: Record<string, unknown>): Record<string, unknown> => redactCredentials(extra).config ?? {};

export const mapWorkflow = (
  workflow: Workflow,
  definition: WorkflowDefinitionDocument,
  issues: WorkflowIssue[],
): WorkflowResponseDto => ({
  id: workflow.id,
  enabled: workflow.enabled,
  trigger: definition.trigger,
  logging: workflow.logging,
  name: workflow.name,
  description: workflow.description,
  createdAt: workflow.createdAt.toISOString(),
  updatedAt: workflow.updatedAt.toISOString(),
  extra: redactExtra(definition.extra),
  issues,
  steps: definition.steps.map((step) => {
    const { config, storedSecrets } = redactCredentials(step.config);
    return {
      id: step.id,
      method: step.method,
      config,
      enabled: step.enabled,
      extra: redactExtra(step.extra),
      storedSecrets,
    };
  }),
});

/** The portable definition: no ids, no stored credentials, every additional field. */
export const mapWorkflowShare = (
  workflow: Pick<Workflow, 'name' | 'description'>,
  definition: WorkflowDefinitionDocument,
): WorkflowShareResponseDto => ({
  trigger: definition.trigger,
  name: workflow.name,
  description: workflow.description,
  extra: redactExtra(definition.extra),
  steps: definition.steps.map((step) => ({
    method: step.method,
    config: redactCredentials(step.config).config,
    enabled: step.enabled ? undefined : false,
    extra: redactExtra(step.extra),
  })),
});
