import {
  AlbumKind,
  getAlbumInfo,
  getAlbumTree,
  getSharedSpaceActivity,
  getSharedSpaceAlbums,
  getSharedSpaceMembers,
  getSharedSpaceNew,
  getSharedSpacePeople,
  isHttpError,
} from '@immich/sdk';
import { error } from '@sveltejs/kit';
import { isSpaceUnavailableStatus } from '$lib/frameleaf/error-page';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * One shared space (FL-55). The space itself is an album, so it loads through
 * the album endpoints; `getSharedSpaceMembers` adds the invitations nobody has
 * answered, which are not memberships and so are not on the album. The tree
 * supplies the albums offered as sources for "add everything matching" and as
 * albums to link. A bulk "add to album" loads its own destinations.
 *
 * The panels' own data — linked albums, people and what is new since the
 * member's last visit — comes from the shared space endpoints, each of which
 * checks membership again. The timeline and the map fetch their own items
 * when they are opened, so a member who never opens them does not pay for them.
 *
 * The same page is the space's viewer (`/sharing/{spaceId}/photos/{assetId}`); the item itself is
 * loaded by the (user) layout, and nothing here depends on it, so moving through the viewer never
 * re-runs this loader.
 *
 * An address that is not a shared space this person is in — an album, somebody else's space, one
 * they have left or one that was deleted — is refused by the server (400/403/404). That becomes a
 * plain 404 for the space's own error page, which explains it in words instead of showing the
 * server's message. Anything else (the server is down, a timeout) is left as it is, so the page can
 * offer to try again.
 */
const SPACE_UNAVAILABLE = { message: 'Shared space not available', code: 404 };

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);
  depends('space:data');

  // The activity feed's first page rides along so the Activity segment can carry its unread count
  // from the first paint; the panel itself pages older events on demand.
  const [space, { members }, tree, { albums: linkedAlbums }, people, newSince, activity] = await Promise.all([
    getAlbumInfo({ id: params.spaceId }),
    getSharedSpaceMembers({ id: params.spaceId }),
    getAlbumTree(),
    getSharedSpaceAlbums({ id: params.spaceId }),
    getSharedSpacePeople({ id: params.spaceId }),
    getSharedSpaceNew({ id: params.spaceId }),
    getSharedSpaceActivity({ id: params.spaceId }),
  ]).catch((error_: unknown) => {
    if (isHttpError(error_) && isSpaceUnavailableStatus(error_.status)) {
      error(404, SPACE_UNAVAILABLE);
    }
    throw error_;
  });

  if (space.kind !== AlbumKind.Space) {
    // A URL contract is not a licence to render the wrong thing: an album or a
    // collection has its own page.
    error(404, SPACE_UNAVAILABLE);
  }

  const $t = await getFormatter();

  return {
    space,
    members,
    albums: [...tree.albums, ...tree.collections.flatMap((collection) => collection.albums)],
    linkedAlbums,
    people,
    newSince,
    activity,
    meta: {
      title: space.albumName || $t('frameleaf_spaces_title'),
    },
  };
}) satisfies PageLoad;
