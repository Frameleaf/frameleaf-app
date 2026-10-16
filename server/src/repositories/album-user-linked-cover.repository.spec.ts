import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each([false, true])('rechecks shared-space cover visibility in the read query, sync=%s', async (forSync) => {
  const { db, queries } = scriptedKysely();
  try {
    await new AlbumUserRepository(db).getLinkedPeople('space', forSync);
    expect(queries).toHaveLength(1);
    const query = queries[0].sql;
    expect(query).toContain('"asset"."id" = "link"."coverAssetId"');
    expect(query).toContain('"album_asset"."albumId" = "link"."albumId"');
    expect(query).toContain('"asset"."deletedAt" is null');
    expect(query).toContain('"asset"."visibility"');
    expect(query).toContain('asset_lock');
    expect(query).toContain('is_nsfw');
    expect(query).toContain('as "coverAssetId"');
  } finally {
    await db.destroy();
  }
});
