import { BadRequestException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { AssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import type { DB } from 'src/schema/index.js';
import type { SourceReference } from 'src/utils/source-reference.js';
import { AssetStatus, AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { type DevelopSourceBinding, developSourceBindingSchema } from 'src/utils/develop-source-binding.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';

/** Identity only; original bytes still require a separately authorized source lease. */
export async function captureDevelopSourceBinding(
  db: Kysely<DB>,
  assetId: string,
  ownerId: string,
  recipe: AssetDevelopRecipe,
  retainManaged = false,
  exclusive = false,
): Promise<DevelopSourceBinding | null> {
  const parent = await db
    .selectFrom('asset')
    .select(['id', 'ownerId', 'livePhotoVideoId', 'originalPath'])
    .where('id', '=', assetId)
    .where('ownerId', '=', ownerId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!parent) throw new BadRequestException('Develop source is unavailable');
  let motion = recipe.version === 1 && !!(recipe as { keyFrame?: unknown }).keyFrame;
  let inputId = motion ? parent.livePhotoVideoId : assetId;
  if (motion) {
    const input = inputId
      ? await db
          .selectFrom('asset')
          .select(['id', 'type', 'originalPath'])
          .where('id', '=', inputId)
          .where('ownerId', '=', ownerId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (!input || input.type !== AssetType.Video) {
      if (
        retainManaged ||
        parseSourceOriginalPath(parent.originalPath) ||
        (input && parseSourceOriginalPath(input.originalPath))
      )
        throw new BadRequestException('Develop motion source is unavailable');
      // Legacy managed drafts retain their existing opaque-recipe semantics.
      inputId = assetId;
      motion = false;
    }
  }
  if (!inputId) throw new BadRequestException('Develop motion source is unavailable');
  const ids = [...new Set([assetId, inputId])].sort();
  const observed = await db.selectFrom('asset').select(['id', 'originalPath']).where('id', 'in', ids).execute();
  const authorities = observed.flatMap((asset) => {
    const identity = parseSourceOriginalPath(asset.originalPath);
    return identity ? [{ sourceId: identity.sourceId, ownerId }] : [];
  });
  if (!(await lockSourceAuthorities(db, authorities)))
    throw new BadRequestException('Develop source authority changed');
  // Source parents and resource fences precede asset locks, matching source revocation.
  for (const asset of observed) {
    if (!parseSourceOriginalPath(asset.originalPath)) continue;
    await sql`SELECT b."assetId" FROM source_original b JOIN photo_source_resource r ON r.id=b."resourceId"
      JOIN photo_source_run run ON run.id=r."runId" JOIN asset a ON a.id=b."assetId"
      JOIN library l ON l.id=a."libraryId" WHERE b."assetId"=${asset.id}::uuid FOR SHARE OF b,r,run,l`.execute(db);
  }
  const assets = new Map<
    string,
    { id: string; originalPath: string; checksum: Buffer; type: AssetType; livePhotoVideoId: string | null }
  >();
  for (const id of ids) {
    const query = db
      .selectFrom('asset')
      .select(['id', 'originalPath', 'checksum', 'type', 'livePhotoVideoId'])
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is', null);
    const asset = await (exclusive ? query.forUpdate() : query.forShare()).executeTakeFirst();
    if (!asset || (motion && id === inputId && asset.type !== AssetType.Video))
      throw new BadRequestException('Develop source is unavailable');
    const before = observed.find((row) => row.id === id);
    if (
      !before ||
      ((parseSourceOriginalPath(before.originalPath) || parseSourceOriginalPath(asset.originalPath)) &&
        before.originalPath !== asset.originalPath)
    )
      throw new BadRequestException('Develop source resource changed');
    assets.set(id, asset);
  }
  if (motion && assets.get(assetId)?.livePhotoVideoId !== inputId)
    throw new BadRequestException('Develop motion source changed');
  const snapshots = new Map<
    string,
    { assetId: string; path: string; checksum: string; reference: SourceReference | null }
  >();
  for (const [id, asset] of assets) {
    const reference = !!parseSourceOriginalPath(asset.originalPath);
    let resource: SourceReference | null = null;
    if (reference) {
      const { rows } =
        await sql<SourceReference>`SELECT r.id AS "resourceId", r.version, encode(r.checksum,'hex') AS sha256
        FROM asset a JOIN source_original b ON b."assetId"=a.id
        JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=a.id
        JOIN photo_source_run run ON run.id=r."runId" JOIN photo_source s ON s.id=run."sourceId"
        JOIN library l ON l.id=a."libraryId" AND l."ownerId"=s."ownerId"
        JOIN desktop_device d ON d.id=s."deviceId" AND d."userId"=s."ownerId"
        JOIN session photo ON photo.id=s."photoSessionId" AND photo."userId"=s."ownerId"
        JOIN "user" owner ON owner.id=s."ownerId"
        WHERE a.id=${id}::uuid AND a."ownerId"=${ownerId}::uuid AND a."originalPath"=${asset.originalPath}
          AND a."ownerId"=s."ownerId" AND a."isExternal" AND a.status=${AssetStatus.Active} AND a."deletedAt" IS NULL
          AND a."checksumAlgorithm"=${ChecksumAlgorithm.sha1Path} AND l."readOnly" AND l."deletedAt" IS NULL
          AND r.state='verified' AND r."verifiedAt" IS NOT NULL AND s.mode='reference' AND s."revokedAt" IS NULL
          AND owner."deletedAt" IS NULL AND b."scopeFingerprint"=s."scopeFingerprint"
          AND b."authorizationEpoch"=d."authorizationEpoch" AND d."revokedAt" IS NULL AND d.state NOT IN ('paused','revoked')
          AND (photo."expiresAt" IS NULL OR photo."expiresAt">clock_timestamp())
          AND a."originalPath"='frameleaf-source://' || s.id::text || '/' || r."resourceKey"`.execute(db);
      resource = rows[0] ?? null;
      if (!resource) throw new BadRequestException('Develop source resource is unavailable');
    }
    snapshots.set(id, {
      assetId: id,
      path: asset.originalPath,
      checksum: asset.checksum.toString('hex'),
      reference: resource,
    });
  }
  const parentSnapshot = snapshots.get(assetId)!;
  const input = snapshots.get(inputId)!;
  if (!retainManaged && !parentSnapshot.reference && !input.reference) return null;
  return developSourceBindingSchema.parse({ kind: 'bound', parent: parentSnapshot, input });
}
