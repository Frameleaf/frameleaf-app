import { type Transaction, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyReferenceOriginal } from 'src/utils/buddy-reference-originals.js';
import { AssetStatus, ChecksumAlgorithm, PhysicalFileType } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { countPathReferences, lockChecksum, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { BUDDY_ID, BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';
import { sourceReferenceSchema } from 'src/utils/source-reference.js';

export type BuddyReferenceAdoption = {
  assetId: string;
  ownerId: string;
  type: string;
  source: BuddyReferenceOriginal;
  file: { path: string; sha256: string; size: number };
  physicalFileId: string;
};

/** The caller owns authorization and file lifetime; an intent alone never proves a committed adoption. */
export async function adoptBuddyReferenceOriginal(
  trx: Transaction<DB>,
  intent: BuddyReferenceAdoption,
  verify: () => Promise<void>,
) {
  const { assetId, ownerId, file, source, physicalFileId } = intent;
  if (
    !trx.isTransaction ||
    !BUDDY_UUID.test(assetId) ||
    !BUDDY_UUID.test(ownerId) ||
    !BUDDY_UUID.test(physicalFileId) ||
    !BUDDY_ID.test(file.sha256) ||
    !Number.isSafeInteger(file.size) ||
    // eslint-disable-next-line unicorn/no-impossible-length-comparison -- Archive byte counts may be negative.
    file.size < 0 ||
    !isAbsolute(file.path) ||
    normalize(file.path) !== file.path ||
    file.path.includes('\0') ||
    source.version !== 1 ||
    source.sourceEpoch.assetId !== assetId ||
    source.sourceEpoch.ownerId !== ownerId ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(source.sourceEpoch.epoch) ||
    BigInt(source.sourceEpoch.epoch) > 9_223_372_036_854_775_807n ||
    !sourceReferenceSchema.safeParse(source.sourceEpoch.reference).success
  )
    throw new Error('Reference recovery adoption identity is invalid');
  const reference = parseSourceOriginalPath(source.sourcePath);
  if (!reference) throw new Error('Reference recovery source provenance changed');
  const checksum = Buffer.from(file.sha256, 'hex');
  await lockChecksum(trx, checksum);
  const hint = await trx
    .selectFrom('asset')
    .select(['originalPath', 'ownerId'])
    .where('id', '=', assetId)
    .executeTakeFirstOrThrow();
  if (hint.ownerId !== ownerId) throw new Error('Reference recovery asset identity changed');
  let sourceVerified = false;
  if (hint.originalPath === source.sourcePath) {
    const proof = await sql`SELECT b."assetId" FROM source_original b
      JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=b."assetId"
      JOIN photo_source_run run ON run.id=r."runId" JOIN photo_source s ON s.id=run."sourceId"
      WHERE b."assetId"=${assetId}::uuid AND r.id=${source.sourceEpoch.reference.resourceId}::uuid
        AND r.version=${source.sourceEpoch.reference.version} AND r.checksum=${Buffer.from(source.sourceEpoch.reference.sha256, 'hex')}
        AND (r.checksum<>${checksum} OR r.bytes=${file.size}) AND r.state='verified' AND r."verifiedAt" IS NOT NULL
        AND s.id=${reference.sourceId}::uuid AND r."resourceKey"=${reference.resourceKey}
        AND s."ownerId"=${ownerId}::uuid AND s.mode='reference' AND b."scopeFingerprint"=s."scopeFingerprint"
      FOR SHARE OF b,r,run,s NOWAIT`.execute(trx);
    if (proof.rows.length !== 1) throw new Error('Reference recovery source provenance changed');
    sourceVerified = true;
  }
  const asset = await trx
    .selectFrom('asset')
    .selectAll()
    .where('id', '=', assetId)
    .forUpdate()
    .noWait()
    .executeTakeFirstOrThrow();
  const [epoch] = await AssetLocalEffectRepository.lifecycleEpochs(trx, [assetId]);
  if (
    asset.ownerId !== ownerId ||
    asset.type !== intent.type ||
    ![AssetStatus.Active, AssetStatus.Trashed].includes(asset.status) ||
    epoch?.ownerId !== ownerId ||
    epoch.epoch !== source.sourceEpoch.epoch
  )
    throw new Error('Reference recovery asset identity changed');
  const managed = asset.originalPath === file.path && !asset.isExternal && asset.libraryId === null;
  const original = await trx
    .selectFrom('source_original')
    .selectAll()
    .where('assetId', '=', assetId)
    .executeTakeFirst();
  if (managed) {
    if (
      original ||
      asset.isOffline ||
      asset.checksumAlgorithm !== ChecksumAlgorithm.sha256File ||
      !asset.checksum.equals(checksum)
    )
      throw new Error('Reference recovery managed identity changed');
  } else {
    if (
      !sourceVerified ||
      asset.originalPath !== source.sourcePath ||
      !asset.isExternal ||
      asset.physicalOriginalFileId ||
      asset.checksumAlgorithm !== ChecksumAlgorithm.sha1Path ||
      !asset.checksum.equals(createHash('sha1').update(source.sourcePath).digest())
    )
      throw new Error('Reference recovery source provenance changed');
    const conflict = await trx
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('libraryId', 'is', null)
      .where('checksum', '=', checksum)
      .where('id', '!=', assetId)
      .executeTakeFirst();
    if (conflict)
      throw new Error(
        'Reference recovery conflicts with an existing managed original; asset identities were preserved',
      );
  }
  await lockFilePath(trx, file.path);
  await verify();
  const physical = await trx
    .selectFrom('physical_file')
    .selectAll()
    .where('path', '=', file.path)
    .forUpdate()
    .noWait()
    .executeTakeFirst();
  const exif = await trx
    .selectFrom('asset_exif')
    .select('fileSizeInByte')
    .where('assetId', '=', assetId)
    .forUpdate()
    .noWait()
    .executeTakeFirst();
  if (managed) {
    if (
      !physical ||
      physical.id !== physicalFileId ||
      physical.id !== asset.physicalOriginalFileId ||
      physical.canonicalAssetId !== assetId ||
      physical.type !== PhysicalFileType.Original ||
      !physical.checksum.equals(checksum) ||
      Number(physical.sizeInBytes) !== file.size ||
      Number(exif?.fileSizeInByte) !== file.size
    )
      throw new Error('Reference recovery physical original changed');
    return 'verified' as const;
  }
  if (physical || (await countPathReferences(trx, file.path)))
    throw new Error('Reference recovery target is already referenced');
  await trx
    .insertInto('physical_file')
    .values({
      id: physicalFileId,
      path: file.path,
      type: PhysicalFileType.Original,
      checksum,
      sizeInBytes: file.size,
      canonicalAssetId: assetId,
    })
    .execute();
  await trx
    .updateTable('asset')
    .set({
      originalPath: file.path,
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      libraryId: null,
      isExternal: false,
      isOffline: false,
      physicalOriginalFileId: physicalFileId,
    })
    .where('id', '=', assetId)
    .execute();
  await trx
    .insertInto('asset_exif')
    .values({ assetId, fileSizeInByte: file.size })
    .onConflict((oc) => oc.column('assetId').doUpdateSet({ fileSizeInByte: file.size }))
    .execute();
  const delta = file.size - (asset.libraryId === null ? Number(exif?.fileSizeInByte ?? 0) : 0);
  await trx
    .updateTable('user')
    .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${delta}` })
    .where('id', '=', ownerId)
    .execute();
  await trx.deleteFrom('source_original').where('assetId', '=', assetId).execute();
  return 'adopted' as const;
}
