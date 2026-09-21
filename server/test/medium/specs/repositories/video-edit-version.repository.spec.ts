import { Kysely, sql } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000100-VideoEditVersions.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  return { asset, sut: ctx.get(AssetEditRepository) };
};
const recipe = [{ action: AssetEditAction.Rotate as const, parameters: { angle: 90 as const } }];
const rendered = (assetId: string, label: string) => ({
  masterPath: `/derived/${label}.master.mp4`,
  width: 720,
  height: 1280,
  duration: 1000,
  files: [
    {
      assetId,
      type: AssetFileType.EncodedVideo,
      path: `/derived/${label}.proxy.mp4`,
      isEdited: true,
      isProgressive: false,
      isTransparent: false,
    },
  ],
});

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => entry.identity.startsWith('immich_fork.video_edit_'))).toEqual(
      manifest[kind].filter((entry) => entry.identity.startsWith('immich_fork.video_edit_')),
    );
  }
  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
});

it('stores original-derived recipes and publishes only the requested version while retaining history', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const first = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(first.recipe).toEqual(recipe);
  expect(first.sourcePath).toBe(asset.originalPath);
  await sut.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);
  const second = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(await sut.publishVideoVersion(first, rendered(asset.id, first.id))).toBe(false);
  expect(await sut.publishVideoVersion(second, rendered(asset.id, second.id))).toBe(true);
  expect(await sut.publishVideoVersion(second, rendered(asset.id, 'duplicate'))).toBe(false);
  const files = await db.selectFrom('asset_file').selectAll().where('assetId', '=', asset.id).execute();
  expect(files[0].path).toBe(`/derived/${second.id}.proxy.mp4`);
  const history = await sql`SELECT * FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
  expect(history.rows).toHaveLength(2);
  await sut.replaceAll(asset.id, []);
  const original = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(
    await sut.publishVideoVersion(original, { masterPath: null, files: [], width: 1280, height: 720, duration: 1000 }),
  ).toBe(true);
  const retained = await sql<{
    path: string;
  }>`SELECT "masterPath" as path FROM immich_fork.video_edit_version WHERE id=${second.id}::uuid`.execute(db);
  expect(retained.rows[0].path).toBe(`/derived/${second.id}.master.mp4`);
  const unchanged = await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirst();
  expect(unchanged?.originalPath).toBe(asset.originalPath);
});

it('rejects source changes, original-path publication and a handoff fence', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  await expect(
    sut.publishVideoVersion(version, { ...rendered(asset.id, version.id), masterPath: asset.originalPath }),
  ).rejects.toThrow('invalid_paths');
  await db.updateTable('asset').set({ originalPath: '/changed/original' }).where('id', '=', asset.id).execute();
  expect(await sut.publishVideoVersion(version, rendered(asset.id, version.id))).toBe(false);
  await sql`INSERT INTO immich_fork.migration_audit(name,phase,status) VALUES('official-handoff-preparation','ready','running')`.execute(
    db,
  );
  await expect(sut.replaceAll(asset.id, recipe)).rejects.toThrow('handoff');
  await sql`DELETE FROM immich_fork.migration_audit WHERE name='official-handoff-preparation'`.execute(db);
});

it('keeps exports independent and prunes only unselected, unreferenced version files', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const saved = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.publishVideoVersion(saved, rendered(asset.id, saved.id));
  const exported = await sut.createVideoExport(asset.id, asset.ownerId);
  expect(exported.purpose).toBe('export');
  expect(await sut.publishVideoVersion(exported, rendered(asset.id, exported.id))).toBe(true);
  expect((await sut.getRequestedVideoVersion(asset.id))!.id).toBe(saved.id);
  expect(
    (await db.selectFrom('asset_file').select('path').where('assetId', '=', asset.id).executeTakeFirst())!.path,
  ).toContain(saved.id);
  await expect(sut.pruneVideoVersion(asset.id, saved.id, asset.ownerId)).rejects.toThrow('selected_or_missing');
  const retained = `/derived/${exported.id}.master.mp4`;
  const alias = await setup();
  await db.updateTable('asset').set({ originalPath: retained }).where('id', '=', alias.asset.id).execute();
  expect(await sut.pruneVideoVersion(asset.id, exported.id, asset.ownerId)).toEqual([
    `/derived/${exported.id}.proxy.mp4`,
  ]);
  expect(await sut.getVideoVersion(asset.id, exported.id)).toBeUndefined();
  expect(await sut.listVideoVersions(asset.id, alias.asset.ownerId)).toEqual([]);
});

it('serializes concurrent saves and admits only the current request', async () => {
  const { asset, sut } = await setup();
  await Promise.all([sut.replaceAll(asset.id, recipe), sut.replaceAll(asset.id, recipe)]);
  const versions = await sut.listVideoVersions(asset.id, asset.ownerId);
  expect(versions).toHaveLength(2);
  const results = await Promise.all(
    versions.map((version) => sut.publishVideoVersion(version, rendered(asset.id, version.id))),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('protects retained and handoff-archived masters from the shared deletion worker', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  const output = rendered(asset.id, version.id);
  await sut.publishVideoVersion(version, output);
  await sut.replaceAll(asset.id, []);
  await sut.publishVideoVersion((await sut.getRequestedVideoVersion(asset.id))!, {
    masterPath: null,
    files: [],
    width: 1280,
    height: 720,
    duration: 1000,
  });
  const physical = new PhysicalFileRepository(db);
  const unlink = vi.fn(async () => {});
  expect(await physical.deleteUnreferencedPath(output.masterPath, unlink)).toMatchObject({ deleted: false });
  expect(unlink).not.toHaveBeenCalled();
  await sql`INSERT INTO immich_fork.orphaned_records ("sourceTable","sourceKey",payload)
    SELECT 'video_edit_version',id::text,to_jsonb(v) FROM immich_fork.video_edit_version v WHERE id=${version.id}::uuid`.execute(
    db,
  );
  await sut.pruneVideoVersion(asset.id, version.id, asset.ownerId);
  expect(await physical.deleteUnreferencedPath(output.masterPath, unlink)).toMatchObject({ deleted: false });
  expect(unlink).not.toHaveBeenCalled();
  await sql`DELETE FROM immich_fork.orphaned_records WHERE "sourceTable"='video_edit_version' AND "sourceKey"=${version.id}`.execute(
    db,
  );
  expect(await physical.deleteUnreferencedPath(output.masterPath, unlink)).toEqual({ deleted: true, references: 0 });
  expect(unlink).toHaveBeenCalledOnce();
});

it('retains current selection through a failed attempt and retries the same immutable recipe', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const current = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.publishVideoVersion(current, rendered(asset.id, current.id));
  await sut.replaceAll(asset.id, recipe);
  const retry = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.failVideoVersion(asset.id, retry.id);
  const versions = await sut.listVideoVersions(asset.id, asset.ownerId);
  expect(versions.find((version) => version.id === current.id)).toMatchObject({
    isCurrent: true,
    isRequested: false,
    status: 'ready',
  });
  expect(versions.find((version) => version.id === retry.id)).toMatchObject({
    isCurrent: false,
    isRequested: true,
    status: 'failed',
  });
  expect(await sut.publishVideoVersion(retry, rendered(asset.id, retry.id))).toBe(true);
  await sut.failVideoVersion(asset.id, retry.id);
  expect(await sut.getVideoVersion(asset.id, retry.id)).toMatchObject({ status: 'ready', recipe });
});
