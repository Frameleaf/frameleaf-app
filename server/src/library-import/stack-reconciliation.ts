import { createHash } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { importsLocked, parseImportManifest, storedVisibility } from 'src/library-import/manifest.js';
import {
  LibraryImportBinding,
  LibraryImportJournal,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mismatch = (): never => {
  throw new LibraryImportRefused('STACK_RECONCILIATION_MISMATCH');
};

/** Stack evidence only; original bytes, account credentials, album permissions and activation remain separate checks. */
export async function reconcileImportedStacks(
  db: ImportDatabase,
  context: { binding: LibraryImportBinding; manifest: unknown; plan: unknown; destinationId: string },
) {
  const binding = parseLibraryImportBinding(context.binding);
  const plan = bindDestinationImportPlan(context.plan, binding, context.manifest, context.destinationId);
  const manifest = parseImportManifest(context.manifest);
  const source = 'stacks' in manifest ? manifest.stacks : [];
  const sourceAssets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  try {
    return await db.transaction(async (tx) => {
      await beginLibraryImportReadback(tx);
      const { run } = await new LibraryImportJournal(tx).status();
      if (!run || JSON.stringify(run.binding) !== JSON.stringify(binding))
        throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
      if (run.status !== 'verifying') throw new LibraryImportRefused('IMPORT_NOT_VERIFYING');
      const mappings = await tx.query(
        `SELECT entity_kind,source_id,destination_id::text,record_sha256 FROM public.frameleaf_library_import_mapping WHERE operation_id=$1::uuid`,
        [binding.operationId],
      );
      const owners = new Map(
        mappings.filter((row) => row.entity_kind === 'owner').map((row) => [row.source_id, row.destination_id]),
      );
      if (plan.owners.some((owner) => owners.get(owner.sourceId) !== owner.destinationId.toLowerCase())) mismatch();
      const assets = new Map(
        mappings.filter((row) => row.entity_kind === 'asset').map((row) => [row.source_id, row.destination_id]),
      );
      const rows = mappings.filter((row) => row.entity_kind === 'stack');
      const stacks = new Map(rows.map((row) => [row.source_id, row]));
      if (rows.length !== source.length || stacks.size !== rows.length) mismatch();
      const expected = source
        .map((stack) => {
          const mapping = stacks.get(stack.id),
            ownerId = owners.get(stack.ownerId);
          if (
            !mapping ||
            typeof mapping.destination_id !== 'string' ||
            mapping.record_sha256 !== fingerprint(stack) ||
            typeof ownerId !== 'string'
          )
            return mismatch();
          const assetIds = stack.assetIds
            .map((id) => {
              const destination = assets.get(id);
              if (typeof destination !== 'string') return mismatch();
              return destination;
            })
            .sort();
          const primaryAssetId = assets.get(stack.primaryAssetId);
          if (typeof primaryAssetId !== 'string') return mismatch();
          const primary = sourceAssets.get(stack.primaryAssetId)!;
          return {
            id: mapping.destination_id,
            ownerId,
            primaryAssetId,
            assetIds,
            visibility: storedVisibility(primary),
            status: primary.visibility === 'trash' ? 'trashed' : 'active',
            ownerEligible: true,
            membersOwned: true,
            coherentState: true,
            unlocked: !importsLocked(primary),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const actual = await tx.query(`SELECT s.id::text,s."ownerId"::text,s."primaryAssetId"::text,
        ARRAY(SELECT a.id::text FROM public.asset a WHERE a."stackId"=s.id ORDER BY a.id) AS "assetIds",
        p.visibility,p.status,
        (u.status='active' AND u."deletedAt" IS NULL AND NOT u."isAdmin") AS "ownerEligible",
        NOT EXISTS(SELECT 1 FROM public.asset a WHERE a."stackId"=s.id AND a."ownerId"<>s."ownerId") AS "membersOwned",
        NOT EXISTS(SELECT 1 FROM public.asset a WHERE a."stackId"=s.id AND (a.visibility<>p.visibility OR a.status<>p.status)) AS "coherentState",
        NOT EXISTS(SELECT 1 FROM public.asset a JOIN public.asset_lock l ON l."assetId"=a.id WHERE a."stackId"=s.id) AS unlocked
        FROM public.stack s LEFT JOIN public."user" u ON u.id=s."ownerId"
        LEFT JOIN public.asset p ON p.id=s."primaryAssetId" ORDER BY s.id`);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatch();
      return {
        format: 'frameleaf-stack-reconciliation' as const,
        version: 1 as const,
        operationId: binding.operationId,
        manifestSha256: binding.manifestSha256,
        planSha256: binding.planSha256,
        stacks: actual.length,
        memberships: expected.reduce((count, stack) => count + stack.assetIds.length, 0),
        sha256: fingerprint(actual),
      };
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    throw new LibraryImportRefused('STACK_RECONCILIATION_FAILED');
  }
}
