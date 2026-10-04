import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { AssetLockReason, AssetStatus, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { EMPTY_DETAILS } from 'src/utils/cloud-backup-details.js';
import { ownerBackupHistoryPage } from 'src/utils/cloud-backup-owner.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const checksum = (text: string) => createHash('sha256').update(text).digest();
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, repository: new CloudBackupIndexRepository(db) };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

describe('FL234 physical deletion capture and current owner history', () => {
  it('captures deletion in the canonical baseline and preserves the core audit trigger', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset: asset } = await ctx.newAsset({ ownerId: user.id });
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect(
      await db.selectFrom('asset_backup_deletion').selectAll().where('assetId', '=', asset.id).execute(),
    ).toHaveLength(1);
    expect(await db.selectFrom('asset_audit').selectAll().where('assetId', '=', asset.id).execute()).toHaveLength(1);
  });
  it('captures actual SHA identity and timestamp; survives audit pruning and refreshes only on actual redelete', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const value = checksum('original');
    const { asset: asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: value,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    const first = await db
      .selectFrom('asset_backup_deletion')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(first).toMatchObject({
      ownerId: user.id,
      checksum: value,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      evidenceVersion: 1,
      modernPrivacyEvidenceUnavailable: true,
      wasLocked: false,
    });
    await db.deleteFrom('asset_audit').where('assetId', '=', asset.id).execute();
    expect(
      await db.selectFrom('asset_backup_deletion').selectAll().where('assetId', '=', asset.id).executeTakeFirst(),
    ).toEqual(first);
    await ctx.newAsset({
      id: asset.id,
      ownerId: user.id,
      checksum: checksum('restored'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    expect(
      await db.selectFrom('asset_backup_deletion').selectAll().where('assetId', '=', asset.id).executeTakeFirst(),
    ).toEqual(first);
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    const latest = await db
      .selectFrom('asset_backup_deletion')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(latest.checksum).toEqual(checksum('restored'));
    expect(new Date(latest.deletedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.deletedAt).getTime());
  });
  for (const first of ['still', 'motion'] as const) {
    it(`retains Locked motion evidence for deterministic ${first}-first single-statement deletes`, async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
      await db
        .insertInto('asset_lock')
        .values({ assetId: still.id, reason: AssetLockReason.Marked, lockedBy: user.id })
        .execute();
      const a = first === 'still' ? still.id : motion.id,
        b = first === 'still' ? motion.id : still.id;
      await sql`WITH first_deleted AS (DELETE FROM asset WHERE id = ${a}::uuid RETURNING id)
        DELETE FROM asset WHERE id = ${b}::uuid AND EXISTS (SELECT 1 FROM first_deleted)`.execute(db);
      const captured = await db
        .selectFrom('asset_backup_deletion')
        .selectAll()
        .where('assetId', 'in', [still.id, motion.id])
        .execute();
      expect(captured).toHaveLength(2);
      expect(captured.every((row) => row.wasLocked)).toBe(true);
      expect(
        await db.selectFrom('asset_audit').selectAll().where('assetId', 'in', [still.id, motion.id]).execute(),
      ).toHaveLength(2);
    });
  }
  it('captures isolated motion while same-owner locked still remains, but not a foreign parent relationship', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser(),
      { user: foreign } = await ctx.newUser();
    for (const parentOwner of [user.id, foreign.id]) {
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      const { asset: still } = await ctx.newAsset({ ownerId: parentOwner, livePhotoVideoId: motion.id });
      await db
        .insertInto('asset_lock')
        .values({ assetId: still.id, reason: AssetLockReason.Marked, lockedBy: user.id })
        .execute();
      await db.deleteFrom('asset').where('id', '=', motion.id).execute();
      const captured = await db
        .selectFrom('asset_backup_deletion')
        .select('wasLocked')
        .where('assetId', '=', motion.id)
        .executeTakeFirstOrThrow();
      expect(captured.wasLocked).toBe(parentOwner === user.id);
    }
  });
  it('rejects foreign UUID reuse, modern-filter and checksum mismatch with real captured rows', async () => {
    const { ctx, repository } = setup();
    const { user } = await ctx.newUser(),
      { user: foreign } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset: asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: checksum('own'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const manifest = {
      version: 2,
      createdAt: '2026-09-01T00:00:00Z',
      assets: {
        [asset.id]: {
          owner: user.id,
          originalFileName: 'own.jpg',
          details: EMPTY_DETAILS,
          files: [{ role: 'original', sha256: checksum('own').toString('hex') }],
        },
      },
    } as CloudBackupManifest;
    const project = async () =>
      ownerBackupHistoryPage(auth, manifest, await repository.getOwnerHistoryState(auth, [asset.id]), {
        limit: 10,
        offset: 0,
      });
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await project()).total).toBe(1);
    expect(
      ownerBackupHistoryPage(
        { ...auth, hideNsfwAssets: true },
        manifest,
        await repository.getOwnerHistoryState(auth, [asset.id]),
        { limit: 10, offset: 0 },
      ).total,
    ).toBe(0);
    await ctx.newAsset({
      id: asset.id,
      ownerId: user.id,
      checksum: checksum('different'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await project()).total).toBe(0);
    await ctx.newAsset({ id: asset.id, ownerId: foreign.id, status: AssetStatus.Trashed });
    expect((await project()).total).toBe(0);
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await project()).total).toBe(0);
  });
});
