import { z } from 'zod';
import { PhotoviewRow } from 'src/library-import/photoview.js';

const id = z.bigint().positive();
const pair = z.object({ user_id: id, album_id: id });
const schema = z.object({
  users: z.array(z.object({ id })),
  albums: z.array(z.object({ id, parent_album_id: id.nullable() })),
  media: z.array(z.object({ id, album_id: id })),
  userAlbums: z.array(pair),
  preferences: z.array(z.object({ user_id: id, media_id: id, favorite: z.union([z.literal(0n), z.literal(1n)]) })),
});
const refuse = (): never => {
  throw new Error('Photoview source refused: PHOTOVIEW_ACCESS_INVALID');
};

/** Complete rows from one admitted snapshot; access and preferences never establish destination ownership. */
export const normalizePhotoviewAccess = (input: {
  users: PhotoviewRow[];
  albums: PhotoviewRow[];
  media: PhotoviewRow[];
  userAlbums: PhotoviewRow[];
  preferences: PhotoviewRow[];
}) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) refuse();
  const source = parsed.data!;
  const users = new Set(source.users.map((user) => user.id));
  const albums = new Map(source.albums.map((album) => [album.id, album]));
  const media = new Set(source.media.map((item) => item.id));
  if (users.size !== source.users.length || albums.size !== source.albums.length || media.size !== source.media.length)
    refuse();
  const grants = new Map<bigint, Set<bigint>>();
  for (const grant of source.userAlbums) {
    if (!users.has(grant.user_id) || !albums.has(grant.album_id)) refuse();
    const readers = grants.get(grant.album_id) ?? new Set<bigint>();
    if (readers.has(grant.user_id)) refuse();
    readers.add(grant.user_id);
    grants.set(grant.album_id, readers);
  }
  const inherited = new Map<bigint, Set<bigint>>();
  for (const album of source.albums) {
    const chain: bigint[] = [];
    const seen = new Set<bigint>();
    let current: bigint | null = album.id;
    while (current !== null && !inherited.has(current)) {
      if (seen.has(current) || !albums.has(current)) refuse();
      seen.add(current);
      chain.push(current);
      current = albums.get(current)!.parent_album_id;
    }
    let readers = current === null ? new Set<bigint>() : inherited.get(current)!;
    for (const albumId of chain.toReversed()) {
      readers = new Set([...readers, ...(grants.get(albumId) ?? [])]);
      inherited.set(albumId, readers);
    }
  }
  const favorites = new Map<bigint, Map<bigint, boolean>>();
  for (const preference of source.preferences) {
    if (!users.has(preference.user_id) || !media.has(preference.media_id)) refuse();
    const values = favorites.get(preference.media_id) ?? new Map<bigint, boolean>();
    if (values.has(preference.user_id)) refuse();
    values.set(preference.user_id, preference.favorite === 1n);
    favorites.set(preference.media_id, values);
  }
  return source.media.map((item) => {
    const readers = inherited.get(item.album_id);
    if (!readers) refuse();
    return {
      id: String(item.id),
      albumId: String(item.album_id),
      readerIds: source.users.filter((user) => readers!.has(user.id)).map((user) => String(user.id)),
      favorites: [...(favorites.get(item.id) ?? [])].map(([userId, favorite]) => ({
        userId: String(userId),
        favorite,
      })),
    };
  });
};
