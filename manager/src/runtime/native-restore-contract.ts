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

export type NativeRestoreBinding = z.infer<typeof NativeRestoreInputBinding>;
const operationId = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
const physicalIdentity = z
  .string()
  .max(128)
  .regex(/^[0-9]+:[0-9]+$/);
export const NativeRestorePreparedSchema = z
  .object({
    protocolVersion: z.literal(1),
    schemaVersion: z.literal(1),
    state: z.literal('restore-prepared'),
    binding: NativeRestoreInputBinding,
    attemptId: operationId,
    profileIdentity: physicalIdentity,
    targetIdentity: physicalIdentity,
    databaseIdentity: physicalIdentity,
    validation: z
      .object({
        postgresMajor: z.literal(19),
        vectorVersion: z.literal('0.8.7'),
        canonical: z.literal(true),
        executionStateReconstructed: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type NativeRestorePrepared = z.infer<typeof NativeRestorePreparedSchema>;
export const NativeRestoreReply = z.discriminatedUnion('state', [
  NativeRestorePreparedSchema,
  z
    .object({
      protocolVersion: z.literal(1),
      state: z.literal('restore-prepare-failed'),
      operationId,
      code: z.literal('host_restore_failed'),
    })
    .strict(),
]);
