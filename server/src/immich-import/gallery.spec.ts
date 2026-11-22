import { frozenSource } from 'src/immich-import/adapters.js';
import { withGalleryContent } from 'src/immich-import/gallery.js';
import type { SourceStructure } from 'src/immich-import/schema.js';

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
