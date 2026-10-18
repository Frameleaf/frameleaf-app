import { z } from 'zod';

export const NativeRestoreInputBinding = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal('native'),
    operationId: z.string().uuid(),
    reviewId: z.string().uuid(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    installationId: z.string().regex(/^[a-f0-9]{12}$/),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    libraryId: z.string().regex(/^[a-f0-9]{12}$/),
    recoverySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
