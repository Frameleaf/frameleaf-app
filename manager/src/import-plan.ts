import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { Refusal } from './contracts.js';

export const importHash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const nanoseconds = z.string().regex(/^(0|-?[1-9]\d*)$/);
const id = z.string().min(1).max(1024);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[a-z]:/i.test(value) &&
      [...value].every((c) => c >= ' ') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
export const importRelativePathSchema = path;
const legacyTransferSchema = z.strictObject({
  id,
  mode: z.enum(['copy', 'adopt', 'relocate']),
  sourceRoot: id,
  sourcePath: path,
  destinationRoot: id,
  destinationPath: path,
  sha256: importHash,
  bytes: decimal,
  sourceIdentity: z.strictObject({
    device: decimal,
    inode: decimal,
    bytes: decimal,
    mtimeNs: nanoseconds,
    ctimeNs: nanoseconds,
    links: decimal,
  }),
  destinationDevice: decimal,
});
export const importSourceIdentitySchema =
  legacyTransferSchema.shape.sourceIdentity;
const placementSchema = legacyTransferSchema.extend({
  sourceAssetId: id,
  sourceFileId: id,
});
export const importTransferSchema = z.union([
  legacyTransferSchema,
  placementSchema,
]);
export type ImportTransfer = z.infer<typeof importTransferSchema>;

const legacyPlanSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({
    kind: z.enum([
      'immich',
      'photoprism',
      'librephotos',
      'photoview',
      'piwigo',
      'lychee',
      'pigallery2',
      'ente',
      'nextcloud',
      'synology',
    ]),
    version: id,
    identity: id,
    revision: id,
    schemaSha256: importHash,
  }),
  destinationId: z.uuid(),
  owners: z.array(z.strictObject({ sourceId: id, destinationId: z.uuid() })),
  roots: z.array(
    z.strictObject({
      id,
      path: z
        .string()
        .min(2)
        .max(4096)
        .refine(
          (value) =>
            value.startsWith('/') &&
            posix.normalize(value) === value &&
            !value.endsWith('/') &&
            !value.includes('\\') &&
            [...value].every((c) => c >= ' '),
        ),
      device: decimal,
      inode: decimal,
    }),
  ),
  files: z.array(legacyTransferSchema),
});
export const importSourceSchema = legacyPlanSchema.shape.source;
const planSchema = z.discriminatedUnion('version', [
  legacyPlanSchema,
  legacyPlanSchema.extend({
    version: z.literal(2),
    files: z.array(placementSchema),
  }),
]);
export const importSourceKinds =
  legacyPlanSchema.shape.source.shape.kind.options;
export type ImportPlan = z.infer<typeof planSchema>;

export function parseImportPlan(input: unknown): ImportPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new Refusal('import_plan_invalid');
  const plan = parsed.data;
  const unique = (values: string[]) => new Set(values).size === values.length;
  const roots = new Map(plan.roots.map((root) => [root.id, root]));
  if (
    !unique(plan.owners.map((owner) => owner.sourceId)) ||
    !unique(plan.owners.map((owner) => owner.destinationId.toLowerCase())) ||
    !unique(plan.roots.map((root) => root.id)) ||
    !unique(plan.roots.map((root) => root.path)) ||
    !unique(
      plan.roots.map((root) => JSON.stringify([root.device, root.inode])),
    ) ||
    !unique(plan.files.map((file) => file.id)) ||
    !unique(
      plan.files.map((file) =>
        posix.join(
          roots.get(file.destinationRoot)?.path ?? '/',
          file.destinationPath,
        ),
      ),
    ) ||
    !unique(
      plan.files.map((file) =>
        JSON.stringify([file.destinationRoot, file.destinationPath]),
      ),
    ) ||
    plan.files.some((file) => {
      const source = roots.get(file.sourceRoot),
        destination = roots.get(file.destinationRoot);
      return (
        !source ||
        !destination ||
        file.bytes !== file.sourceIdentity.bytes ||
        file.sourceIdentity.links === '0' ||
        source.device !== file.sourceIdentity.device ||
        destination.device !== file.destinationDevice ||
        (file.mode === 'relocate' && source.device !== destination.device)
      );
    })
  )
    throw new Refusal('import_plan_invalid');
  if (plan.version === 2) {
    const sources = new Map<string, (typeof plan.files)[number]>();
    const pairs = new Set<string>();
    for (const file of plan.files) {
      const pair = JSON.stringify([file.sourceAssetId, file.sourceFileId]);
      const previous = sources.get(file.sourceFileId);
      if (
        pairs.has(pair) ||
        (previous &&
          (previous.mode !== 'copy' ||
            file.mode !== 'copy' ||
            JSON.stringify([
              previous.sourceRoot,
              previous.sourcePath,
              previous.sourceIdentity,
              previous.sha256,
              previous.bytes,
            ]) !==
              JSON.stringify([
                file.sourceRoot,
                file.sourcePath,
                file.sourceIdentity,
                file.sha256,
                file.bytes,
              ])))
      )
        throw new Refusal('import_plan_invalid');
      pairs.add(pair);
      sources.set(file.sourceFileId, file);
    }
  }
  return plan;
}

/** Schema field order makes the fingerprint independent of input object key order. Array order is part of review. */
export function importPlanSha256(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(parseImportPlan(input)))
    .digest('hex');
}

const comparison = z.strictObject({
  expectedSha256: importHash,
  actualSha256: importHash,
});
export const importVerificationSchema = z.strictObject({
  manifestSha256: importHash,
  planSha256: importHash,
  records: comparison,
  relationships: comparison,
  permissions: comparison,
  regenerationRunId: z.uuid(),
});
export type ImportVerification = z.infer<typeof importVerificationSchema>;
