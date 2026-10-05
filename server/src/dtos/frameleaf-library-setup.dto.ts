import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class LibrarySetupStatusDto extends createZodDto(
  z.object({
    installation: z.string(),
    origin: z.enum(['new_import', 'new_library', 'restored_library']),
    phase: z.enum(['awaiting-account', 'rescanning', 'verifying', 'needs-attention', 'complete']),
    setupRequired: z.boolean(),
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
