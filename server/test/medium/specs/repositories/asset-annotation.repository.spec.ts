import { Kysely } from 'kysely';
import { AlbumUserRole, AssetType, LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetAnnotationRepository } from 'src/repositories/asset-annotation.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetAnnotationService } from 'src/services/asset-annotation.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const items = [
  { id: 'a1', kind: 'rect' as const, geometry: { x: 0.045, y: 0.27, width: 0.45, height: 0.2 }, note: 'Headline' },
  { id: 'a2', kind: 'arrow' as const, geometry: { x: 0.36, y: 0.66, endX: 0.2, endY: 0.56 } },
  { id: 'a3', kind: 'text' as const, geometry: { x: 0.44, y: 0.93 }, text: 'v2', origin: 'eagle' as const },
];
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const repo = new AssetAnnotationRepository(db);
  const service = new AssetAnnotationService(repo, new AccessRepository(db));
  return { ctx, repo, service };
};

it('stores one document beside the picture without touching the asset, its file or its edits', async () => {
  const { ctx, repo, service } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design, type: AssetType.Image });
  const before = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();

  const saved = await service.replace({ user }, asset.id, { version: 1, items });
  expect(saved).toMatchObject({ version: 1, items, canEdit: true, sourceChanged: false });
  expect(saved.updatedAt).not.toBeNull();
  await expect(service.get({ user }, asset.id)).resolves.toEqual(saved);

  const after = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
  expect(after).toEqual(before);
  const edits = await db.selectFrom('asset_edit').select('id').where('assetId', '=', asset.id).execute();
  expect(edits).toEqual([]);

  // replacing keeps one row; an empty list removes it
  await service.replace({ user }, asset.id, { version: 1, items: items.slice(1) });
  expect((await repo.get(asset.id))?.items.map(({ id }) => id)).toEqual(['a2', 'a3']);
  await expect(service.replace({ user }, asset.id, { version: 1, items: [] })).resolves.toMatchObject({ items: [] });
  expect(await db.selectFrom('asset_annotation').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
});

it('marks annotations as drawn on an older picture after an edit, not after a note or rating', async () => {
  const { ctx, service } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Both });
  await service.replace({ user }, asset.id, { version: 1, items });
  await ctx.newExif({ assetId: asset.id, description: 'A new note', rating: 4 });
  await expect(service.get({ user }, asset.id)).resolves.toMatchObject({ sourceChanged: false });
  await ctx.newEdits(asset.id, { edits: [{ action: 'rotate', parameters: { angle: 90 } }] } as never);
  await expect(service.get({ user }, asset.id)).resolves.toMatchObject({ sourceChanged: true, items });
});

it('lets album members read but only the owner write, and goes with the picture', async () => {
  const { ctx, service } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id, libraryScope: LibraryScope.Design });
  const { album } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Hero', libraryScope: LibraryScope.Design }, [
    asset.id,
  ]);
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });
  await service.replace({ user: owner }, asset.id, { version: 1, items });

  await expect(service.get({ user: member }, asset.id)).resolves.toMatchObject({ items, canEdit: false });
  await expect(service.replace({ user: member }, asset.id, { version: 1, items: [] })).rejects.toThrow();
  await expect(service.get({ user: owner }, asset.id)).resolves.toMatchObject({ items });
  const { user: stranger } = await ctx.newUser();
  await expect(service.get({ user: stranger }, asset.id)).rejects.toThrow();

  await db.deleteFrom('asset').where('id', '=', asset.id).execute();
  expect(await db.selectFrom('asset_annotation').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
});

it('puts Boards annotations in the library file, and leaves Photos-only pictures without them', async () => {
  const { ctx, service } = setup();
  const { user } = await ctx.newUser();
  const { asset: design } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const { asset: personal } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const { asset: plain } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const { asset: cropped } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  await service.replace({ user }, design.id, { version: 1, items });
  // drawn over the cropped picture: the archive holds the original, so these must not pass as matching it
  await ctx.newEdits(cropped.id, { edits: [{ action: 'rotate', parameters: { angle: 90 } }] } as never);
  await service.replace({ user }, cropped.id, { version: 1, items });
  await service.replace({ user }, personal.id, { version: 1, items });
  await db.updateTable('asset').set({ libraryScope: LibraryScope.Personal }).where('id', '=', personal.id).execute();

  const manifest = await new DownloadRepository(db).getLibraryManifest(
    { user },
    [
      { id: design.id, file: 'hero.png' },
      { id: personal.id, file: 'holiday.jpg' },
      { id: plain.id, file: 'logo.png' },
      { id: cropped.id, file: 'cropped.png' },
    ],
    [],
    false,
  );
  const byId = new Map(manifest.assets.map((row) => [row.id, row]));
  expect(byId.get(design.id)).toMatchObject({ annotations: items, annotationsMatchFile: true });
  expect(byId.get(cropped.id)).toMatchObject({ annotations: items, annotationsMatchFile: false });
  expect(byId.get(personal.id)).not.toHaveProperty('annotations');
  expect(byId.get(plain.id)).not.toHaveProperty('annotations');
  expect(byId.get(plain.id)).not.toHaveProperty('annotationsMatchFile');

  // annotations saved on the original stop matching once the picture is edited afterwards
  await ctx.newEdits(design.id, { edits: [{ action: 'rotate', parameters: { angle: 90 } }] } as never);
  const later = await new DownloadRepository(db).getLibraryManifest(
    { user },
    [{ id: design.id, file: 'hero.png' }],
    [],
    false,
  );
  expect(later.assets[0]).toMatchObject({ annotations: items, annotationsMatchFile: false });
  expect(JSON.stringify(manifest)).not.toContain('sourceRevision');
});
