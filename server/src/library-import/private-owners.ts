import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { parseImportedOwnerIntent, prepareImportedOwners } from 'src/library-import/owner-reconciliation.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import {
  ReviewedImportContext,
  readRetainedImportInputs,
  withImportInputRun,
} from 'src/library-import/reviewed-inputs.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const archiveSchema = z.strictObject({
  format: z.literal('frameleaf-private-owner-inputs'),
  version: z.literal(1),
  owners: z.array(z.strictObject({ intent: z.unknown(), credential: z.string().max(8192).optional() })),
});
type PrivateContext = ReviewedImportContext & Awaited<ReturnType<typeof readRetainedImportInputs>>;
type PrivateRow = { private_owners: unknown; private_owners_sha256: unknown };
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const preparePrivateOwnerInputs = (context: PrivateContext, inventory: unknown) => {
  const owners = prepareImportedOwners(context, inventory).sort(({ owner: a }, { owner: b }) =>
    a.sourceUserId < b.sourceUserId ? -1 : a.sourceUserId > b.sourceUserId ? 1 : 0,
  );
  if (new Set(owners.map((entry) => entry.owner.email)).size !== owners.length) return refuse('OWNER_EMAIL_COLLISION');
  const archive = {
    format: 'frameleaf-private-owner-inputs' as const,
    version: 1 as const,
    owners: owners.map(({ intent, credential }) => ({
      intent,
      ...(credential ? { credential: credential.forImport() } : {}),
    })),
  };
  return { owners, archive, sha256: checksum(archive) };
};
const readPrivateRow = async (tx: ImportDatabase): Promise<PrivateRow> => {
  const [row] = await tx.query('SELECT private_owners,private_owners_sha256 FROM public.frameleaf_library_import');
  if (!row) return refuse('IMPORT_JOURNAL_MISSING');
  return row as PrivateRow;
};
/** Validates and canonicalizes private file content; retained records separately require their stored checksum. */
export const parsePrivateOwnerInputs = (input: unknown, context: PrivateContext) => {
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return refuse('IMPORT_PRIVATE_OWNERS_INVALID');
  const owners = new Map(context.plan.owners.map((owner) => [owner.sourceId, owner.destinationId]));
  const inventory = parsed.data.owners.map((entry) => {
    const intent = parseImportedOwnerIntent(entry.intent);
    const owner = owners.get(intent.sourceUserId);
    if (!owner) return refuse('OWNER_SOURCE_MISSING');
    let credential: ImportedPassword | undefined;
    if (entry.credential !== undefined) {
      try {
        credential = ImportedPassword.fromRetained(
          {
            operationId: context.binding.operationId,
            sourceUserId: intent.sourceUserId,
            destinationUserId: owner,
          },
          entry.credential,
        );
      } catch {
        return refuse('IMPORT_PRIVATE_OWNERS_INVALID');
      }
    }
    return { intent, credential };
  });
  const prepared = preparePrivateOwnerInputs(context, inventory);
  return { owners: prepared.owners, sha256: prepared.sha256 };
};

export const restorePrivateOwnerInputs = (row: PrivateRow, context: PrivateContext) => {
  if (row.private_owners === null && row.private_owners_sha256 === null) return refuse('IMPORT_PRIVATE_OWNERS_MISSING');
  if (typeof row.private_owners_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.private_owners_sha256))
    return refuse('IMPORT_PRIVATE_OWNERS_INVALID');
  const prepared = parsePrivateOwnerInputs(row.private_owners, context);
  if (!timingSafeEqual(Buffer.from(prepared.sha256, 'hex'), Buffer.from(row.private_owners_sha256, 'hex')))
    return refuse('IMPORT_PRIVATE_OWNERS_CHANGED');
  return prepared;
};

/** Retains protected destination-policy verifiers, never raw source verifiers, sessions or API keys. */
export async function retainPrivateOwnerInputs(
  db: ImportDatabase,
  context: ReviewedImportContext,
  inventory: unknown,
): Promise<void> {
  return withImportInputRun(db, context, true, async (tx, bound) => {
    const reviewed = { ...bound, ...(await readRetainedImportInputs(tx, bound)) };
    const prepared = preparePrivateOwnerInputs(reviewed, inventory);
    const row = await readPrivateRow(tx);
    if (row.private_owners !== null || row.private_owners_sha256 !== null) {
      if (restorePrivateOwnerInputs(row, reviewed).sha256 !== prepared.sha256)
        return refuse('IMPORT_PRIVATE_OWNERS_CHANGED');
      return;
    }
    await tx.query(
      `UPDATE public.frameleaf_library_import SET private_owners=$1::text::jsonb,
      private_owners_sha256=$2,updated_at=now() WHERE operation_id=$3::uuid`,
      [JSON.stringify(prepared.archive), prepared.sha256, bound.binding.operationId],
    );
  });
}

/** Private recovery inventory only; serializing recovered capabilities continues to redact their verifier. */
export async function loadPrivateOwnerInputs(db: ImportDatabase, context: ReviewedImportContext) {
  return withImportInputRun(db, context, false, async (tx, bound) => {
    const reviewed = { ...bound, ...(await readRetainedImportInputs(tx, bound)) };
    return restorePrivateOwnerInputs(await readPrivateRow(tx), reviewed).owners.map(({ intent, credential }) => ({
      intent,
      credential,
    }));
  });
}
