import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('treats any file Frameleaf still references as tracked, not only asset originals', async () => {
  const db = await getKyselyDB('media_health_tracked_paths');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const original = `/data/upload/${user.id}/aa/bb/original.jpg`;
    const output = `/data/upload/${user.id}/cc/dd/export.mp4`;
    const orphan = `/data/upload/${user.id}/ee/ff/orphan.jpg`;
    await ctx.newAsset({ ownerId: user.id, originalPath: original });
    // Stands in for any Frameleaf-owned output (Studio export, develop master…) kept in library storage.
    await sql`UPDATE "user" SET "profileImagePath"=${output} WHERE id=${user.id}::uuid`.execute(db);

    const tracked = await new MediaHealthRepository(db).getTrackedPaths([original, output, orphan]);

    expect([...tracked].sort()).toEqual([original, output].sort());
  } finally {
    await db.destroy();
  }
});

it('restores a lost original under the same photo, resolving its missing finding', async () => {
  const db = await getKyselyDB('media_health_restore_lost_original');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const bytes = Buffer.from('the original photo');
    const sha1 = createHash('sha1').update(bytes).digest();
    const sha256 = createHash('sha256').update(bytes).digest();
    const lostPath = `/data/upload/${user.id}/aa/bb/IMG_0420.jpg`;
    const restoredPath = `/data/upload/${user.id}/cc/dd/upload.jpg`;
    // An Immich-imported photo: SHA-1 checksum and no physical file row.
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: lostPath,
      checksum: sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    await sql`INSERT INTO asset_health ("assetId", category, status, severity, "originalPath", "originalFileName", evidence, resolution, "checkedAt")
      VALUES (${asset.id}::uuid, 'missing', 'missing', 'critical', ${lostPath}, 'IMG_0420.jpg', '{}', '{}', now())`.execute(
      db,
    );
    const sut = new PhysicalFileRepository(db);
    const input = {
      assetId: asset.id,
      expectedOriginalPath: lostPath,
      originalPath: restoredPath,
      sha1,
      sha256,
      sizeInBytes: bytes.length,
      reason: 'restored_by_upload' as const,
    };

    await expect(sut.restoreLostOriginal({ ...input, sha1: Buffer.alloc(20), sha256: Buffer.alloc(32) })).resolves.toBe(
      false,
    );
    await expect(sut.restoreLostOriginal(input)).resolves.toBe(true);

    const restored = await db
      .selectFrom('asset')
      .innerJoin('physical_file', 'physical_file.id', 'asset.physicalOriginalFileId')
      .select(['asset.id', 'asset.originalPath', 'physical_file.path', 'physical_file.canonicalAssetId'])
      .where('asset.id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(restored).toEqual({
      id: asset.id,
      originalPath: restoredPath,
      path: restoredPath,
      canonicalAssetId: asset.id,
    });
    const finding = await db
      .selectFrom('asset_health')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(finding).toMatchObject({
      status: 'relinked',
      originalPath: restoredPath,
      evidence: { reason: 'restored_by_upload', previousPath: lostPath },
    });
    expect(finding.resolvedAt).not.toBeNull();
    // The path changed, so a second restore of the same lost path is refused.
    await expect(sut.restoreLostOriginal(input)).resolves.toBe(false);
  } finally {
    await db.destroy();
  }
});
