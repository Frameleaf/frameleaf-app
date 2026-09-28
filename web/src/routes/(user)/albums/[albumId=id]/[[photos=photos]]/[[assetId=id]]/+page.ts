import { getAlbumInfo, getAlbumTree } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);

  depends('album:data');

  // The tree carries the album's collection for the breadcrumb, a collection's own albums
  // for the strip above its photos, and the collections a new album may be created in
  // (FL-52's GET /albums/tree; the Albums page loads the same thing under the same key).
  const [album, tree] = await Promise.all([getAlbumInfo({ id: params.albumId }), getAlbumTree()]);

  return {
    album,
    tree,
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
