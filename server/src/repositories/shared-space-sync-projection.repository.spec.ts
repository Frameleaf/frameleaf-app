import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('validates covers on every read and adds publisher checks only for sync', async () => {
  const { db, queries } = scriptedKysely(() => ({ rows: [] }));
  const repository = new AlbumUserRepository(db);
  await repository.getLinkedPeople('space-id', true);
  expect(queries[0].sql).toContain('"asset"."deletedAt" is null');
  expect(queries[0].sql).toContain('"album_asset"."albumId" = "link"."albumId"');
  expect(queries[0].sql).toContain('"publisher"."deletedAt" is null');
  expect(queries[0].sql).toContain('asset_lock');
  expect(queries[0].sql).toContain('nsfw_asset.is_nsfw = true');
  await repository.getLinkedPeople('space-id');
  expect(queries[1].sql).not.toContain('publisher');
  expect(queries[1].sql).toContain('"album_asset"."albumId" = "link"."albumId"');
  expect(queries[1].sql).toContain('"asset"."deletedAt" is null');
});

it('hides sync references whose target owner is deleted without changing the public repository default', async () => {
  const { db, queries } = scriptedKysely(() => ({ rows: [] }));
  const repository = new AlbumUserRepository(db);
  await repository.getLinkedAlbums('space-id', true);
  expect(queries[0].sql).toContain('"targetUser"."deletedAt" is null');
  expect(queries[0].sql).toContain('"targetOwner"."role" =');
  await repository.getLinkedAlbums('space-id');
  expect(queries[1].sql).not.toContain('targetUser');
});
