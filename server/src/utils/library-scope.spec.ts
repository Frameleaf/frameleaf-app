import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { mapAlbum } from 'src/dtos/album.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { LibraryScope } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { searchAssetBuilder, searchAssetBuilderLegacy } from 'src/utils/database.js';
import { libraryScopePredicate, scopeMatches } from 'src/utils/library-scope.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAlbum, getForAsset } from 'test/mappers.js';

const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('shared library scope', () => {
  it.each([
    [LibraryScope.Personal, LibraryScope.Personal, true],
    [LibraryScope.Personal, LibraryScope.Design, false],
    [LibraryScope.Design, LibraryScope.Personal, false],
    [LibraryScope.Design, LibraryScope.Design, true],
    [LibraryScope.Both, LibraryScope.Personal, true],
    [LibraryScope.Both, LibraryScope.Design, true],
  ] as const)('%s in %s is %s', (record, view, matches) => {
    expect(scopeMatches(record, view)).toBe(matches);
  });

  it('binds view values and qualifies the column for joined queries', () => {
    const query = db
      .selectFrom('asset as candidate')
      .where(libraryScopePredicate(LibraryScope.Design, 'candidate'))
      .compile();
    expect(query.sql).toContain('"candidate"."libraryScope" in ($1, $2)');
    expect(query.parameters).toEqual(['design', 'both']);
  });

  it.each([LibraryScope.Personal, LibraryScope.Design] as const)(
    'narrows search by %s without dropping owner or Locked rules',
    (libraryScope) => {
      const query = searchAssetBuilder(db, { libraryScope, userIds: ['owner'] }).compile();
      expect(query.sql).toContain('"asset"."libraryScope"');
      expect(query.parameters).toContain(libraryScope);
      expect(query.parameters).toContain('both');
      expect(query.sql).toContain('"asset"."ownerId"');
      expect(query.sql).toContain('asset_lock');
    },
  );

  it('defaults both search contracts to personal', () => {
    for (const query of [searchAssetBuilder(db, {}).compile(), searchAssetBuilderLegacy(db, {}).compile()]) {
      expect(query.sql).toContain('"asset"."libraryScope"');
      expect(query.parameters).toContain('personal');
      expect(query.parameters).toContain('both');
    }
  });

  it('preserves explicit album membership unless the caller requests a workspace', () => {
    const filter = { albumIds: { any: ['album'] } };
    expect(searchAssetBuilder(db, { filter }).compile().sql).not.toContain('"libraryScope"');
    expect(searchAssetBuilderLegacy(db, { albumIds: ['album'] }).compile().sql).not.toContain('"libraryScope"');
    expect(searchAssetBuilder(db, { filter, libraryScope: LibraryScope.Design }).compile().sql).toContain(
      '"libraryScope"',
    );
  });
});

it('exposes scope from the existing asset and album identities', () => {
  expect(mapAsset(getForAsset(AssetFactory.create({ libraryScope: LibraryScope.Design }))).libraryScope).toBe(
    LibraryScope.Design,
  );
  expect(mapAlbum(getForAlbum(AlbumFactory.create({ libraryScope: LibraryScope.Both }))).libraryScope).toBe(
    LibraryScope.Both,
  );
});
