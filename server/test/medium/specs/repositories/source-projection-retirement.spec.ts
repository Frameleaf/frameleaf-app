import { Kysely, type Transaction, sql } from 'kysely';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType, JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { readAssetSource } from 'src/utils/asset-source-authority.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { developSourceVersion } from 'src/utils/develop-source-binding.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
const recipe = [{ action: AssetEditAction.Rotate as const, parameters: { angle: 90 as const } }];

async function setup(type = AssetType.Image) {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type });
  const { sourceReference } = await bindSourceReference(db, asset);
  const source = (await readAssetSource(db, asset.id, false))!;
  const edits = new AssetEditRepository(db);
  const current = await db
    .selectFrom('asset')
    .select(['originalPath', 'checksum'])
    .where('id', '=', asset.id)
    .executeTakeFirstOrThrow();
  await edits.replaceAll(asset.id, recipe, 'save', {
    ownerId: user.id,
    path: current.originalPath,
    checksum: current.checksum,
    reference: sourceReference,
  });
  await db
    .updateTable('asset')
    .set({ isEdited: true, width: 200, height: 300, thumbhash: Buffer.from('old') })
    .where('id', '=', asset.id)
    .execute();
  const edited = `/synthetic/${asset.id}-edited.jpeg`;
  const originalPreview = `/synthetic/${asset.id}-original.jpeg`;
  await db
    .insertInto('asset_file')
    .values([
      { assetId: asset.id, type: AssetFileType.Preview, path: edited, isEdited: true },
      { assetId: asset.id, type: AssetFileType.Preview, path: originalPreview, isEdited: false },
    ])
    .execute();
  const actions = await db.selectFrom('asset_edit').selectAll().where('assetId', '=', asset.id).execute();
  const admit = vi.fn(async (tx: Transaction<DB>, result: { paths: string[]; assetIds: string[] }) => {
    if (result.paths.length > 0)
      await new SqlQueueStore(tx).enqueue([
        {
          name: JobName.FileDelete,
          queue: QueueName.BackgroundTask,
          data: { files: result.paths },
          deadlineMs: 60_000,
          safeToRetry: true,
          sensitive: false,
        },
      ]);
  });
  const develop = ctx.get(AssetDevelopRepository);
  const revision = async (assetId: string, motion = false) => {
    const developRecipe = { ...defaultDevelopRecipe(), ...(motion && { keyFrame: { timeMs: 50 } }) };
    const saved = await develop.create({
      assetId,
      ownerId: user.id,
      recipe: developRecipe,
      recipeVersion: 1,
      label: 'Saved choice',
      status: AssetDevelopRevisionStatus.Saved,
      expectedSourceVersion: developSourceVersion(await develop.getSourceBinding(assetId, user.id, developRecipe)),
    });
    await develop.setCurrent(assetId, saved.id);
    return saved;
  };
  return {
    ctx,
    user,
    asset,
    source,
    sourceReference,
    edits,
    edited,
    originalPreview,
    actions,
    admit,
    develop,
    revision,
  };
}

it('retires the active projection and sync edits while retaining saved actions, versions and file ownership', async () => {
  const f = await setup();
  const saved = await f.revision(f.asset.id);
  // A retained revision, not the active file projection, owns these bytes too.
  await sql`UPDATE asset_develop_revision SET "masterPath"=${f.edited} WHERE id=${saved.id}::uuid`.execute(db);
  const result = await db
    .transaction()
    .execute((tx) => new AssetEditRepository(tx).retireSourceProjection(f.source, f.admit));
  expect(result).toEqual({ paths: [f.edited], assetIds: [f.asset.id] });
  expect(await f.edits.getAll(f.asset.id)).toEqual([]);
  expect(await db.selectFrom('asset_edit').selectAll().where('assetId', '=', f.asset.id).execute()).toEqual(f.actions);
  expect(await db.selectFrom('asset_edit_audit').select('editId').where('assetId', '=', f.asset.id).execute()).toEqual(
    f.actions.map(({ id }) => ({ editId: id })),
  );
  expect(
    await db
      .selectFrom('asset')
      .select(['isEdited', 'width', 'height', 'thumbhash'])
      .where('id', '=', f.asset.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ isEdited: false, width: null, height: null, thumbhash: null });
  expect(
    await db.selectFrom('asset_file').select(['path', 'isEdited']).where('assetId', '=', f.asset.id).execute(),
  ).toEqual([{ path: f.originalPreview, isEdited: false }]);
  expect(await f.develop.get(saved.id)).toMatchObject({
    id: saved.id,
    isCurrent: false,
    masterPath: f.edited,
    recipe: saved.recipe,
  });
  const unlink = vi.fn();
  expect((await f.ctx.get(PhysicalFileRepository).deleteUnreferencedPath(f.edited, unlink)).deleted).toBe(false);
  expect(unlink).not.toHaveBeenCalled();
  await f.edits.retireSourceProjection(f.source, f.admit);
  expect(
    await db.selectFrom('asset_edit_audit').select('editId').where('assetId', '=', f.asset.id).execute(),
  ).toHaveLength(f.actions.length);
});

it('clears video selection but keeps every saved video version and its output bytes', async () => {
  const f = await setup(AssetType.Video);
  const requested = await f.edits.getRequestedVideoVersion(f.asset.id);
  expect(requested).toBeDefined();
  await sql`UPDATE video_edit_version SET "masterPath"=${f.edited}, "proxyPath"=${f.edited + '.proxy'}, status='ready' WHERE id=${requested!.id}::uuid`.execute(
    db,
  );
  await f.edits.retireSourceProjection(f.source, f.admit);
  expect(await f.edits.getRequestedVideoVersion(f.asset.id)).toBeUndefined();
  expect((await sql`SELECT * FROM video_edit_version WHERE id=${requested!.id}::uuid`.execute(db)).rows).toHaveLength(
    1,
  );
  const unlink = vi.fn();
  expect((await f.ctx.get(PhysicalFileRepository).deleteUnreferencedPath(f.edited, unlink)).deleted).toBe(false);
  expect(unlink).not.toHaveBeenCalled();
});

it('retires only same-owner current still projections that use the changed motion original', async () => {
  const f = await setup(AssetType.Video);
  const { asset: parent } = await f.ctx.newAsset({ ownerId: f.user.id, livePhotoVideoId: f.asset.id });
  const dependent = await f.revision(parent.id, true);
  const { asset: other } = await f.ctx.newAsset({ ownerId: f.user.id, livePhotoVideoId: f.asset.id });
  const unrelated = await f.revision(other.id);
  await db.updateTable('asset').set({ isEdited: true }).where('id', '=', parent.id).execute();
  await db
    .insertInto('asset_edit')
    .values({ assetId: parent.id, sequence: 0, ...recipe[0] })
    .execute();
  const path = `/synthetic/${parent.id}-edited.jpeg`;
  await db
    .insertInto('asset_file')
    .values({ assetId: parent.id, type: AssetFileType.Preview, path, isEdited: true })
    .execute();
  const result = await f.edits.retireSourceProjection(f.source, f.admit);
  expect(result.assetIds.sort()).toEqual([f.asset.id, parent.id].sort());
  expect(result.paths.sort()).toEqual([f.edited, path].sort());
  expect(await f.develop.get(dependent.id)).toMatchObject({ isCurrent: false });
  expect(await f.develop.get(unrelated.id)).toMatchObject({ isCurrent: true });
  expect(await f.edits.getAll(parent.id)).toEqual([]);
  expect(await db.selectFrom('asset_edit').select('id').where('assetId', '=', parent.id).execute()).toHaveLength(1);
});

it.each(['admission', 'caller'] as const)(
  'rolls back files, flags, history selection and audit events on %s failure',
  async (reason) => {
    const f = await setup();
    const saved = await f.revision(f.asset.id);
    if (reason === 'admission') {
      const admitted = f.admit.getMockImplementation()!;
      f.admit.mockImplementationOnce(async (tx, result) => {
        await admitted(tx, result);
        throw new Error('admission');
      });
    }
    await expect(
      db.transaction().execute(async (tx) => {
        await new AssetEditRepository(tx).retireSourceProjection(f.source, f.admit);
        if (reason === 'caller') throw new Error('caller');
      }),
    ).rejects.toThrow(reason);
    expect(await f.edits.getAll(f.asset.id)).toHaveLength(1);
    expect(await f.develop.get(saved.id)).toMatchObject({ isCurrent: true });
    expect(await db.selectFrom('asset_file').select('id').where('assetId', '=', f.asset.id).execute()).toHaveLength(2);
    expect(await db.selectFrom('asset_edit_audit').select('id').where('assetId', '=', f.asset.id).execute()).toEqual(
      [],
    );
    expect(
      await db
        .selectFrom('job')
        .select('id')
        .where(sql<boolean>`data->'files' @> ${JSON.stringify([f.edited])}::text::jsonb`)
        .execute(),
    ).toEqual([]);
  },
);

it('rejects stale original identity without clearing the current edit', async () => {
  const f = await setup();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.sourceReference.resourceId)
    .execute();
  await expect(f.edits.retireSourceProjection(f.source, f.admit)).rejects.toThrow(
    'Asset inputs changed before publication',
  );
  expect(await f.edits.getAll(f.asset.id)).toHaveLength(1);
  expect(f.admit).not.toHaveBeenCalled();
});

it('retires cached projections after the provider session ends without fetching the original', async () => {
  const f = await setup();
  const {
    rows: [source],
  } = await sql<{ photoSessionId: string }>`SELECT s."photoSessionId" FROM source_original b
    JOIN photo_source_resource r ON r.id=b."resourceId" JOIN photo_source_run run ON run.id=r."runId"
    JOIN photo_source s ON s.id=run."sourceId" WHERE b."assetId"=${f.asset.id}::uuid`.execute(db);
  await db.deleteFrom('session').where('id', '=', source.photoSessionId).execute();
  await expect(f.edits.retireSourceProjection(f.source, f.admit)).resolves.toEqual({
    paths: [f.edited],
    assetIds: [f.asset.id],
  });
});

it('keeps a parent that selected an independent current revision while retirement waited for a file lock', async () => {
  const f = await setup(AssetType.Video);
  const { asset: parent } = await f.ctx.newAsset({ ownerId: f.user.id, livePhotoVideoId: f.asset.id });
  const old = await f.revision(parent.id, true);
  const independent = await f.develop.create({
    assetId: parent.id,
    ownerId: f.user.id,
    recipe: defaultDevelopRecipe(),
    recipeVersion: 1,
    label: 'New independent choice',
    status: AssetDevelopRevisionStatus.Saved,
  });
  await db.updateTable('asset').set({ isEdited: true }).where('id', '=', parent.id).execute();
  const parentPath = `/synthetic/${parent.id}-current.jpeg`;
  await db
    .insertInto('asset_file')
    .values({ assetId: parent.id, type: AssetFileType.Preview, path: parentPath, isEdited: true })
    .execute();
  let retirement: ReturnType<AssetEditRepository['retireSourceProjection']> | undefined;
  try {
    await db.transaction().execute(async (tx) => {
      await lockFilePath(tx, f.edited);
      const {
        rows: [{ pid }],
      } = await sql<{ pid: number }>`SELECT pg_backend_pid() pid`.execute(tx);
      retirement = f.edits.retireSourceProjection(f.source, f.admit);
      void retirement.catch(() => {});
      await vi.waitFor(
        async () => {
          const { rows } =
            await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`.execute(db);
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 },
      );
      await sql`UPDATE asset_develop_revision SET "isCurrent"=false WHERE id=${old.id}::uuid`.execute(tx);
      await sql`UPDATE asset_develop_revision SET "isCurrent"=true WHERE id=${independent.id}::uuid`.execute(tx);
    });
    expect((await retirement!).assetIds).toEqual([f.asset.id]);
    expect(await f.develop.get(independent.id)).toMatchObject({ isCurrent: true });
    expect(await db.selectFrom('asset_file').select('path').where('assetId', '=', parent.id).execute()).toEqual([
      { path: parentPath },
    ]);
    expect(
      (await db.selectFrom('asset').select('isEdited').where('id', '=', parent.id).executeTakeFirstOrThrow()).isEdited,
    ).toBe(true);
  } finally {
    await retirement?.catch(() => {});
  }
});

it('refuses a new file path discovered after waiting instead of taking a late lock or retiring new files', async () => {
  const f = await setup();
  const replacement = `/synthetic/${f.asset.id}-replacement.jpeg`;
  let retirement: ReturnType<AssetEditRepository['retireSourceProjection']> | undefined;
  try {
    await db.transaction().execute(async (tx) => {
      await lockFilePath(tx, f.edited);
      const {
        rows: [{ pid }],
      } = await sql<{ pid: number }>`SELECT pg_backend_pid() pid`.execute(tx);
      retirement = f.edits.retireSourceProjection(f.source, f.admit);
      void retirement.catch(() => {});
      await vi.waitFor(
        async () => {
          const { rows } =
            await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`.execute(db);
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 },
      );
      await tx
        .updateTable('asset_file')
        .set({ path: replacement })
        .where('assetId', '=', f.asset.id)
        .where('isEdited', '=', true)
        .execute();
    });
    await expect(retirement).rejects.toThrow('Asset inputs changed before publication');
    expect(await f.edits.getAll(f.asset.id)).toHaveLength(1);
    expect(
      await db
        .selectFrom('asset_file')
        .select('path')
        .where('assetId', '=', f.asset.id)
        .where('isEdited', '=', true)
        .execute(),
    ).toEqual([{ path: replacement }]);
    expect(f.admit).not.toHaveBeenCalled();
  } finally {
    await retirement?.catch(() => {});
  }
});
