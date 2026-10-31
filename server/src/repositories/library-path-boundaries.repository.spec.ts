import { DummyValue } from 'src/decorators.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each([
  ['/mnt/photos', '/mnt/photos', '/mnt/photos/%'],
  ['/mnt/photos/', '/mnt/photos', '/mnt/photos/%'],
  ['/', '/', '/%'],
  [String.raw`/mnt/100%_done\album`, String.raw`/mnt/100%_done\album`, String.raw`/mnt/100\%\_done\\album/%`],
])('binds a literal folder and descendant prefix for %j', async (root, folder, prefix) => {
  const { db, queries } = scriptedKysely(() => ({ rows: [{ id: DummyValue.UUID_1 }] }));
  try {
    expect(
      await new AssetRepository(db).getExcludedExternalAssetIds(DummyValue.UUID, [DummyValue.UUID_1], [root], []),
    ).toEqual([DummyValue.UUID_1]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('not ("originalPath" = $5 or "originalPath" like $6)');
    expect(queries[0].parameters.slice(-2)).toEqual([folder, prefix]);
    expect(queries[0].sql).toContain('"libraryId" = $2::uuid');
    expect(queries[0].sql).toContain('"isOffline" = $3');
    expect(queries[0].sql).toContain('"isExternal" = $4');
  } finally {
    await db.destroy();
  }
});

it('skips an empty accepted page and refuses an oversized one before any query', async () => {
  const { db, queries } = scriptedKysely();
  try {
    const repository = new AssetRepository(db);
    expect(await repository.getExcludedExternalAssetIds(DummyValue.UUID, [], [], [])).toEqual([]);
    await expect(
      repository.getExcludedExternalAssetIds(
        DummyValue.UUID,
        Array.from({ length: 251 }, () => DummyValue.UUID_1),
        [],
        [],
      ),
    ).rejects.toThrow('limited to 250');
    expect(queries).toEqual([]);
  } finally {
    await db.destroy();
  }
});
