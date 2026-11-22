import { CONTENT_TABLES, frozenSource } from 'src/immich-import/adapters.js';
import frozen from 'src/immich-import/fixtures/frozen-sources.json' with { type: 'json' };
import { GALLERY_READS, withGalleryContent } from 'src/immich-import/gallery.js';
import { type SourceStructure, verifyReadableStructure } from 'src/immich-import/schema.js';
import { NOODLE_ONLY, OTHERS_FAVOURITES } from 'src/immich-import/source.js';

const column = { type: 'uuid', not_null: true, default: null, identity: '', generated: '' };
const GALLERY: Record<string, string[]> = {
  shared_space: ['id', 'name', 'description', 'createdById', 'createdAt', 'updatedAt'],
  shared_space_member: ['spaceId', 'userId', 'role', 'joinedAt'],
  shared_space_asset: ['spaceId', 'assetId', 'addedAt'],
  shared_space_person: ['id', 'spaceId', 'name', 'isHidden', 'type'],
  shared_space_person_face: ['personId', 'assetFaceId'],
  asset_favorite: ['userId', 'assetId', 'createdAt'],
  person_pet: ['personGroupId', 'species'],
};
const structure = (version: string, added: Record<string, string[]>): SourceStructure => {
  const base = frozenSource(version).structure;
  const tables = { ...base.tables };
  for (const [table, columns] of Object.entries(added)) {
    tables[table] = { ...tables[table], ...Object.fromEntries(columns.map((name) => [name, column])) };
  }
  return { ...base, tables };
};
const reads = (version: string, added: Record<string, string[]>) => {
  const source = withGalleryContent(frozenSource(version), structure(version, added));
  return { source, names: Object.keys(source.tables).filter((table) => table.startsWith('gallery_')) };
};

// FL-1742: Manager counts the source before the import starts, through its own copy of these reads
// (manager/src/gallery-reads.ts; Manager is a separate package). Loaded by path, so neither package depends on the other.
const managerReads = async (): Promise<{
  GALLERY_READS: readonly string[];
  GALLERY_ONLY: Record<string, { name: string; carriedBy?: string }>;
  OTHERS_FAVOURITES: string;
  OTHERS_FAVOURITES_NAME: string;
  galleryReads: (has: (table: string, ...columns: string[]) => boolean) => Record<string, string>;
}> => import(new URL('../../../manager/src/gallery-reads.ts', import.meta.url).href);
const managerRequired = async (): Promise<{
  galleryColumnType: (table: string, column: string, type: string) => string;
  galleryRequiredColumns: (ledger: readonly string[]) => Record<string, Record<string, string>> | undefined;
}> => import(new URL('../../../manager/src/gallery-required.ts', import.meta.url).href);
const sql = (text: string) => text.replaceAll(/\s+/gu, ' ').trim();

describe('Manager’s copy of the Noodle Gallery reads', () => {
  it.each([
    ['the 5.11 tables', '3.2.4', GALLERY],
    ['pets kept in person.type', '3.2.4', { ...GALLERY, person_pet: [], person: ['type', 'species'] }],
    ['a base older than person groups', '2.7.5', { ...GALLERY, person: ['type', 'species'] }],
    ['Spaces that cannot be read', '3.2.4', { ...GALLERY, shared_space_asset: ['spaceId', 'assetId'] }],
    ['no Gallery tables', '3.2.4', {}],
  ])('reads %s with the SELECTs the importer runs', async (_, version, added) => {
    const { galleryReads } = await managerReads();
    const shape = structure(version, added);
    const { source, names } = reads(version, added);
    const copy = galleryReads((table, ...columns) => columns.every((column) => shape.tables[table]?.[column]));
    expect(Object.keys(copy).toSorted()).toEqual(names.toSorted());
    for (const name of names) {
      expect(sql(copy[name])).toBe(sql(source.views[name]));
    }
  });

  it('names what stays behind as the importer does', async () => {
    const manager = await managerReads();
    expect(manager.GALLERY_READS).toEqual(GALLERY_READS);
    expect(manager.GALLERY_ONLY).toEqual(NOODLE_ONLY);
    expect(sql(manager.OTHERS_FAVOURITES)).toBe(sql(OTHERS_FAVOURITES));
    expect(manager.OTHERS_FAVOURITES_NAME).toBe('favourites set by other people');
  });

  // FL-1752: Manager refuses before it stops Gallery, so it must require exactly what the importer does.
  it.each(Object.keys(frozen.versions))('requires the importer’s columns for %s', async (version) => {
    const { galleryColumnType, galleryRequiredColumns } = await managerRequired();
    const source = frozenSource(version);
    const expected = Object.fromEntries(
      CONTENT_TABLES.filter((table) => source.tables[table]).map((table) => [
        table,
        Object.fromEntries(
          Object.entries(source.structure.tables[table] ?? {}).map(([name, { type }]) => [
            name,
            galleryColumnType(table, name, type),
          ]),
        ),
      ]),
    );
    expect(galleryRequiredColumns(source.migrations)).toEqual(expected);
    expect(() => verifyReadableStructure(source.structure, source)).not.toThrow();
  });

  it('has no required columns for a ledger the importer does not recognise', async () => {
    const { galleryRequiredColumns } = await managerRequired();
    expect(galleryRequiredColumns([])).toBeUndefined();
  });
});

describe('Noodle Gallery reads', () => {
  it('offers every read for the 5.11 tables, keyed for keyset paging', () => {
    const { source, names } = reads('3.2.4', GALLERY);
    expect(names.toSorted()).toEqual([
      'gallery_favorite',
      'gallery_pet',
      'gallery_space',
      'gallery_space_asset',
      'gallery_space_member',
      'gallery_space_person',
    ]);
    for (const name of names) {
      expect(source.tables[name].key.length).toBeGreaterThan(0);
      expect(source.views[name]).toMatch(/^(SELECT|WITH) /u);
    }
    expect(source.views.gallery_pet).toContain('public.person_pet');
    expect(source.views.gallery_space_person).toContain(`p.type = 'person'`);
    // Standard tables keep their own shapes.
    expect(source.tables.album).toEqual(frozenSource('3.2.4').tables.album);
  });

  it('offers nothing for a source without Gallery tables', () => {
    expect(reads('3.2.4', {}).names).toEqual([]);
  });

  it('leaves Spaces and their people behind when a column the read needs is missing', () => {
    const { names } = reads('3.2.4', { ...GALLERY, shared_space_asset: ['spaceId', 'assetId'] });
    expect(names.toSorted()).toEqual(['gallery_favorite', 'gallery_pet']);
  });

  it('reads pets from person.type before the person_pet table existed', () => {
    const { person_pet: _, ...older } = GALLERY;
    const { source } = reads('3.2.4', { ...older, person: ['type', 'species'] });
    expect(source.views.gallery_pet).toContain(`n.type = 'pet'`);
    expect(source.views.gallery_pet).not.toContain('person_pet');
  });

  it('follows a face to its person on a base older than person groups', () => {
    const { source } = reads('2.7.5', { ...GALLERY, person: ['type', 'species'] });
    expect(source.views.gallery_space_person).toContain('n.id = f."personId"');
    expect(source.views.gallery_pet).toContain('n.id AS "personGroupId"');
  });
});
