import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class LibrarySetupStatusDto extends createZodDto(
  z.object({
    installation: z.string(),
    origin: z.enum(['new_import', 'new_library', 'restored_library']),
    phase: z.enum(['awaiting-account', 'rescanning', 'verifying', 'needs-attention', 'complete']),
    setupRequired: z.boolean(),
    dismissed: z
      .boolean()
      .describe('The owner stopped setup to let the server run; held work was released. Retrying brings setup back'),
    checkProblem: z
      .boolean()
      .optional()
      .describe(
        'A file check or library scan ended early (failed or cancelled). Setup carried on; Library Care lists what it could not check',
      ),
    revision: z.uuid().nullable(),
    rescanComplete: z.boolean(),
    verificationPassed: z.boolean(),
    canFinish: z.boolean(),
    regeneration: z
      .object({
        runId: z.uuid().nullable(),
        state: z.string(),
        preparedAt: z.string().nullable(),
        startedAt: z.string().nullable(),
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        needsAttention: z.number().int().nonnegative(),
        reasons: z.array(z.string()),
      })
      .nullable()
      .optional(),
    sync: z.object({ authenticated: z.boolean(), catalogComplete: z.boolean(), previewsReady: z.boolean() }),
  }),
) {}

export class FinishLibrarySetupDto extends createZodDto(
  z
    .object({
      revision: z.uuid(),
      receipt: z.string().regex(/^[a-f0-9]{64}$/),
      previewsReady: z.literal(true),
    })
    .strict(),
) {}

export class WarmLibrarySetupDto extends createZodDto(z.object({ reset: z.boolean().optional() }).strict()) {}

const SetupStageSchema = z.object({
  id: z.enum(['check', 'thumbnails', 'search']).meta({ id: 'LibrarySetupStageId' }),
  status: z.enum(['done', 'running', 'paused', 'waiting']).meta({ id: 'LibrarySetupStageStatus' }),
  disabled: z
    .boolean()
    .optional()
    .describe('AI processing is turned off; retained work can resume when enabled. Videos still count in the stage'),
  heldForNight: z
    .boolean()
    .optional()
    .describe('Quiet hours saved this stage for the overnight window; it starts again by itself'),
  resumesAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .describe('When quiet hours start this stage again; null when the overnight schedule never starts'),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** FL-1146 setup bar: what an imported library still has to do after it opens. */
export class LibrarySetupProgressDto extends createZodDto(
  z.object({
    active: z.boolean().describe('False when this server was not set up from an import, or before its first setup'),
    phase: z.enum(['awaiting-account', 'rescanning', 'verifying', 'needs-attention', 'complete']).nullable(),
    paused: z.boolean(),
    checkProblem: z
      .boolean()
      .optional()
      .describe(
        'A file check or library scan ended early (failed or cancelled). Setup carried on; Library Care lists what it could not check',
      ),
    completedAt: z.string().nullable().describe('When everything finished; null while setup runs'),
    items: z.number().int().nonnegative(),
    people: z.number().int().nonnegative().describe('Named people, for the completion window'),
    albums: z.number().int().nonnegative(),
    flagged: z.number().int().nonnegative().describe('Originals listed in Library Care as missing or changed'),
    stages: z.array(SetupStageSchema),
  }),
) {}

export class LibrarySetupPauseDto extends createZodDto(z.object({ paused: z.boolean() }).strict()) {}
