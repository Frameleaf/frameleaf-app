import { Kysely, sql } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType, JobName, JobStatus } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000120-VideoEditVersions.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
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
  return { asset, ctx, sut: ctx.get(AssetEditRepository) };
};
const recipe = [{ action: AssetEditAction.Rotate as const, parameters: { angle: 90 as const } }];
const publish = async (
  sut: AssetEditRepository,
  ...args: Parameters<AssetEditRepository['publishVideoVersion']>
): Promise<boolean> => (await sut.publishVideoVersion(...args)).published;
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
  expect(await publish(sut, first, rendered(asset.id, first.id))).toBe(false);
  expect(await publish(sut, second, rendered(asset.id, second.id))).toBe(true);
  expect(await publish(sut, second, rendered(asset.id, 'duplicate'))).toBe(false);
  const files = await db.selectFrom('asset_file').selectAll().where('assetId', '=', asset.id).execute();
  expect(files[0].path).toBe(`/derived/${second.id}.proxy.mp4`);
  const history = await sql`SELECT * FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
  expect(history.rows).toHaveLength(2);
  await sut.replaceAll(asset.id, []);
  const original = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(await publish(sut, original, { masterPath: null, files: [], width: 1280, height: 720, duration: 1000 })).toBe(
    true,
  );
  const retained = await sql<{
    path: string;
  }>`SELECT "masterPath" as path FROM immich_fork.video_edit_version WHERE id=${second.id}::uuid`.execute(db);
  expect(retained.rows[0].path).toBe(`/derived/${second.id}.master.mp4`);
  const unchanged = await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirst();
  expect(unchanged?.originalPath).toBe(asset.originalPath);
});

it('rejects content changes, original-path publication and a handoff fence', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  await expect(
    sut.publishVideoVersion(version, { ...rendered(asset.id, version.id), masterPath: asset.originalPath }),
  ).rejects.toThrow('invalid_paths');
  await db
    .updateTable('asset')
    .set({ checksum: Buffer.from('changed') })
    .where('id', '=', asset.id)
    .execute();
  expect(await publish(sut, version, rendered(asset.id, version.id))).toBe(false);
  await expect(sut.getRequestedVideoVersion(asset.id)).rejects.toThrow('source_changed');
  // History of a replaced original is not offered where it could no longer be downloaded.
  expect(await sut.listVideoVersions(asset.id, asset.ownerId)).toEqual([]);
  expect(await sut.getVideoVersion(asset.id, version.id)).toBeUndefined();
  const failed = await sql<{
    status: string;
  }>`SELECT status FROM immich_fork.video_edit_version WHERE id=${version.id}::uuid`.execute(db);
  expect(failed.rows[0].status).toBe('failed');
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
  expect(await publish(sut, exported, rendered(asset.id, exported.id))).toBe(true);
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
  const results = await Promise.all(versions.map((version) => publish(sut, version, rendered(asset.id, version.id))));
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
  expect(await publish(sut, retry, rendered(asset.id, retry.id))).toBe(true);
  await sut.failVideoVersion(asset.id, retry.id);
  expect(await sut.getVideoVersion(asset.id, retry.id)).toMatchObject({ status: 'ready', recipe });
});

const versionedService = () =>
  newMediumService(AssetService, {
    database: db,
    real: [
      AssetRepository,
      AssetJobRepository,
      AssetEditRepository,
      AccessRepository,
      DuplicateRepository,
      UserRepository,
      MediaRepository,
    ],
    mock: [LoggingRepository, JobRepository, EventRepository],
  });

it('permanently deletes version state and queues all derived paths while protecting another asset reference', async () => {
  const { sut, ctx } = versionedService();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    originalPath: '/source/delete-versioned.mp4',
    // Permanent deletion only removes an asset that is still in the trash (FL-71).
    deletedAt: new Date(),
  });
  const versions = ctx.get(AssetEditRepository);
  await versions.replaceAll(asset.id, recipe);
  const first = (await versions.getRequestedVideoVersion(asset.id))!;
  await versions.publishVideoVersion(first, rendered(asset.id, first.id));
  await versions.replaceAll(asset.id, recipe);
  const current = (await versions.getRequestedVideoVersion(asset.id))!;
  await versions.publishVideoVersion(current, rendered(asset.id, current.id));
  const exported = await versions.createVideoExport(asset.id, user.id);
  await versions.publishVideoVersion(exported, rendered(asset.id, exported.id));
  const shared = rendered(asset.id, first.id).masterPath;
  const { asset: alias } = await ctx.newAsset({ ownerId: user.id, originalPath: shared });
  expect(await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).toBe(JobStatus.Success);
  const selections =
    await sql`SELECT * FROM immich_fork.video_edit_selection WHERE "assetId"=${asset.id}::uuid`.execute(db);
  const history = await sql`SELECT * FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
  expect(selections.rows).toEqual([]);
  expect(history.rows).toEqual([]);
  const files = ctx
    .getMock(JobRepository)
    .queue.mock.calls.flatMap(([job]) => (job.name === JobName.FileDelete ? job.data.files : []));
  expect(files).toEqual(
    expect.arrayContaining([
      asset.originalPath,
      ...[first, current, exported].flatMap((version) => [
        rendered(asset.id, version.id).masterPath,
        rendered(asset.id, version.id).files[0].path,
      ]),
    ]),
  );
  const physical = ctx.get(PhysicalFileRepository);
  for (const path of new Set(files)) {
    const unlink = vi.fn(() => Promise.resolve());
    expect(await physical.deleteUnreferencedPath(path!, unlink)).toMatchObject({ deleted: path !== shared });
    expect(unlink).toHaveBeenCalledTimes(path === shared ? 0 : 1);
  }
  expect(await ctx.get(AssetRepository).getById(alias.id)).toBeDefined();
});

it('validates repeat saves and restores against the 30-second original after shorter renders', async () => {
  const { sut, ctx } = versionedService();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    duration: 30_000,
    originalPath: '/source/restore-timeline.mp4',
  });
  await ctx.newExif({ assetId: asset.id, exifImageWidth: 1280, exifImageHeight: 720 });
  const probe = vi.spyOn(ctx.get(MediaRepository), 'probe').mockResolvedValue({
    format: { duration: 30 },
    videoStreams: [{ width: 1280, height: 720, rotation: 0 }],
    audioStreams: [],
  } as any);
  const auth = factory.auth({ user });
  const versions = ctx.get(AssetEditRepository);
  const longer = [{ action: AssetEditAction.Trim as const, parameters: { startMs: 0, endMs: 20_000 } }];
  await sut.editAsset(auth, asset.id, { edits: longer });
  const saved = (await versions.getRequestedVideoVersion(asset.id))!;
  await versions.publishVideoVersion(saved, { ...rendered(asset.id, saved.id), duration: 20_000 });
  await sut.editAsset(auth, asset.id, {
    edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 5000 } }],
  });
  const shorter = (await versions.getRequestedVideoVersion(asset.id))!;
  await versions.publishVideoVersion(shorter, { ...rendered(asset.id, shorter.id), duration: 5000 });
  const editResponse = await sut.getAssetEdits(auth, asset.id);
  expect(editResponse.originalVideo).toEqual({
    width: 1280,
    height: 720,
    durationMs: 30_000,
  });
  await sut.editAsset(auth, asset.id, {
    edits: [
      { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 600 } },
      { action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 25_000 } },
    ],
  });
  expect((await versions.getRequestedVideoVersion(asset.id))!.recipe).toEqual([
    { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 600 } },
    { action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 25_000 } },
  ]);
  await sut.restoreVideoEditVersion(auth, asset.id, saved.id);
  expect(await versions.getRequestedVideoVersion(asset.id)).toMatchObject({ recipe: longer, purpose: 'revert' });
  await sut.editAsset(auth, asset.id, {
    edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 25_000 } }],
  });
  await expect(
    sut.editAsset(auth, asset.id, {
      edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 31_000 } }],
    }),
  ).rejects.toThrow('out of bounds');
  expect(probe).toHaveBeenCalledWith(asset.originalPath);
});

it('releases private version references during account asset teardown', async () => {
  const { asset, ctx, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.publishVideoVersion(version, rendered(asset.id, version.id));
  await sql`INSERT INTO immich_fork.orphaned_records ("sourceTable","sourceKey",payload)
    SELECT 'video_edit_version',id::text,to_jsonb(v) FROM immich_fork.video_edit_version v WHERE id=${version.id}::uuid`.execute(
    db,
  );
  await ctx.get(AssetRepository).deleteAll(asset.ownerId);
  // Teardown leaves retained versions to the orphan release, which queues their files.
  expect(await sut.releaseOrphanedVideoVersions()).toEqual(
    expect.arrayContaining([
      `/derived/${version.id}.master.mp4`,
      `/derived/${version.id}.master.mp4.lineage.json`,
      `/derived/${version.id}.proxy.mp4`,
    ]),
  );
  const privateRows = await sql`SELECT 1 FROM immich_fork.video_edit_selection WHERE "assetId"=${asset.id}::uuid
    UNION ALL SELECT 1 FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid
    UNION ALL SELECT 1 FROM immich_fork.orphaned_records WHERE "sourceTable"='video_edit_version' AND payload->>'assetId'=${asset.id}`.execute(
    db,
  );
  expect(privateRows.rows).toEqual([]);
});

it('keeps versions valid when the original moves and never pins the old original path', async () => {
  const { asset, sut } = await setup();
  const before = `/library/before-${asset.id}.mp4`;
  await db.updateTable('asset').set({ originalPath: before }).where('id', '=', asset.id).execute();
  await sut.replaceAll(asset.id, recipe);
  const moved = `/library/moved-${asset.id}.mp4`;
  await db.updateTable('asset').set({ originalPath: moved }).where('id', '=', asset.id).execute();
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(version.sourcePath).toBe(moved);
  expect(await publish(sut, version, rendered(asset.id, version.id))).toBe(true);
  expect(await sut.getVideoVersion(asset.id, version.id)).toMatchObject({ sourcePath: moved, status: 'ready' });
  const exported = await sut.createVideoExport(asset.id, asset.ownerId);
  expect(exported.sourcePath).toBe(moved);
  const unlink = vi.fn(async () => {});
  expect(await new PhysicalFileRepository(db).deleteUnreferencedPath(before, unlink)).toEqual({
    deleted: true,
    references: 0,
  });
});

it("releases a pre-history edit's files on the first versioned publication, but never a version's", async () => {
  const { asset, sut } = await setup();
  const legacy = `/legacy/${asset.id}_edited.mp4`;
  const legacyThumb = `/legacy/${asset.id}_edited_thumbnail.webp`;
  await db
    .insertInto('asset_file')
    .values([
      { assetId: asset.id, type: AssetFileType.EncodedVideo, path: legacy, isEdited: true },
      { assetId: asset.id, type: AssetFileType.Thumbnail, path: legacyThumb, isEdited: true },
    ])
    .execute();
  await sut.replaceAll(asset.id, []);
  const revert = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(
    await sut.publishVideoVersion(revert, { masterPath: null, files: [], width: 1280, height: 720, duration: 1000 }),
  ).toEqual({
    published: true,
    releasedPaths: expect.arrayContaining([legacy, `${legacy}.lineage.json`, legacyThumb]),
  });

  await sut.replaceAll(asset.id, recipe);
  const saved = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.publishVideoVersion(saved, rendered(asset.id, saved.id));
  await sut.replaceAll(asset.id, []);
  const again = (await sut.getRequestedVideoVersion(asset.id))!;
  expect(
    await sut.publishVideoVersion(again, { masterPath: null, files: [], width: 1280, height: 720, duration: 1000 }),
  ).toEqual({ published: true, releasedPaths: [] });
});

it('marks a superseded pending save failed as soon as a newer one is requested', async () => {
  const { asset, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const first = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);
  expect(await sut.getVideoVersion(asset.id, first.id)).toMatchObject({ status: 'failed' });
});

it('leaves versions as orphans while fork writes are disabled and reclaims them afterwards', async () => {
  const { asset, ctx, sut } = await setup();
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  await sut.publishVideoVersion(version, rendered(asset.id, version.id));
  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await expect(ctx.get(AssetRepository).remove({ id: asset.id })).resolves.toMatchObject({
      originalPath: asset.originalPath,
    });
    expect(await sut.releaseOrphanedVideoVersions()).toEqual([]);
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
  const left = await sql`SELECT 1 FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
  expect(left.rows).toHaveLength(1);
  expect(await sut.releaseOrphanedVideoVersions()).toEqual(
    expect.arrayContaining([`/derived/${version.id}.master.mp4`, `/derived/${version.id}.proxy.mp4`]),
  );
  const gone = await sql`SELECT 1 FROM immich_fork.video_edit_version WHERE "assetId"=${asset.id}::uuid
    UNION ALL SELECT 1 FROM immich_fork.video_edit_selection WHERE "assetId"=${asset.id}::uuid`.execute(db);
  expect(gone.rows).toEqual([]);
});

it('does not block photo edits during a handoff', async () => {
  const { ctx, sut } = await setup();
  const { user } = await ctx.newUser();
  const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  await sql`INSERT INTO immich_fork.migration_audit(name,phase,status) VALUES('official-handoff-preparation','ready','running')`.execute(
    db,
  );
  try {
    await expect(sut.replaceAll(photo.id, recipe)).resolves.toHaveLength(1);
  } finally {
    await sql`DELETE FROM immich_fork.migration_audit WHERE name='official-handoff-preparation'`.execute(db);
  }
});

it('exempts version files and master lineage sidecars from the untracked-file scan', async () => {
  const { asset, ctx, sut } = await setup();
  const { asset: legacyAsset } = await ctx.newAsset({ ownerId: asset.ownerId, type: AssetType.Video });
  await sut.replaceAll(asset.id, recipe);
  const version = (await sut.getRequestedVideoVersion(asset.id))!;
  const output = rendered(asset.id, version.id);
  await sut.publishVideoVersion(version, output);
  const legacy = `/legacy/${asset.id}_edited.mp4`;
  await db
    .insertInto('asset_file')
    .values({ assetId: legacyAsset.id, type: AssetFileType.EncodedVideo, path: legacy, isEdited: true })
    .execute();
  const candidates = [
    output.masterPath,
    `${output.masterPath}.lineage.json`,
    output.files[0].path,
    `${legacy}.lineage.json`,
    '/unrelated/untracked.mp4',
  ];
  const tracked = await new IntegrityRepository(db).getDevelopRevisionPathsByPaths(candidates);
  expect(tracked.map(({ path }) => path).toSorted()).toEqual(candidates.slice(0, 4).toSorted());
});
