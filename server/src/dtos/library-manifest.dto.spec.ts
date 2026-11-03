import { LibraryManifestDto } from 'src/dtos/library-manifest.dto.js';
import { LibraryScope } from 'src/enum.js';

const root = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const asset = '33333333-3333-4333-8333-333333333333';
const manifest = () => ({
  version: 1,
  albums: [
    {
      id: root,
      parentId: null,
      albumName: 'Client',
      description: '',
      kind: 'collection',
      libraryScope: LibraryScope.Design,
    },
    {
      id: child,
      parentId: root,
      albumName: 'Packaging',
      description: '',
      kind: 'album',
      libraryScope: LibraryScope.Design,
    },
  ],
  tags: [],
  assets: [
    {
      id: asset,
      file: 'logo.png',
      checksum: { algorithm: 'sha1', value: '00'.repeat(20) },
      libraryScope: LibraryScope.Design,
      albumIds: [child],
      tagIds: [],
    },
  ],
  bookmarks: [],
});

it('round-trips nested logical records without inventing server paths or media copies', () => {
  const input = manifest();
  expect(LibraryManifestDto.schema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
});
it.each([
  '/private/logo.png',
  '../logo.png',
  'a/../../logo.png',
  String.raw`C:\private\logo.png`,
  String.raw`a\logo.png`,
])('rejects unsafe archive entry %s', (file) => {
  const input = manifest();
  input.assets[0].file = file;
  expect(LibraryManifestDto.schema.safeParse(input).success).toBe(false);
});
it('rejects dangling album memberships, duplicate identities, and parent cycles', () => {
  const dangling = manifest();
  dangling.assets[0].albumIds = [asset];
  expect(LibraryManifestDto.schema.safeParse(dangling).success).toBe(false);
  const duplicate = manifest();
  duplicate.albums.push({ ...duplicate.albums[0], parentId: root });
  expect(LibraryManifestDto.schema.safeParse(duplicate).success).toBe(false);
  const cyclic = manifest();
  cyclic.albums[0].parentId = child;
  expect(LibraryManifestDto.schema.safeParse(cyclic).success).toBe(false);
});
it('refuses unknown versions and unreviewed private fields', () => {
  expect(LibraryManifestDto.schema.safeParse({ ...manifest(), version: 2 }).success).toBe(false);
  expect(LibraryManifestDto.schema.safeParse({ ...manifest(), serverPath: '/private' }).success).toBe(false);
});
