import { z } from 'zod';
import { Refusal, releaseTag, type Operation } from '../contracts.js';
import { NativeCheckpointSchema, type NativeInstallation } from './native.js';

export const NativeRecovery = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal('native'),
    mediaIncluded: z.literal(false),
    databaseFormat: z.literal('frameleaf-canonical'),
    libraryId: z.string().regex(/^[a-f0-9]{12}$/),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    installation: z
      .object({
        id: z.string().regex(/^[a-f0-9]{12}$/),
        name: z.string().trim().min(1).max(120),
        release: releaseTag,
      })
      .strict(),
    checkpoint: NativeCheckpointSchema,
  })
  .strict();
export type NativeRecoveryRecord = z.infer<typeof NativeRecovery>;

type Context = {
  installation: NativeInstallation;
  libraryId: string;
  name: string;
  release: string;
  operation: Pick<Operation, 'id' | 'createdAt'>;
};

export function createNativeRecovery(
  context: Context,
  checkpoint: unknown,
): NativeRecoveryRecord {
  const parsed = NativeRecovery.safeParse({
    schemaVersion: 1,
    runtime: context.installation.runtime,
    mediaIncluded: false,
    databaseFormat: 'frameleaf-canonical',
    libraryId: context.libraryId,
    createdAt: context.operation.createdAt,
    installation: {
      id: context.installation.id,
      name: context.name,
      release: context.release,
    },
    checkpoint,
  });
  if (
    !parsed.success ||
    parsed.data.checkpoint.operationId !== context.operation.id ||
    parsed.data.checkpoint.manifestSha256 !==
      context.installation.manifestSha256 ||
    parsed.data.checkpoint.sourceRevision !==
      context.installation.sourceRevision
  )
    throw new Refusal('native_recovery_invalid');
  return parsed.data;
}
