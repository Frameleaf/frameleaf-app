import { getAlbumInfo, getAlbumTree, LibraryViewScope } from '@frameleaf/sdk';
import { albumSearchContext } from '$lib/frameleaf/search-context';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);

  depends('album:data');

  // The tree carries the album's collection for the breadcrumb, a collection's own albums
  // for the strip above its photos, and the collections a new album may be created in
  // (FL-52's GET /albums/tree; the Albums page loads the same thing under the same key).
  // The server reads one workspace at a time (no scope means Library), so both are loaded: a Boards
  // collection shows the Boards tree (FL-670), and an album holding albums of either is never "empty".
  const [album, personalTree, designTree] = await Promise.all([
    getAlbumInfo({ id: params.albumId }),
    getAlbumTree({}),
    getAlbumTree({ libraryScope: LibraryViewScope.Design }),
  ]);

  return {
    album,
    // The workspace the page shows: the URL's, else the album's own (as `albumSearchContext` decides).
    tree: albumSearchContext(url, album).filter.libraryScope === LibraryViewScope.Design ? designTree : personalTree,
    workspaceTrees: [personalTree, designTree],
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
