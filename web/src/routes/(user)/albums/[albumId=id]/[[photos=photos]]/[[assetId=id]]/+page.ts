import { AlbumKind, getAlbumInfo, getSharedSpaceMembers, LibraryViewScope } from '@frameleaf/sdk';
import { loadAlbumTree } from '$lib/frameleaf/album-tree-cache';
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
    loadAlbumTree(),
    loadAlbumTree(LibraryViewScope.Design),
  ]);
  // A shared space's unanswered invitations are not album users, so the header asks for them to say
  // "1 invited" instead of "Private · share it". Not being able to read them only loses that line.
  const pendingInvites =
    album.kind === AlbumKind.Space
      ? await getSharedSpaceMembers({ id: album.id })
          .then(({ members }) => members.filter((member) => member.pending).length)
          .catch(() => 0)
      : 0;

  return {
    album,
    pendingInvites,
    workspaceTrees: [personalTree, designTree],
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
