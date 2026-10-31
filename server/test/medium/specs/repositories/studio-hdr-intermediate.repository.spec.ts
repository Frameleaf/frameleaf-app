import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { AssetType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-97: the Studio HDR intermediate is a canonical derived record (public.studio_hdr_intermediate), never
 * an asset_file row. It is served only while it matches the original as it is now, with no
 * edit published over it; it goes with its asset, is swept when stale, orphaned or unused, is
 * tracked by the integrity checks and FileDelete, and never replaces an original.
 */
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
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const sut = new AssetRepository(db);
  const path = `/data/encoded-video/${asset.id}-studio-hdr.mp4`;
  const fingerprint = (await sut.getStudioHdrSourceFingerprint(asset.id))!;
  const record = (
    overrides: Partial<{ ownerId: string; sourceFingerprint: Buffer; path: string; status: 'ready' | 'failed' }> = {},
  ) =>
    sut.recordStudioHdrIntermediate({
      assetId: asset.id,
      ownerId: user.id,
      sourceFingerprint: fingerprint,
      status: 'ready',
      path,
      ...overrides,
    });
  const rows = async () =>
    (
      await sql<{
        status: string;
      }>`SELECT status FROM public.studio_hdr_intermediate WHERE "assetId"=${asset.id}::uuid`.execute(db)
    ).rows;
  return { asset, user, ctx, sut, path, fingerprint, record, rows };
};

it('is recorded against the original it was made from and served while that original is current', async () => {
  const { asset, sut, path, record } = await setup();

  await expect(record()).resolves.toEqual({ recorded: true });
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map([[asset.id, path]]));

  // The original is replaced: the intermediate is no longer current, and one made from the old
  // original is refused.
  await db
    .updateTable('asset')
    .set({ checksum: randomBytes(32) })
    .where('id', '=', asset.id)
    .execute();
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map());
  await expect(record()).resolves.toEqual({ recorded: false });
});

it('surfaces a missing canonical intermediate table instead of reporting no derived media', async () => {
  const { asset, sut, path, record } = await setup();
  await record();
  await sql`ALTER TABLE public.studio_hdr_intermediate RENAME TO studio_hdr_intermediate_unavailable`.execute(db);
  try {
    await expect(sut.getStudioHdrIntermediateStates([asset.id])).rejects.toMatchObject({ code: '42P01' });
    await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).rejects.toMatchObject({ code: '42P01' });
  } finally {
    await sql`ALTER TABLE public.studio_hdr_intermediate_unavailable RENAME TO studio_hdr_intermediate`.execute(db);
  }
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map([[asset.id, path]]));
});

it('refuses removal before enumerating or queuing files when the canonical intermediate table is missing', async () => {
  const { asset, user, sut, path, record, rows } = await setup();
  await record();
  const files = vi.fn(() => [asset.originalPath, path]);
  const queue = vi.fn(() => Promise.resolve());
  await sql`ALTER TABLE public.studio_hdr_intermediate RENAME TO studio_hdr_intermediate_unavailable`.execute(db);
  try {
    await expect(sut.remove({ id: asset.id }, { files, queue })).rejects.toMatchObject({ code: '42P01' });
    expect(files).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    await expect(
      db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      ownerId: user.id,
      originalPath: asset.originalPath,
      checksum: asset.checksum,
    });
  } finally {
    await sql`ALTER TABLE public.studio_hdr_intermediate_unavailable RENAME TO studio_hdr_intermediate`.execute(db);
  }
  await expect(rows()).resolves.toEqual([{ status: 'ready' }]);
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map([[asset.id, path]]));
});

it('notices an external-library file rewritten in place (same path checksum, new modification time)', async () => {
  const { asset, sut, record } = await setup();
  await record();
  await db
    .updateTable('asset')
    .set({ fileModifiedAt: new Date(Date.now() + 60_000) })
    .where('id', '=', asset.id)
    .execute();
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map());
  const [state] = await sut.getStudioHdrIntermediateStates([asset.id]);
  expect(state).toMatchObject({ current: false, status: 'ready' });
});

it('is never current once an edit is published over the original', async () => {
  const { asset, sut, record } = await setup();
  await record();
  await db
    .insertInto('asset_file')
    .values({ assetId: asset.id, type: 'encoded_video' as any, path: `/edited/${asset.id}.mp4`, isEdited: true })
    .execute();
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map());
  const [state] = await sut.getStudioHdrIntermediateStates([asset.id]);
  expect(state).toMatchObject({ edited: true });
});

it('keeps a refusal for the same original, and reports an intermediate it replaced', async () => {
  const { asset, sut, path, record } = await setup();
  await record({ path: '/data/encoded-video/old/studio-hdr.mp4' });
  await expect(record()).resolves.toEqual({ recorded: true, replacedPath: '/data/encoded-video/old/studio-hdr.mp4' });
  await expect(record({ status: 'failed' })).resolves.toEqual({ recorded: true, replacedPath: path });
  const [state] = await sut.getStudioHdrIntermediateStates([asset.id]);
  expect(state).toMatchObject({ current: true, status: 'failed', path: null });
  await expect(sut.getCurrentStudioHdrIntermediates([asset.id])).resolves.toEqual(new Map());
});

it('is tracked by the integrity checks, so the untracked-file report never offers it', async () => {
  const { path, record } = await setup();
  await record();
  const tracked = await new IntegrityRepository(db).getTrackedPaths([path, '/data/encoded-video/stray.mp4']);
  expect(tracked.map(({ path }) => path)).toEqual([path]);
});

it('counts as a reference for FileDelete while its row exists', async () => {
  const { path, record } = await setup();
  await record();
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM public.studio_hdr_intermediate intermediate WHERE intermediate.path = ${path}
  `.execute(db);
  expect(rows[0].count).toBe(1);
});

it('goes with its asset, and its file is released with the asset', async () => {
  const { asset, sut, path, record, rows } = await setup();
  await record();
  const removed = await sut.remove({ id: asset.id });
  expect(removed?.derivedPaths).toContain(path);
  await expect(rows()).resolves.toEqual([]);
});

it('sweeps an intermediate whose original changed or that an edit now covers', async () => {
  const changed = await setup();
  await changed.record();
  await db
    .updateTable('asset')
    .set({ checksum: randomBytes(32) })
    .where('id', '=', changed.asset.id)
    .execute();
  const edited = await setup();
  await edited.record();
  await db
    .insertInto('asset_file')
    .values({
      assetId: edited.asset.id,
      type: 'encoded_video' as any,
      path: `/edited/${edited.asset.id}.mp4`,
      isEdited: true,
    })
    .execute();
  const kept = await setup();
  await kept.record();

  const released = await kept.sut.releaseStudioHdrIntermediates();
  expect(released).toEqual(expect.arrayContaining([changed.path, edited.path]));
  expect(released).not.toContain(kept.path);
  await expect(changed.rows()).resolves.toEqual([]);
  await expect(edited.rows()).resolves.toEqual([]);
  await expect(kept.rows()).resolves.toEqual([{ status: 'ready' }]);
});

it('keeps what projects use and sweeps what none used for 30 days', async () => {
  const { asset, sut, path, record, rows } = await setup();
  await record();
  await sql`UPDATE public.studio_hdr_intermediate SET "lastUsedAt" = now() - interval '29 days'
    WHERE "assetId"=${asset.id}::uuid`.execute(db);
  await sut.touchStudioHdrIntermediates([asset.id]);
  await expect(sut.releaseStudioHdrIntermediates()).resolves.not.toContain(path);

  await sql`UPDATE public.studio_hdr_intermediate SET "lastUsedAt" = now() - interval '31 days'
    WHERE "assetId"=${asset.id}::uuid`.execute(db);
  await expect(sut.releaseStudioHdrIntermediates()).resolves.toContain(path);
  await expect(rows()).resolves.toEqual([]);
});

it('releases a derived row whose original asset is gone', async () => {
  const { asset, record, path, sut } = await setup();
  await record();
  await db.deleteFrom('asset').where('id', '=', asset.id).execute();
  await expect(sut.releaseStudioHdrIntermediates()).resolves.toContain(path);
});
