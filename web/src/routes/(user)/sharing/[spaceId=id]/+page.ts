import { error } from '@sveltejs/kit';
import {
  AlbumKind,
  getAlbumInfo,
  getAlbumTree,
  getSharedSpaceAlbums,
  getSharedSpaceMembers,
  getSharedSpaceNew,
  getSharedSpacePeople,
} from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * One shared space (FL-55). The space itself is an album, so it loads through
 * the album endpoints; `getSharedSpaceMembers` adds the invitations nobody has
 * answered, which are not memberships and so are not on the album. The tree
 * supplies the albums offered as sources for "add everything matching" and as
 * albums to link, and the spaces a bulk "add to album" may target.
 *
 * The panels' own data — linked albums, people and what is new since the
 * member's last visit — comes from the shared space endpoints, each of which
 * checks membership again. The timeline and the map fetch their own items
 * when they are opened, so a member who never opens them does not pay for them.
 */
export const load = (async ({ params, url, depends }) => {
  await authenticate(url);
  depends('space:data');

  const [space, { members }, tree, { albums: linkedAlbums }, people, newSince] = await Promise.all([
    getAlbumInfo({ id: params.spaceId }),
    getSharedSpaceMembers({ id: params.spaceId }),
    getAlbumTree(),
    getSharedSpaceAlbums({ id: params.spaceId }),
    getSharedSpacePeople({ id: params.spaceId }),
    getSharedSpaceNew({ id: params.spaceId }),
  ]);

  if (space.kind !== AlbumKind.Space) {
    // A URL contract is not a licence to render the wrong thing: an album or a
    // collection has its own page.
    error(404, 'Shared space not found');
  }

  const $t = await getFormatter();

  return {
    space,
    members,
    albums: [...tree.albums, ...tree.collections.flatMap((collection) => collection.albums)],
    spaces: tree.spaces,
    linkedAlbums,
    people,
    newSince,
    meta: {
      title: space.albumName || $t('frameleaf_spaces_title'),
    },
  };
}) satisfies PageLoad;
