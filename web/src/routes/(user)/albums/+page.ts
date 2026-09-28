import { getAlbumTree, getSharedSpaceInvitations } from '@immich/sdk';
import { pendingInvitations } from '$lib/frameleaf/shared-space';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  depends('album:data');
  // Invitations are not memberships, so they are not in the tree; the spaces shelf only says how
  // many are waiting. The shelf is still worth showing without that count, so its failure is quiet.
  const [tree, invitations] = await Promise.all([getAlbumTree(), getSharedSpaceInvitations().catch(() => [])]);
  const $t = await getFormatter();

  return {
    tree,
    spaceInvitations: pendingInvitations(invitations).length,
    meta: {
      title: $t('albums'),
    },
  };
}) satisfies PageLoad;
