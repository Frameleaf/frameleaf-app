import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import {
  importFilePathSchema,
  manifestFingerprint,
  parseImportManifest,
  sourceKinds,
} from 'src/library-import/manifest.js';
import { type LibraryImportBinding, LibraryImportRefused } from 'src/library-import/state.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const nanoseconds = z.string().regex(/^(0|-?[1-9]\d*)$/);
const id = z.string().min(1).max(1024);
const transferSchema = z.strictObject({
  id,
  mode: z.enum(['copy', 'adopt', 'relocate']),
  sourceRoot: id,
  sourcePath: importFilePathSchema,
  destinationRoot: id,
  destinationPath: importFilePathSchema,
  sha256: hash,
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
const placementSchema = transferSchema.extend({ sourceAssetId: id, sourceFileId: id });

// Field order is the Manager v1 wire contract and therefore part of its reviewed fingerprint.
const legacyPlanSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({ kind: z.enum(sourceKinds), version: id, identity: id, revision: id, schemaSha256: hash }),
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
            [...value].every((character) => character >= ' '),
        ),
      device: decimal,
      inode: decimal,
    }),
  ),
  files: z.array(transferSchema),
});
const planSchema = z.discriminatedUnion('version', [
  legacyPlanSchema,
  legacyPlanSchema.extend({ version: z.literal(2), files: z.array(placementSchema) }),
]);
export type DestinationImportPlan = z.infer<typeof planSchema>;
const digest = (plan: DestinationImportPlan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

/** Reviewed structure only; filesystem effects and source qualification require independent evidence. */
export function parseDestinationImportPlan(input: unknown): DestinationImportPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new LibraryImportRefused('IMPORT_PLAN_INVALID');
  const plan = parsed.data;
  const unique = (values: string[]) => new Set(values).size === values.length;
  const roots = new Map(plan.roots.map((root) => [root.id, root]));
  if (
    !unique(plan.owners.map((owner) => owner.sourceId)) ||
    !unique(plan.owners.map((owner) => owner.destinationId.toLowerCase())) ||
    !unique(plan.roots.map((root) => root.id)) ||
    !unique(plan.roots.map((root) => root.path)) ||
    !unique(plan.roots.map((root) => JSON.stringify([root.device, root.inode]))) ||
    !unique(plan.files.map((file) => file.id)) ||
    !unique(plan.files.map((file) => posix.join(roots.get(file.destinationRoot)?.path ?? '/', file.destinationPath))) ||
    !unique(plan.files.map((file) => JSON.stringify([file.destinationRoot, file.destinationPath]))) ||
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
    throw new LibraryImportRefused('IMPORT_PLAN_INVALID');
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
            ]) !== JSON.stringify([file.sourceRoot, file.sourcePath, file.sourceIdentity, file.sha256, file.bytes])))
      )
        throw new LibraryImportRefused('IMPORT_PLAN_INVALID');
      pairs.add(pair);
      sources.set(file.sourceFileId, file);
    }
  }
  return plan;
}

export const destinationPlanFingerprint = (input: unknown): string => digest(parseDestinationImportPlan(input));

/** Bind the full reviewed inventory before the writer derives any owner or destination path. */
export function bindDestinationImportPlan(
  input: unknown,
  binding: LibraryImportBinding,
  manifestInput: unknown,
  destinationId: string,
): DestinationImportPlan {
  const plan = parseDestinationImportPlan(input);
  let manifest;
  try {
    manifest = parseImportManifest(manifestInput);
  } catch {
    throw new LibraryImportRefused('IMPORT_PLAN_MANIFEST_INVALID');
  }
  if (manifestFingerprint(manifest) !== binding.manifestSha256 || digest(plan) !== binding.planSha256)
    throw new LibraryImportRefused('IMPORT_PLAN_BINDING_CHANGED');
  if (!z.uuid().safeParse(destinationId).success || plan.destinationId.toLowerCase() !== destinationId.toLowerCase())
    throw new LibraryImportRefused('IMPORT_PLAN_DESTINATION_CHANGED');
  for (const key of ['kind', 'version', 'identity', 'revision', 'schemaSha256'] as const)
    if (plan.source[key] !== binding.source[key] || plan.source[key] !== manifest.source[key])
      throw new LibraryImportRefused('IMPORT_PLAN_SOURCE_CHANGED');
  const owners = new Set(manifest.users.map((owner) => owner.id));
  if (plan.owners.length !== owners.size || plan.owners.some((owner) => !owners.has(owner.sourceId)))
    throw new LibraryImportRefused('IMPORT_PLAN_OWNER_MISMATCH');
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const references = new Set(
    manifest.assets.flatMap((asset) => asset.fileIds.map((id) => JSON.stringify([asset.id, id]))),
  );
  if (
    plan.version === 1
      ? plan.files.length !== files.size ||
        references.size !== files.size ||
        plan.files.some((file) => {
          const original = files.get(file.id);
          return !original || original.sha256 !== file.sha256 || original.bytes !== file.bytes;
        })
      : plan.files.length !== references.size ||
        plan.files.some((file) => {
          const original = files.get(file.sourceFileId);
          return (
            !original ||
            !references.has(JSON.stringify([file.sourceAssetId, file.sourceFileId])) ||
            original.path !== file.sourcePath ||
            original.sha256 !== file.sha256 ||
            original.bytes !== file.bytes
          );
        })
  )
    throw new LibraryImportRefused('IMPORT_PLAN_FILE_MISMATCH');
  const primaries = new Set<string>();
  for (const asset of plan.version === 2 ? manifest.assets : []) {
    const primary = files.get(
      'primaryFileId' in asset && typeof asset.primaryFileId === 'string'
        ? asset.primaryFileId
        : asset.fileIds.find((id) => files.get(id)!.role === 'original')!,
    )!;
    const key = JSON.stringify([asset.ownerId, primary.sha256]);
    if (primaries.has(key)) throw new LibraryImportRefused('IMPORT_PLAN_DUPLICATE_REVIEW_REQUIRED');
    primaries.add(key);
  }
  return plan;
}
