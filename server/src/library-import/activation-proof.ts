import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ManagerLibrarySetup, libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { type ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';
import { LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .max(128);
const identity = {
  version: z.literal(1),
  operationId: uuid,
  manifestSha256: hash,
  planSha256: hash,
};
const reportSchema = z.strictObject({
  ...identity,
  format: z.literal('frameleaf-library-import-verification'),
  owners: z
    .strictObject({
      ...identity,
      format: z.literal('frameleaf-owner-reconciliation'),
      owners: count,
      preservedPasswords: count,
      claimPending: count,
      sha256: hash,
    })
    .refine((value) => value.owners === value.preservedPasswords + value.claimPending),
  assets: z.strictObject({
    ...identity,
    format: z.literal('frameleaf-asset-reconciliation'),
    version: z.literal(2),
    assets: count,
    originals: count,
    tagNodes: count,
    tagAssignments: count,
    bytes: decimal,
    sha256: hash,
  }),
  albums: z.strictObject({
    ...identity,
    format: z.literal('frameleaf-album-reconciliation'),
    albums: count,
    memberships: count,
    grants: count,
    sha256: hash,
  }),
  stacks: z.strictObject({
    ...identity,
    format: z.literal('frameleaf-stack-reconciliation'),
    stacks: count,
    memberships: count,
    sha256: hash,
  }),
  archive: z.strictObject({
    format: z.literal('frameleaf-source-archive-verification'),
    version: z.literal(1),
    operationId: uuid,
    records: decimal,
    bytes: decimal,
    sha256: hash,
    sealed: z.literal(true),
  }),
});
const proofSchema = z.strictObject({
  format: z.literal('frameleaf-library-import-activation'),
  version: z.literal(1),
  binding: z.unknown().transform(parseLibraryImportBinding),
  destinationId: uuid,
  runId: uuid,
  manager: z.strictObject({ installation: z.string().regex(/^[a-f0-9]{12}$/u), operationId: uuid }).nullable(),
  activatedAt: z.iso.datetime(),
  report: reportSchema,
});
export type LibraryImportActivation = z.infer<typeof proofSchema>;
const fingerprint = (value: LibraryImportActivation) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (): never => {
  throw new LibraryImportRefused('IMPORT_ACTIVATION_PROOF_INVALID');
};

const parse = (input: unknown, context: ReviewedImportContext): LibraryImportActivation => {
  try {
    const proof = proofSchema.parse(input);
    const binding = parseLibraryImportBinding(context.binding);
    if (
      JSON.stringify(proof.binding) !== JSON.stringify(binding) ||
      proof.destinationId !== uuid.parse(context.destinationId) ||
      proof.runId !== libraryImportDerivedRunId(binding) ||
      (proof.manager && proof.manager.operationId !== binding.operationId)
    )
      return refuse();
    for (const value of [
      proof.report,
      proof.report.owners,
      proof.report.assets,
      proof.report.albums,
      proof.report.stacks,
    ]) {
      if (
        value.operationId !== binding.operationId ||
        value.manifestSha256 !== binding.manifestSha256 ||
        value.planSha256 !== binding.planSha256
      )
        return refuse();
    }
    if (proof.report.archive.operationId !== binding.operationId) return refuse();
    return proof;
  } catch {
    // Parser diagnostics must not disclose retained source identity or unsupported private fields.
    return refuse();
  }
};

/** Seal only an independently verified result; this codec does not qualify a source or authorize activation. */
export const sealLibraryImportActivation = (
  context: ReviewedImportContext,
  report: unknown,
  manager: ManagerLibrarySetup | undefined,
  activatedAt: string,
) => {
  try {
    const bound = {
      binding: parseLibraryImportBinding(context.binding),
      destinationId: uuid.parse(context.destinationId),
    };
    const payload = parse(
      {
        format: 'frameleaf-library-import-activation',
        version: 1,
        ...bound,
        runId: libraryImportDerivedRunId(bound.binding),
        manager: manager ?? null,
        activatedAt,
        report,
      },
      bound,
    );
    return { payload, sha256: fingerprint(payload) };
  } catch {
    return refuse();
  }
};

/** Schema reconstruction gives JSONB objects one stable key order before checking the retained digest. */
export const readLibraryImportActivation = (
  record: { payload: unknown; sha256: unknown },
  context: ReviewedImportContext,
) => {
  const proof = parse(record.payload, context);
  if (record.sha256 !== fingerprint(proof)) return refuse();
  return proof;
};
