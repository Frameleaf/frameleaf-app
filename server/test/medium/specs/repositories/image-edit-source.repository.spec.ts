import { Kysely, sql } from 'kysely';
import type { QueueExecution } from 'src/queue/types.js';
import type { DB } from 'src/schema/index.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetType } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { assertAssetSource, readAssetSource } from 'src/utils/asset-source-authority.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
const recipe = [{ action: AssetEditAction.Rotate as const, parameters: { angle: 90 as const } }];
const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const { resource, sourceReference } = await bindSourceReference(db, asset);
  const current = await db
    .selectFrom('asset')
    .select(['ownerId', 'originalPath', 'checksum'])
    .where('id', '=', asset.id)
    .executeTakeFirstOrThrow();
  const expected = {
    ownerId: current.ownerId,
    path: current.originalPath,
    checksum: current.checksum,
    reference: sourceReference,
  };
  return { asset, resource, sourceReference, expected, sut: new AssetEditRepository(db) };
};
it.each(['matching', 'changed-version', 'changed-checksum', 'unbound', 'missing'] as const)(
  'retains the saved image source through later render admission: %s',
  async (kind) => {
    const f = await fixture();
    await f.sut.replaceAll(f.asset.id, recipe, 'save', f.expected);
    expect(
      (await db.selectFrom('asset_edit').select('sourceReference').where('assetId', '=', f.asset.id).execute())[0]
        .sourceReference,
    ).toEqual(f.sourceReference);
    await expect(f.sut.assertImageEditSource(f.asset.id)).resolves.toBeUndefined();
    switch (kind) {
      case 'changed-version': {
        await db
          .updateTable('photo_source_resource')
          .set({ version: 'e'.repeat(64) })
          .where('id', '=', f.resource.id)
          .execute();
        break;
      }
      case 'changed-checksum': {
        await db
          .updateTable('photo_source_resource')
          .set({ checksum: Buffer.from('e'.repeat(64), 'hex') })
          .where('id', '=', f.resource.id)
          .execute();
        break;
      }
      case 'unbound': {
        await db
          .updateTable('asset_edit')
          .set({ sourceReference: { kind: 'unbound-reference' } })
          .where('assetId', '=', f.asset.id)
          .execute();
        break;
      }
      case 'missing': {
        await db.updateTable('asset_edit').set({ sourceReference: null }).where('assetId', '=', f.asset.id).execute();
        break;
      }
      default: {
        break;
      }
    }
    if (kind === 'matching') await expect(f.sut.assertImageEditSource(f.asset.id)).resolves.toBeUndefined();
    else await expect(f.sut.assertImageEditSource(f.asset.id)).rejects.toThrow('asset_edit_source_changed');
    expect(await f.sut.getAll(f.asset.id)).toEqual([expect.objectContaining(recipe[0])]);
  },
);

it('refuses publication when only the saved image provenance changes', async () => {
  const f = await fixture();
  await f.sut.replaceAll(f.asset.id, recipe, 'save', f.expected);
  const snapshot = (await readAssetSource(db, f.asset.id, true))!;
  await db
    .updateTable('asset_edit')
    .set({ sourceReference: { kind: 'unbound-reference' } })
    .where('assetId', '=', f.asset.id)
    .execute();
  await expect(assertAssetSource(db, snapshot)).rejects.toThrow('Asset inputs changed before publication');
});

it('locks reference parents before a queued publication waits for the asset', async () => {
  const f = await fixture();
  const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
  const context = { signal: new AbortController().signal, adoptions: [] } as unknown as QueueExecution;
  await queueExecution.run(context, () => jobs.guardAssetSource(f.asset.id));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = db.transaction().execute((tx) =>
    publicationTransaction.run(tx, async () => {
      for (const adopt of context.adoptions) await adopt(tx);
    }),
  );
  void pending.catch(() => {});
  try {
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock') AS waiting`.execute(db)
          ).rows[0].waiting,
      )
      .toBe(true);
    const source = await db
      .selectFrom('photo_source_run')
      .select('sourceId')
      .where('id', '=', f.resource.runId)
      .executeTakeFirstOrThrow();
    await expect(
      db
        .transaction()
        .execute((tx) =>
          sql`SELECT id FROM photo_source WHERE id=${source.sourceId}::uuid FOR UPDATE NOWAIT`.execute(tx),
        ),
    ).rejects.toMatchObject({ code: '55P03' });
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it.each([AssetType.Image, AssetType.Video])(
  'rechecks live %s edit authority after waiting for a lock',
  async (type) => {
    for (const change of ['source-revoked', 'device-revoked', 'session-expired'] as const) {
      const f = await fixture();
      await db.updateTable('asset').set({ type }).where('id', '=', f.asset.id).execute();
      await f.sut.replaceAll(f.asset.id, recipe, 'save', f.expected);
      const versions = (
        await sql`SELECT id,status FROM video_edit_version WHERE "assetId"=${f.asset.id}::uuid`.execute(db)
      ).rows;
      const source = await db
        .selectFrom('photo_source')
        .innerJoin('photo_source_run', 'photo_source_run.sourceId', 'photo_source.id')
        .select(['photo_source.id', 'photo_source.deviceId', 'photo_source.photoSessionId'])
        .where('photo_source_run.id', '=', f.resource.runId)
        .executeTakeFirstOrThrow();
      if (change === 'session-expired')
        await db
          .updateTable('session')
          .set({ expiresAt: new Date(Date.now() + 500) })
          .where('id', '=', source.photoSessionId)
          .execute();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = db.transaction().execute(async (tx) => {
        if (change === 'device-revoked')
          await tx.selectFrom('desktop_device').select('id').where('id', '=', source.deviceId).forUpdate().execute();
        await tx.selectFrom('photo_source').select('id').where('id', '=', source.id).forUpdate().execute();
        await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
        entered.resolve();
        await release.promise;
        if (change === 'source-revoked')
          await tx.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', source.id).execute();
        else if (change === 'device-revoked')
          await tx
            .updateTable('desktop_device')
            .set({ revokedAt: new Date() })
            .where('id', '=', source.deviceId)
            .execute();
      });
      await entered.promise;
      const pending = f.sut.replaceAll(f.asset.id, [], 'save', f.expected);
      void pending.catch(() => {});
      try {
        await expect
          .poll(
            async () =>
              (
                await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock') AS waiting`.execute(db)
              ).rows[0].waiting,
          )
          .toBe(true);
        if (change === 'session-expired') await sql`SELECT pg_sleep(0.6)`.execute(db);
      } finally {
        release.resolve();
        await blocker;
      }
      await expect(pending).rejects.toThrow(
        type === AssetType.Video ? 'video_version_source_changed' : 'asset_edit_source_changed',
      );
      expect(await f.sut.getAll(f.asset.id)).toEqual([expect.objectContaining(recipe[0])]);
      expect(
        (await sql`SELECT id,status FROM video_edit_version WHERE "assetId"=${f.asset.id}::uuid`.execute(db)).rows,
      ).toEqual(versions);
    }
  },
);
