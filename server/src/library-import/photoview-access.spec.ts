import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/photoview/2.4.0-content.json' with { type: 'json' };
import { normalizePhotoviewAccess } from 'src/library-import/photoview-access.js';

const captured = Object.fromEntries(
  Object.entries(content.rows).map(([table, rows]) => [
    table,
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
      ),
    ),
  ]),
);
const fixture = () => ({
  users: [
    { id: 1n, admin: 1n },
    { id: 2n, admin: 0n },
    { id: 3n, admin: 0n },
  ],
  albums: [
    { id: 10n, parent_album_id: null as bigint | null },
    { id: 11n, parent_album_id: 10n },
  ],
  media: [{ id: 20n, album_id: 11n }],
  userAlbums: [{ user_id: 2n, album_id: 10n }],
  preferences: [{ user_id: 2n, media_id: 20n, favorite: 1n }],
});
describe('Photoview inherited access inventory', () => {
  it('matches independently captured application visibility and per-user favourites', () => {
    const result = normalizePhotoviewAccess({
      users: captured.users,
      albums: captured.albums,
      media: captured.media,
      userAlbums: captured.user_albums,
      preferences: captured.user_media_data,
    });
    for (const [name, count] of Object.entries(content.expected.counts)) {
      const user = captured.users.find((row) => row.username === `fixture_${name}`)!;
      expect(result.filter((row) => row.readerIds.includes(String(user.id)))).toHaveLength(count);
    }
    const shared = result.find((row) => row.id === content.expected.sharedMediaId)!;
    expect(shared.readerIds).toEqual(['2', '3']);
    expect(shared.favorites).toEqual([{ userId: '2', favorite: true }]);
    expect(shared).not.toHaveProperty('ownerId');
    expect(result.find((row) => row.id === content.expected.alicePrivateMediaId)!.readerIds).toEqual(['2']);
  });
  it('inherits directory grants, deduplicates overlapping grants and does not infer access from admin status', () => {
    const input = fixture();
    input.userAlbums.push({ user_id: 2n, album_id: 11n }, { user_id: 3n, album_id: 11n });
    expect(normalizePhotoviewAccess(input)).toEqual([
      { id: '20', albumId: '11', readerIds: ['2', '3'], favorites: [{ userId: '2', favorite: true }] },
    ]);
  });
  it('retains stale per-user preferences without using them to grant access', () => {
    const input = fixture();
    input.preferences.push({ user_id: 3n, media_id: 20n, favorite: 0n });
    expect(normalizePhotoviewAccess(input)[0]).toMatchObject({
      readerIds: ['2'],
      favorites: [
        { userId: '2', favorite: true },
        { userId: '3', favorite: false },
      ],
    });
  });
  it('handles arbitrary source ordering without dropping unassigned media', () => {
    const input = fixture();
    input.albums.reverse();
    input.userAlbums = [];
    expect(normalizePhotoviewAccess(input)[0].readerIds).toEqual([]);
  });
  it.each(['users', 'albums', 'media', 'userAlbums', 'preferences'] as const)(
    'refuses duplicate %s records',
    (table) => {
      const input = fixture();
      (input[table] as unknown[]).push(input[table][0]);
      expect(() => normalizePhotoviewAccess(input)).toThrow('PHOTOVIEW_ACCESS_INVALID');
    },
  );
  it('refuses dangling references in every relationship', () => {
    const mutations = [
      (input: ReturnType<typeof fixture>) => {
        input.albums[0].parent_album_id = 99n;
      },
      (input: ReturnType<typeof fixture>) => {
        input.media[0].album_id = 99n;
      },
      (input: ReturnType<typeof fixture>) => {
        input.userAlbums[0].user_id = 99n;
      },
      (input: ReturnType<typeof fixture>) => {
        input.userAlbums[0].album_id = 99n;
      },
      (input: ReturnType<typeof fixture>) => {
        input.preferences[0].user_id = 99n;
      },
      (input: ReturnType<typeof fixture>) => {
        input.preferences[0].media_id = 99n;
      },
    ];
    for (const mutate of mutations) {
      const input = fixture();
      mutate(input);
      expect(() => normalizePhotoviewAccess(input)).toThrow('PHOTOVIEW_ACCESS_INVALID');
    }
  });
  it('refuses self and multi-directory cycles, even without assigned media', () => {
    for (const parent of [10n, 11n]) {
      const input = fixture();
      input.albums[0].parent_album_id = parent;
      input.media = [];
      expect(() => normalizePhotoviewAccess(input)).toThrow('PHOTOVIEW_ACCESS_INVALID');
    }
  });
  it('rejects malformed identities and preferences without disclosing raw input', () => {
    const input = fixture();
    input.preferences[0].favorite = 2n;
    expect(() => normalizePhotoviewAccess(input)).toThrow(/^Photoview source refused: PHOTOVIEW_ACCESS_INVALID$/);
    expect(() => normalizePhotoviewAccess({ ...fixture(), users: [{ id: 0n }] })).toThrow('PHOTOVIEW_ACCESS_INVALID');
  });
});
