import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GALLERY_STRUCTURE_SQL, galleryCountSql, importedGallery, readGalleryPreview } from '../src/gallery-preview.js';
import { galleryReads } from '../src/gallery-reads.js';
import { galleryReview, gallerySummary, type GalleryData } from '../ui/src/gallery-preview.js';

// FL-1742. Gallery 5.11 on an Immich 3.2 base: every read is offered.
const structure: Record<string, string[]> = {
  asset: ['id', 'ownerId', 'isFavorite'],
  asset_face: ['id', 'assetId', 'personId', 'personGroupId'],
  person: ['id', 'ownerId', 'name', 'birthDate', 'isHidden', 'isFavorite', 'personGroupId'],
  shared_space: ['id', 'name', 'description', 'createdById', 'createdAt', 'updatedAt'],
  shared_space_member: ['spaceId', 'userId', 'role', 'joinedAt'],
  shared_space_asset: ['spaceId', 'assetId', 'addedAt'],
  shared_space_person: ['id', 'spaceId', 'name', 'isHidden', 'type'],
  shared_space_person_face: ['personId', 'assetFaceId'],
  asset_favorite: ['userId', 'assetId', 'createdAt'],
  person_pet: ['personGroupId', 'species'],
  user_group: ['id', 'name'],
  shared_space_album: ['spaceId', 'albumId'],
  asset_video_trim: ['assetId'],
};
const answer = {
  spaces: 4, memberships: 18, members: 11, spacePhotos: 6120, people: 23, favourites: 1284, pets: 3,
  spaceList: [{ name: 'Family', members: 5, photos: 3410 }, { name: 'Soccer team', members: 6, photos: 250 }],
  held: { shared_space: true, shared_space_person: true, person_pet: true, user_group: true, shared_space_album: true, asset_video_trim: false, asset_favorite: true },
};
const source = (tables = structure, counts: Record<string, unknown> = answer) => {
  const statements: string[] = [];
  const sql = async (statement: string) => {
    statements.push(statement);
    return statement === GALLERY_STRUCTURE_SQL ? JSON.stringify(tables) : `SET\n${JSON.stringify(counts)}\n`;
  };
  return { sql, statements };
};

test('the review counts a running Noodle Gallery through the import’s own reads, and writes nothing', async () => {
  const { sql, statements } = source();
  const preview = await readGalleryPreview(sql);
  assert.deepEqual(preview, {
    readable: true,
    counts: { spaces: 4, members: 11, memberships: 18, spacePhotos: 6120, people: 23, favourites: 1284, pets: 3 },
    spaces: [{ name: 'Family', members: 5, photos: 3410 }, { name: 'Soccer team', members: 6, photos: 250 }],
    // Carried reads are not listed; user groups and linked albums have nowhere to go.
    notImported: ['albums linked to Spaces', 'user groups'],
  });
  assert.equal(statements.length, 2);
  const views = galleryReads((table, ...columns) => columns.every((column) => structure[table]?.includes(column)));
  assert.equal(Object.keys(views).length, 6);
  for (const view of Object.values(views)) assert.ok(statements[1].includes(`FROM (${view}) r`), view);
  // Each statement only reads, and the counting session refuses writes outright.
  assert.match(statements[0], /^SELECT /u);
  assert.match(statements[1], /^SET default_transaction_read_only = on;\nSELECT json_build_object\(/u);
  for (const statement of statements)
    assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY)\b/u);
});

test('a read this release cannot answer is left uncounted and named as staying behind', async () => {
  const { person_pet: _, shared_space_person_face: __, ...older } = structure;
  const preview = await readGalleryPreview(source({ ...older, person_pet: ['id'] }, { ...answer, people: null, pets: null }).sql);
  assert.equal(preview.counts.pets, null);
  assert.equal(preview.counts.people, null);
  assert.deepEqual(preview.notImported, ['people named in Spaces', 'albums linked to Spaces', 'pets', 'user groups']);
  const sql = galleryCountSql({ ...older, person_pet: ['id'] });
  assert.match(sql, /'pets', NULL/u);
  assert.match(sql, /'people', NULL/u);
  // A source with no Gallery tables asks for nothing but nulls.
  assert.match(galleryCountSql({}), /'spaces', NULL,\n  'memberships', NULL/u);
});

test('a release that dropped asset.isFavorite is one the importer refuses', async () => {
  const preview = await readGalleryPreview(source({ ...structure, asset: ['id', 'ownerId'] }).sql);
  assert.equal(preview.readable, false);
  const review = galleryReview(preview, 'v5.9.0');
  assert.equal(review.state, 'unreadable');
  assert.match(review.state === 'unreadable' ? review.detail : '', /^Release v5\.9\.0 keeps favourites in a way Manager doesn’t know\./u);
  assert.equal(gallerySummary(preview), null);
});

const full: GalleryData = {
  readable: true,
  counts: { spaces: 4, members: 11, memberships: 18, spacePhotos: 6120, people: 23, favourites: 1284, pets: 3 },
  spaces: [{ name: 'Family', members: 5, photos: 3410 }, { name: 'Solo', members: 1, photos: 1 }],
  notImported: ['libraries linked to Spaces', 'albums linked to Spaces', 'people shared between accounts', 'user groups', 'exposure, contrast, saturation and invert adjustments', 'video trims', 'clean-up review decisions'],
};

test('the review shows the real counts and names what stays behind', () => {
  const review = galleryReview(full, 'v5.11.1');
  assert.equal(review.state, 'full');
  if (review.state !== 'full') return;
  assert.deepEqual(review.carried.map(({ value, name, detail }) => [value, name, detail]), [
    [4, 'Spaces', '11 members · 6,120 photos'],
    [23, 'People named in Spaces', 'Their names stay on each Space’s photos'],
    [3, 'Pets', 'Named pets, with the photos they are in'],
    [1284, 'Favourites', 'Everyone keeps their own, on shared photos too'],
  ]);
  assert.equal(review.spacesTitle, 'The 4 Spaces');
  assert.deepEqual(review.spaces, [{ name: 'Family', detail: '5 members · 3,410 photos' }, { name: 'Solo', detail: '1 member · 1 photo' }]);
  assert.equal(review.moreSpaces, 2);
  assert.deepEqual(review.behind.map((item) => item.name), [
    'Albums and libraries linked to a Space', 'People shared between accounts', 'User groups', 'Edits made in Gallery', 'Clean-up decisions',
  ]);
  assert.deepEqual(review.leftOut, []);
  // Only what the source holds is named.
  const some = galleryReview({ ...full, notImported: ['user groups', 'something new'] }, 'v5.11.1');
  assert.deepEqual(some.state === 'full' && some.behind.map((item) => item.name), ['User groups', 'Something new']);
});

test('a Gallery with nothing of its own says so', () => {
  const counts = { spaces: 0, members: 0, memberships: 0, spacePhotos: 0, people: 0, favourites: 0, pets: 0 };
  const review = galleryReview({ readable: true, counts, spaces: [], notImported: [] }, 'v5.11.1');
  assert.deepEqual(review.state === 'plain' && review.title, 'Nothing extra to bring');
  assert.equal(gallerySummary({ counts, notImported: [] }), null);
  // Something that stays behind is still named.
  assert.equal(galleryReview({ readable: true, counts, spaces: [], notImported: ['user groups'] }, 'v5.11.1').state, 'full');
});

test('ready to switch and done repeat the counts; a part that could not be read is said plainly', () => {
  const ready = gallerySummary(full);
  assert.equal(ready?.carriedTitle, 'Also from Noodle Gallery');
  assert.deepEqual(ready?.carried.map(({ value, name }) => `${value} ${name}`), ['4 Spaces', '23 People named in Spaces', '3 Pets', '1,284 Favourites']);
  assert.equal(ready?.behindTitle, 'Stays behind');
  assert.equal(ready?.behind, 'Albums and libraries linked to a Space · People shared between accounts · User groups · Edits made in Gallery · Clean-up decisions');
  assert.equal(ready?.kept, null);

  const imported = importedGallery({
    status: 'activated', sourceKind: 'gallery',
    gallery: { ...full.counts, pets: null }, notImported: [...full.notImported, 'pets'],
  });
  assert.ok(imported);
  const done = gallerySummary(imported, true);
  assert.equal(done?.carriedTitle, 'Came across from Noodle Gallery');
  assert.deepEqual(done?.carried.map(({ name }) => name), ['Spaces', 'People named in Spaces', 'Favourites']);
  assert.deepEqual(done?.leftOut, [{
    kind: 'pets',
    title: 'Pets could not be read, so they were left out.',
    detail: 'Everything else came across. Their photos are in your library; name the pets again in Frameleaf.',
  }]);
  assert.equal(done?.behindTitle, 'Stayed behind');
  assert.match(done?.kept ?? '', /^Nothing was deleted at the source\./u);
  // Before the import the same gap is a warning, not a result.
  assert.match(gallerySummary(imported)?.leftOut[0].title ?? '', /^Pets can’t be read from this release, so they will be left out\.$/u);
});

test('only a Noodle Gallery report with counts is kept from the importer', () => {
  assert.equal(importedGallery({ status: 'activated' }), null);
  assert.equal(importedGallery({ status: 'activated', sourceKind: 'gallery' }), null);
  assert.equal(importedGallery(undefined), null);
  assert.deepEqual(importedGallery({ sourceKind: 'gallery', gallery: { spaces: 2, pets: '3', people: -1 }, notImported: ['user groups', 7] }), {
    counts: { spaces: 2, members: null, memberships: null, spacePhotos: null, people: null, favourites: null, pets: null },
    notImported: ['user groups'],
  });
});
