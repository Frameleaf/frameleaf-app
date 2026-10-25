import { type Kysely, sql } from 'kysely';
import {
  AssetLockReason,
  AssetType,
  AssetVisibility,
  IntegrityReport,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
} from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { type DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: original } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const reference = await bindSourceReference(db, original);
  const repo = new MediaHealthRepository(db);
  const [asset] = await repo.getAssets([original.id]);
  const run = await repo.createRun(MediaHealthCategory.Corrupt, user.id);
  const finding = await repo.upsertFinding({
    runId: run.id,
    assetId: asset.id,
    expectedUpdateId: asset.updateId,
    category: MediaHealthCategory.Corrupt,
    status: MediaHealthStatus.CorruptConfirmed,
    severity: MediaHealthSeverity.Critical,
    originalPath: asset.originalPath,
    originalFileName: asset.originalFileName,
    evidence: { reason: 'decode_failed' },
    resolution: {},
    checkedAt: new Date(),
  });
  const policy = await repo.captureHealthSource(asset);
  const status = async () =>
    (await db.selectFrom('asset_health').select('status').where('id', '=', finding!.id).executeTakeFirstOrThrow())
      .status;
  return { repo, asset, user, reference, policy, status, finding };
};

it('joins nested finding writes and both live source checks in one transaction', async () => {
  const f = await setup();
  const check = vi.fn(() => {
    expect(publicationTransaction.getStore()?.isTransaction).toBe(true);
    return Promise.resolve();
  });
  await f.repo.publishHealthSource(f.asset, f.policy, check, () =>
    f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]),
  );
  expect(check).toHaveBeenCalledTimes(2);
  expect(await f.status()).toBe(MediaHealthStatus.Resolved);
});

it.each(['provider', 'callback'] as const)('rolls back a healthy resolution after %s failure', async (failure) => {
  const f = await setup();
  let calls = 0;
  const check = () => {
    if (++calls === 2 && failure === 'provider') throw new Error('source_original_unavailable');
    return Promise.resolve();
  };
  await expect(
    f.repo.publishHealthSource(f.asset, f.policy, check, async () => {
      await f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]);
      if (failure === 'callback') throw new Error('publication interrupted');
    }),
  ).rejects.toThrow(failure === 'provider' ? 'source_original_unavailable' : 'publication interrupted');
  expect(await f.status()).toBe(MediaHealthStatus.CorruptConfirmed);
});

it.each(['privacy', 'lock'] as const)('refuses changed %s before updating findings', async (change) => {
  const f = await setup();
  if (change === 'privacy') {
    await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('id', '=', f.asset.id).execute();
  } else {
    await db
      .insertInto('asset_lock')
      .values({ assetId: f.asset.id, reason: AssetLockReason.Marked, lockedBy: f.user.id })
      .execute();
  }
  const check = vi.fn().mockResolvedValue(undefined);
  await expect(
    f.repo.publishHealthSource(f.asset, f.policy, check, () =>
      f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]),
    ),
  ).rejects.toThrow();
  expect(check).not.toHaveBeenCalled();
  expect(await f.status()).toBe(MediaHealthStatus.CorruptConfirmed);
});

it('refuses a changed resource snapshot before verification or clearing damage', async () => {
  const f = await setup();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.reference.resource.id)
    .execute();
  const check = vi.fn(async () => {
    const tx = publicationTransaction.getStore()!;
    const current = await tx
      .selectFrom('photo_source_resource')
      .select('version')
      .where('id', '=', f.reference.resource.id)
      .forShare()
      .executeTakeFirstOrThrow();
    if (current.version !== f.reference.sourceReference.version) throw new Error('source_original_unavailable');
  });
  await expect(
    f.repo.publishHealthSource(f.asset, f.policy, check, () =>
      f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]),
    ),
  ).rejects.toThrow('Asset inputs changed before publication');
  expect(check).not.toHaveBeenCalled();
  expect(await f.status()).toBe(MediaHealthStatus.CorruptConfirmed);
});

const integrityReferenceReport = async (
  type: IntegrityReport.MissingFile | IntegrityReport.ChecksumFail = IntegrityReport.MissingFile,
) => {
  const f = await setup();
  const integrity = new IntegrityRepository(db);
  const report = await integrity.create({
    type,
    path: f.asset.originalPath,
    assetId: f.asset.id,
  });
  const input = { assetId: f.asset.id, path: f.asset.originalPath, reportId: report.id, type };
  const existing = () => db.selectFrom('integrity_report').selectAll().where('id', '=', report.id).executeTakeFirst();
  return { ...f, integrity, report, input, existing };
};

it('resolves only the exact reference missing report inside the source publication fence', async () => {
  const f = await integrityReferenceReport();
  const checksum = await f.integrity.create({
    type: IntegrityReport.ChecksumFail,
    path: f.asset.originalPath,
    assetId: f.asset.id,
  });
  const check = vi.fn().mockResolvedValue(undefined);
  await f.repo.publishHealthSource(f.asset, f.policy, check, () => f.integrity.resolveReferenceReport(f.input));
  expect(await f.existing()).toBeUndefined();
  expect(
    await db.selectFrom('integrity_report').select('id').where('id', '=', checksum.id).executeTakeFirst(),
  ).toBeDefined();
  expect(check).toHaveBeenCalledTimes(2);
});

it('rolls back a resolved missing report when final source confirmation fails', async () => {
  const f = await integrityReferenceReport();
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('source unavailable'));
  await expect(
    f.repo.publishHealthSource(f.asset, f.policy, check, () => f.integrity.resolveReferenceReport(f.input)),
  ).rejects.toThrow('source unavailable');
  expect(await f.existing()).toBeDefined();
});

it('does not remove a retargeted report or one recreated under a different ID', async () => {
  const f = await integrityReferenceReport();
  const other = await setup();
  await db.updateTable('integrity_report').set({ assetId: other.asset.id }).where('id', '=', f.report.id).execute();
  await f.repo.publishHealthSource(
    f.asset,
    f.policy,
    async () => {},
    () => f.integrity.resolveReferenceReport(f.input),
  );
  expect((await f.existing())?.assetId).toBe(other.asset.id);
  await db.deleteFrom('integrity_report').where('id', '=', f.report.id).execute();
  const recreated = await f.integrity.create({
    type: IntegrityReport.MissingFile,
    path: f.asset.originalPath,
    assetId: f.asset.id,
  });
  await f.repo.publishHealthSource(
    f.asset,
    f.policy,
    async () => {},
    () => f.integrity.resolveReferenceReport(f.input),
  );
  expect(
    await db.selectFrom('integrity_report').select('id').where('id', '=', recreated.id).executeTakeFirst(),
  ).toBeDefined();
  expect(
    await f.integrity.getReferenceReport(f.report.id, f.asset.originalPath, IntegrityReport.MissingFile),
  ).toBeUndefined();
});

it('refuses reference report resolution without a source publication transaction', async () => {
  const f = await integrityReferenceReport();
  expect(() => f.integrity.resolveReferenceReport(f.input)).toThrow('publication transaction');
  expect(await f.existing()).toBeDefined();
});

it('resolves a verified current reference checksum report without creating unversioned integrity receipts', async () => {
  const f = await integrityReferenceReport(IntegrityReport.ChecksumFail);
  const check = vi.fn().mockResolvedValue(undefined);
  await f.repo.publishHealthSource(f.asset, f.policy, check, () => f.integrity.resolveReferenceReport(f.input));
  expect(await f.existing()).toBeUndefined();
  expect(
    await db
      .selectFrom('asset_integrity_verification')
      .select('assetId')
      .where('assetId', '=', f.asset.id)
      .executeTakeFirst(),
  ).toBeUndefined();
  const { rows } = await sql`select "assetId" from public.asset_checksum where "assetId" = ${f.asset.id}::uuid`.execute(
    db,
  );
  expect(rows).toEqual([]);
});

it('retains a checksum report when final source authority rejects its resolution', async () => {
  const f = await integrityReferenceReport(IntegrityReport.ChecksumFail);
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('source revoked'));
  await expect(
    f.repo.publishHealthSource(f.asset, f.policy, check, () => f.integrity.resolveReferenceReport(f.input)),
  ).rejects.toThrow('source revoked');
  expect(await f.existing()).toBeDefined();
});

it('includes referenced originals in full checksum scans while preserving ordinary external-file exclusion', async () => {
  const f = await setup();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { asset: managed } = await ctx.newAsset({ ownerId: f.user.id, isExternal: false });
  const { asset: external } = await ctx.newAsset({ ownerId: f.user.id, isExternal: true });
  const selected = [];
  for await (const asset of new IntegrityRepository(db).streamAssetChecksums()) selected.push(asset.assetId);
  expect(selected).toContain(f.asset.id);
  expect(selected).toContain(managed.id);
  expect(selected).not.toContain(external.id);
});

it.each(['revoked source', 'paused device', 'expired session', 'deleted library'])(
  'refuses a health verdict after %s even before the provider check',
  async (change) => {
    const f = await setup();
    const source = await db
      .selectFrom('photo_source')
      .selectAll()
      .where('id', '=', new URL(f.asset.originalPath).hostname)
      .executeTakeFirstOrThrow();
    switch (change) {
      case 'revoked source': {
        await db.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', source.id).execute();
        break;
      }
      case 'paused device': {
        await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', source.deviceId).execute();
        break;
      }
      case 'expired session': {
        await db
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', source.photoSessionId)
          .execute();
        break;
      }
      default: {
        await db.updateTable('library').set({ deletedAt: new Date() }).where('id', '=', f.asset.libraryId!).execute();
      }
    }
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(
      f.repo.publishHealthSource(f.asset, f.policy, check, () =>
        f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]),
      ),
    ).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
    expect(await f.status()).toBe(MediaHealthStatus.CorruptConfirmed);
  },
);

it('rolls back a proposed health verdict and an input mutation made by its callback', async () => {
  const f = await setup();
  await expect(
    f.repo.publishHealthSource(
      f.asset,
      f.policy,
      () => Promise.resolve(),
      async () => {
        await f.repo.markResolvedForAssets([MediaHealthCategory.Corrupt], [f.asset]);
        await f.repo['db']
          .updateTable('asset')
          .set({ visibility: AssetVisibility.Archive })
          .where('id', '=', f.asset.id)
          .execute();
      },
    ),
  ).rejects.toThrow();
  expect(await f.status()).toBe(MediaHealthStatus.CorruptConfirmed);
  expect(
    (await db.selectFrom('asset').select('visibility').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
      .visibility,
  ).toBe(f.asset.visibility);
});
