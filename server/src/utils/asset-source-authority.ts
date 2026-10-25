import { type Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import z from 'zod';
import type { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/object.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';

export const assetSourceSnapshotSchema = z.strictObject({
  assetId: z.uuid(),
  ownerId: z.uuid(),
  derivatives: z.boolean(),
  checksum: z.string().regex(/^(?:[a-f0-9]{2}){1,64}$/),
  revision: z.record(z.string(), z.json()),
});
export type AssetSourceSnapshot = z.infer<typeof assetSourceSnapshotSchema>;

export const assetSourceFingerprint = (source: AssetSourceSnapshot): string =>
  createHash('sha256').update('frameleaf-asset-source/v1:').update(canonicalJson(source)).digest('hex');

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
        'visibility', a.visibility, 'deletedAt', a."deletedAt", 'isOffline', a."isOffline",
        'lock', (select to_jsonb(l) from asset_lock l where l."assetId" = a.id),
        'files', (select jsonb_agg(jsonb_build_array(f.id, f.path, f.type, f."isEdited") order by f.id)
          from asset_file f where f."assetId" = a.id and ${derivatives}::boolean),
        'edits', (select jsonb_agg((jsonb_build_array(e.sequence, e.action, e.parameters) || CASE WHEN e."sourceReference" IS NOT NULL THEN jsonb_build_array(e."sourceReference") ELSE '[]'::jsonb END) order by e.sequence, e.id)
          from asset_edit e where e."assetId" = a.id and ${derivatives}::boolean))
      || CASE WHEN a."originalPath" ILIKE 'frameleaf-source:%' THEN jsonb_build_object('sourceOriginal',
        (SELECT jsonb_build_object('resourceId', r.id, 'resourceKey', r."resourceKey", 'version', r.version,
          'sha256', encode(r.checksum, 'hex'), 'bytes', r.bytes::text, 'state', r.state, 'verifiedAt', r."verifiedAt",
          'runId', run.id, 'sourceId', run."sourceId", 'scopeFingerprint', b."scopeFingerprint",
          'authorizationEpoch', b."authorizationEpoch")
        FROM source_original b JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=a.id
        JOIN photo_source_run run ON run.id=r."runId" WHERE b."assetId"=a.id))
      ELSE '{}'::jsonb END revision
      from asset a where a.id = ${assetId}::uuid`.execute(db);
  return row ? { ...row, assetId, derivatives } : undefined;
}

export async function assertAssetSource(db: Kysely<DB>, source: AssetSourceSnapshot): Promise<void> {
  const path = source.revision.originalPath;
  const identity = typeof path === 'string' ? parseSourceOriginalPath(path) : undefined;
  if (identity) {
    if (!(await lockSourceAuthorities(db, [{ sourceId: identity.sourceId, ownerId: source.ownerId }])))
      throw new Error('Asset inputs changed before publication');
    // Keep the compared binding and resource stable through the caller's DB-only publication.
    await sql`SELECT b."assetId" FROM source_original b
      JOIN photo_source_resource r ON r.id=b."resourceId"
      JOIN photo_source_run run ON run.id=r."runId"
      WHERE b."assetId"=${source.assetId}::uuid FOR SHARE OF b,r,run`.execute(db);
  }
  const current = await readAssetSource(db, source.assetId, source.derivatives);
  if (!current || canonicalJson(current) !== canonicalJson(source))
    throw new Error('Asset inputs changed before publication');
}
