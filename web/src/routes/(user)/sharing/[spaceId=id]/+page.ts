import { error } from '@sveltejs/kit';
import { AlbumKind, getAlbumInfo, getAlbumTree, getSharedSpaceMembers } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * One shared space (FL-55). The space itself is an album, so it loads through
 * the album endpoints; `getSharedSpaceMembers` adds the invitations nobody has
 * answered, which are not memberships and so are not on the album. The tree
 * supplies the albums offered as sources for "add everything matching".
 */
export const load = (async ({ params, url, depends }) => {
  await authenticate(url);
  depends('space:data');

  const [space, { members }, tree] = await Promise.all([
    getAlbumInfo({ id: params.spaceId }),
    getSharedSpaceMembers({ id: params.spaceId }),
    getAlbumTree(),
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
    meta: {
      title: space.albumName || $t('frameleaf_spaces_title'),
    },
  };
}) satisfies PageLoad;
