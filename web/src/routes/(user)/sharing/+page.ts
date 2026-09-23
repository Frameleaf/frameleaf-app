import { getAlbumTree, getPartners, getSharedSpaceInvitations, PartnerDirection } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  depends('spaces:data');
  // Invitations are not memberships, so they are not in the tree: a shared
  // space the recipient has not accepted is reachable only as a preview.
  const [tree, partners, invitations] = await Promise.all([
    getAlbumTree(),
    getPartners({ direction: PartnerDirection.SharedWith }),
    getSharedSpaceInvitations(),
  ]);
  const $t = await getFormatter();

  return {
    spaces: tree.spaces,
    partners,
    invitations,
    meta: {
      title: $t('frameleaf_spaces_title'),
    },
  };
}) satisfies PageLoad;
