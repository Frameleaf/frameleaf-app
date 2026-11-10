import { type Kysely, sql } from 'kysely';
import z from 'zod';
import type { DB } from 'src/schema/index.js';
import { AssetFileType } from 'src/enum.js';
import { canonicalJson } from 'src/utils/object.js';

export const assetSourceSnapshotSchema = z.strictObject({
  assetId: z.uuid(),
  ownerId: z.uuid(),
  derivatives: z.boolean(),
  checksum: z.string().regex(/^(?:[a-f0-9]{2}){1,64}$/),
  revision: z.record(z.string(), z.json()),
});
export type AssetSourceSnapshot = z.infer<typeof assetSourceSnapshotSchema>;

/**
 * The asset's inputs a job reads, captured when it starts and compared again before it publishes.
 * The XMP sidecar is left out: no guarded job reads it, and it is rewritten whenever someone edits a
 * description, rating or the people in a photo (FL-927), which would otherwise refuse an edit's render.
 */
export async function readAssetSource(
  db: Kysely<DB>,
  assetId: string,
  derivatives: boolean,
): Promise<AssetSourceSnapshot | undefined> {
  const {
    rows: [row],
  } = await sql<Pick<AssetSourceSnapshot, 'checksum' | 'ownerId' | 'revision'>>`
    select encode(a.checksum, 'hex') checksum, a."ownerId",
      jsonb_build_object('originalPath', a."originalPath", 'modifiedAt', a."fileModifiedAt", 'ownerId', a."ownerId",
        'visibility', a.visibility, 'deletedAt', a."deletedAt",
        'lock', (select to_jsonb(l) from asset_lock l where l."assetId" = a.id),
        'files', (select jsonb_agg(jsonb_build_array(f.id, f.path, f.type, f."isEdited") order by f.id)
          from asset_file f where f."assetId" = a.id and f.type <> ${AssetFileType.Sidecar} and ${derivatives}::boolean),
        'edits', (select jsonb_agg(jsonb_build_array(e.sequence, e.action, e.parameters) order by e.sequence, e.id)
          from asset_edit e where e."assetId" = a.id and ${derivatives}::boolean)) revision
      from asset a where a.id = ${assetId}::uuid`.execute(db);
  return row ? { ...row, assetId, derivatives } : undefined;
}

export async function assertAssetSource(db: Kysely<DB>, source: AssetSourceSnapshot): Promise<void> {
  const current = await readAssetSource(db, source.assetId, source.derivatives);
  if (!current || canonicalJson(current) !== canonicalJson(source))
    throw new Error('Asset inputs changed before publication');
}
