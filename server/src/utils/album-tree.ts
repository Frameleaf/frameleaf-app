import { AlbumCollectionResponseDto, AlbumResponseDto, AlbumTreeResponseDto } from 'src/dtos/album.dto.js';
import { AlbumKind } from 'src/enum.js';

/**
 * Arrange the albums a user can see into the directory shape the Albums page
 * and the rail consume: collections with their albums, albums that stand on
 * their own, and shared spaces. The input order (display order from the
 * repository) is preserved inside every group.
 *
 * Rules, applied to whatever is stored:
 * - Every collection is a shelf, even one saved with a parent before the
 *   one-level rule existed; collections never render nested.
 * - An album belongs to a collection only when that collection is visible to
 *   the same user. An album whose parent is invisible (or is not a collection)
 *   stands on its own rather than disappearing.
 * - Shared spaces are always top level.
 */
export const buildAlbumTree = (albums: AlbumResponseDto[]): AlbumTreeResponseDto => {
  const collections = albums.filter((album) => album.kind === AlbumKind.Collection);
  const spaces = albums.filter((album) => album.kind === AlbumKind.Space);
  const collectionIds = new Set(collections.map(({ id }) => id));
  const plainAlbums = albums.filter((album) => album.kind === AlbumKind.Album);

  const shelves: AlbumCollectionResponseDto[] = collections.map((collection) => {
    const members = plainAlbums.filter((album) => album.parentId === collection.id);
    return {
      collection,
      albums: members,
      albumCount: members.length,
      assetCount: members.reduce((total, album) => total + album.assetCount, collection.assetCount),
    };
  });

  const standalone = plainAlbums.filter((album) => !(album.parentId && collectionIds.has(album.parentId)));

  return { collections: shelves, albums: standalone, spaces };
};
