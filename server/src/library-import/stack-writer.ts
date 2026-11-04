import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { ImportManifest, parseImportManifest, storedVisibility } from 'src/library-import/manifest.js';
import { LibraryImportBinding, LibraryImportJournal, LibraryImportRefused } from 'src/library-import/state.js';

type Stack = Extract<ImportManifest, { version: 4 }>['stacks'][number];

/** Source stacks require independently qualified ownership and equivalent access before this internal write. */
export class CanonicalStackWriter {
  private readonly binding: LibraryImportBinding;
  private readonly stacks: Map<string, Stack>;
  private readonly assets: Map<string, ImportManifest['assets'][number]>;
  private readonly owners: Map<string, string>;
  constructor(
    private readonly db: ImportDatabase,
    context: { binding: LibraryImportBinding; manifest: unknown; plan: unknown; destinationId: string },
  ) {
    this.binding = structuredClone(context.binding);
    const plan = bindDestinationImportPlan(context.plan, this.binding, context.manifest, context.destinationId);
    const manifest = parseImportManifest(context.manifest);
    this.stacks = new Map(('stacks' in manifest ? manifest.stacks : []).map((stack) => [stack.id, stack]));
    this.assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    this.owners = new Map(plan.owners.map((owner) => [owner.sourceId, owner.destinationId.toLowerCase()]));
  }

  async write(sourceStackId: unknown): Promise<string> {
    const parsed = z.string().min(1).max(1024).safeParse(sourceStackId);
    if (!parsed.success) throw new LibraryImportRefused('STACK_SOURCE_INVALID');
    const stack = this.stacks.get(parsed.data);
    if (!stack) throw new LibraryImportRefused('STACK_SOURCE_MISSING');
    const ownerId = this.owners.get(stack.ownerId)!;
    const recordSha256 = createHash('sha256').update(JSON.stringify(stack)).digest('hex');
    try {
      return await new LibraryImportJournal(this.db).create(
        this.binding,
        { kind: 'stack', sourceId: stack.id, recordSha256 },
        async (tx, destinationId) => {
          const owners = await tx.query(
            `SELECT u.id FROM public.frameleaf_library_import_mapping m JOIN public."user" u ON u.id=m.destination_id
            WHERE m.operation_id=$1::uuid AND m.entity_kind='owner' AND m.source_id=$2 AND u.id=$3::uuid
            AND u.status='active' AND u."deletedAt" IS NULL AND NOT u."isAdmin" FOR SHARE OF u`,
            [this.binding.operationId, stack.ownerId, ownerId],
          );
          if (owners.length !== 1) throw new LibraryImportRefused('STACK_OWNER_MAPPING_REQUIRED');
          const assets = await tx.query(
            `SELECT m.source_id,a.id::text,a."ownerId"::text,a.visibility,a.status,
            EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked
            FROM public.frameleaf_library_import_mapping m JOIN public.asset a ON a.id=m.destination_id
            WHERE m.operation_id=$1::uuid AND m.entity_kind='asset' AND m.source_id=ANY($2::text[])
            AND a."stackId" IS NULL ORDER BY a.id FOR UPDATE OF a`,
            [this.binding.operationId, stack.assetIds],
          );
          if (
            assets.length !== stack.assetIds.length ||
            new Set(assets.map((asset) => asset.id)).size !== assets.length ||
            assets.some((asset) => {
              const source = this.assets.get(String(asset.source_id))!;
              const locked = source.visibility === 'locked';
              return (
                asset.ownerId !== ownerId ||
                asset.visibility !== storedVisibility(source) ||
                asset.locked !== locked ||
                asset.status !== (source.visibility === 'trash' ? 'trashed' : 'active')
              );
            })
          )
            throw new LibraryImportRefused('STACK_ASSETS_INCOMPLETE');
          const primary = assets.find((asset) => asset.source_id === stack.primaryAssetId)!;
          await tx.query('INSERT INTO public.stack(id,"ownerId","primaryAssetId") VALUES($1::uuid,$2::uuid,$3::uuid)', [
            destinationId,
            ownerId,
            primary.id,
          ]);
          const updated = await tx.query(
            `UPDATE public.asset SET "stackId"=$1::uuid WHERE id=ANY($2::uuid[]) AND "ownerId"=$3::uuid
            AND "stackId" IS NULL RETURNING id`,
            [destinationId, assets.map((asset) => asset.id), ownerId],
          );
          if (updated.length !== assets.length) throw new LibraryImportRefused('STACK_ASSETS_INCOMPLETE');
        },
      );
    } catch (error) {
      if (error instanceof LibraryImportRefused) throw error;
      throw new LibraryImportRefused('STACK_WRITE_FAILED');
    }
  }
}
