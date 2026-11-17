import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, integrity: new IntegrityRepository(db), backup: new CloudBackupIndexRepository(db) };
};

beforeAll(async () => {
  db = await getKyselyDB();
});

describe('FL-226 persisted proof prerequisites', () => {
  it('installs feature tables in the real canonical baseline', async () => {
    await expectCanonicalTables(db, ['asset_integrity_verification', 'cloud_backup_manifest_original']);
  });

  it('timestamps repeated checks and records failures without replacing the immutable baseline', async () => {
    const { ctx, integrity } = setup();
    const { user } = await ctx.newUser();
    const checksum = Buffer.from(sha('original'), 'hex');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: '/original',
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const baseline = {
      assetId: asset.id,
      sha1: createHash('sha1').update('original').digest(),
      sha256: checksum,
      sizeInBytes: 8,
      path: '/original',
      source: 'upload' as const,
    };
    const fork = ctx.get(AssetChecksumRepository);
    await fork.recordAssetChecksums(baseline);
    const readBaseline = async () =>
      (await sql`SELECT * FROM public.asset_checksum WHERE "assetId" = ${asset.id}::uuid`.execute(db)).rows;
    const original = await readBaseline();
    const proof = {
      assetId: asset.id,
      originalPath: '/original',
      expectedChecksum: checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      actualSha256: checksum.toString('hex'),
      result: 'passed' as const,
    };
    expect(await integrity.recordVerification(proof)).toBe(true);
    await db
      .updateTable('asset_integrity_verification')
      .set({ checkedAt: new Date('2000-01-01T00:00:00Z') })
      .where('assetId', '=', asset.id)
      .execute();
    const first = await db
      .selectFrom('asset_integrity_verification')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    await integrity.recordVerification(proof);
    const next = await db
      .selectFrom('asset_integrity_verification')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(new Date(next.checkedAt).getTime()).toBeGreaterThan(new Date(first.checkedAt).getTime());
    for (const result of ['mismatched', 'missing', 'unreadable'] as const) {
      await integrity.recordVerification({
        ...proof,
        result,
        actualSha256: result === 'mismatched' ? sha('damaged') : null,
      });
      expect(
        await db
          .selectFrom('asset_integrity_verification')
          .select('result')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ result });
    }
    await fork.recordAssetChecksums({
      ...baseline,
      sha256: Buffer.from(sha('replacement'), 'hex'),
      source: 'integrity',
    });
    expect(await readBaseline()).toEqual(original);
    for (const changed of [
      { originalPath: '/replacement' },
      { checksum: Buffer.from(sha('replacement'), 'hex') },
      { checksumAlgorithm: ChecksumAlgorithm.sha1File },
    ]) {
      await db.updateTable('asset').set(changed).where('id', '=', asset.id).execute();
      expect(await integrity.recordVerification(proof)).toBe(false);
      await db
        .updateTable('asset')
        .set({ originalPath: '/original', checksum, checksumAlgorithm: ChecksumAlgorithm.sha256File })
        .where('id', '=', asset.id)
        .execute();
    }
    expect(
      await db
        .selectFrom('asset_integrity_verification')
        .select('result')
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ result: 'unreadable' });
  });

  it('keeps only completed original membership after cleanup, retry, pruning and asset removal', async () => {
    const { backup } = setup();
    const bucket = `https://s3.test/${randomUUID()}`;
    const assetId = randomUUID(); // No asset FK: deleted library media remains historical membership.
    const make = (key: string) => backup.createManifest({ bucket, key, operationId: randomUUID() });
    const original = { assetId, sha256: sha('original') };
    const completed = await make('m/complete');
    await backup.finishManifest(completed.id, { status: 'complete', originals: [original] });
    // completing twice keeps the first membership
    await backup.finishManifest(completed.id, { status: 'complete', originals: [{ assetId, sha256: sha('later') }] });
    const rows = () =>
      db.selectFrom('cloud_backup_manifest_original').selectAll().where('manifestId', '=', completed.id).execute();
    expect(await rows()).toEqual([{ manifestId: completed.id, ...original }]);
    await backup.markManifests(bucket, ['m/complete'], 'degraded');
    expect(await rows()).toHaveLength(1);
    await backup.markManifests(bucket, ['m/complete'], 'pruned');
    expect(await rows()).toHaveLength(1);
    for (const status of ['cancelled', 'failed'] as const) {
      const failed = await make(`m/${status}`);
      await backup.finishManifest(failed.id, { status, originals: [original] });
      expect(
        await db.selectFrom('cloud_backup_manifest_original').selectAll().where('manifestId', '=', failed.id).execute(),
      ).toEqual([]);
    }
    await backup.adoptManifests(bucket, [
      { key: 'm/historical', createdAt: new Date(), databaseKey: null, assetCount: 1, fileCount: 1, bytes: 8 },
    ]);
    const adopted = await db
      .selectFrom('cloud_backup_manifest')
      .select('id')
      .where('bucket', '=', bucket)
      .where('key', '=', 'm/historical')
      .executeTakeFirstOrThrow();
    expect(
      await db.selectFrom('cloud_backup_manifest_original').selectAll().where('manifestId', '=', adopted.id).execute(),
    ).toEqual([]);
  });
});
