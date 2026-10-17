import { SearchFilter } from 'src/dtos/search.dto.js';
import { searchAssetBuilder } from 'src/utils/database.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each(['albumIds', 'personIds', 'petIds', 'tagIds', 'landmarkIds'] as const)(
  'keeps absent %s distinct from an invalid null filter',
  async (field) => {
    const { db } = scriptedKysely();
    const compile = (filter: SearchFilter) => searchAssetBuilder(db, { filter }).select('asset.id').compile();
    try {
      expect(compile({ [field]: undefined })).toEqual(compile({}));
      const invalid: SearchFilter = {};
      Reflect.set(invalid, field, null);
      expect(() => compile(invalid)).toThrow(TypeError);
    } finally {
      await db.destroy();
    }
  },
);

it.each([
  'id',
  'libraryId',
  'type',
  'city',
  'state',
  'country',
  'make',
  'model',
  'lensModel',
  'description',
  'rating',
  'fileSizeInBytes',
  'takenAt',
  'localDateTime',
  'createdAt',
  'updatedAt',
  'trashedAt',
  'checksum',
] as const)('keeps empty %s comparisons equivalent to no filter', async (field) => {
  const { db } = scriptedKysely();
  const compile = (filter: SearchFilter) => searchAssetBuilder(db, { filter }).select('asset.id').compile();
  try {
    expect(compile({ [field]: {} })).toEqual(compile({}));
    const invalid: SearchFilter = {};
    Reflect.set(invalid, field, null);
    expect(() => compile(invalid)).toThrow(TypeError);
  } finally {
    await db.destroy();
  }
});

it.each([
  { field: 'isEncoded', table: 'asset_file' },
  { field: 'hasAlbums', table: 'album_asset' },
  { field: 'hasPeople', table: 'asset_face' },
  { field: 'hasTags', table: 'tag_asset' },
] as const)('retains positive and negative $field subqueries', async ({ field, table }) => {
  const { db } = scriptedKysely();
  try {
    for (const eq of [true, false]) {
      const query = searchAssetBuilder(db, { filter: { [field]: { eq } } })
        .select('asset.id')
        .compile();
      expect(query.sql).toContain(`${eq ? '' : 'not '}exists (select from "${table}"`);
      if (field === 'hasPeople') {
        expect(query.sql).toContain('"asset_face"."deletedAt" is null');
        expect(query.sql).toContain('"asset_face"."isVisible" =');
      }
    }
  } finally {
    await db.destroy();
  }
});
