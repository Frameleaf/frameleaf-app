import { type Kysely, sql } from 'kysely';
import { readLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { parseImportManifest } from 'src/library-import/manifest.js';
import { restorePrivateOwnerInputs } from 'src/library-import/private-owners.js';
import { parseLibraryImportBinding } from 'src/library-import/state.js';
import { type DB } from 'src/schema/index.js';

type Row = {
  status: unknown;
  binding: unknown;
  reviewed_manifest: unknown;
  reviewed_plan: unknown;
  private_owners: unknown;
  private_owners_sha256: unknown;
  activation: unknown;
  activation_sha256: unknown;
  sourceId: string | null;
  recordSha256: string | null;
};

/** Caller holds the pending account lock; generic imports require intact, activated claim authority. */
export async function canRedeemImportedAccountClaim(db: Kysely<DB>, userId: string): Promise<boolean> {
  try {
    const user = await db.selectFrom('user').select('importOperationId').where('id', '=', userId).executeTakeFirst();
    if (!user) return false;
    const { rows } = await sql<Row>`SELECT i.status,i.binding,i.reviewed_manifest,i.reviewed_plan,
      i.private_owners,i.private_owners_sha256,i.activation,i.activation_sha256,
      m.source_id AS "sourceId",m.record_sha256 AS "recordSha256"
      FROM public.frameleaf_library_import i LEFT JOIN public.frameleaf_library_import_mapping m
        ON m.operation_id=i.operation_id AND m.entity_kind='owner' AND m.destination_id=${userId}::uuid`.execute(db);
    // Preserve existing claims that do not belong to the generic migration protocol.
    if (rows.length === 0) return user.importOperationId === null;
    if (rows.length !== 1 || rows[0].status !== 'activated' || !rows[0].sourceId) return false;
    const row = rows[0];
    const binding = parseLibraryImportBinding(row.binding);
    if (user.importOperationId !== binding.operationId) return false;
    const manifest = parseImportManifest(row.reviewed_manifest);
    const plan = parseDestinationImportPlan(row.reviewed_plan);
    const context = { binding, manifest, plan, destinationId: plan.destinationId };
    const proof = readLibraryImportActivation({ payload: row.activation, sha256: row.activation_sha256 }, context);
    const retained = restorePrivateOwnerInputs(row, context);
    if (proof.report.owners.owners !== retained.owners.length) return false;
    const mapped = retained.owners.find(({ owner }) => owner.destinationUserId === userId);
    return (
      !!mapped &&
      mapped.owner.sourceUserId === row.sourceId &&
      mapped.recordSha256 === row.recordSha256 &&
      mapped.intent.disposition.kind === 'claim'
    );
  } catch {
    // Recovery/parser/driver errors may contain source metadata or private verifiers.
    return false;
  }
}
