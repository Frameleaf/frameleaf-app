import { getAlbumTree, getPartners, PartnerDirection } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  depends('spaces:data');
  const [tree, partners] = await Promise.all([getAlbumTree(), getPartners({ direction: PartnerDirection.SharedWith })]);
  const $t = await getFormatter();

  return {
    spaces: tree.spaces,
    partners,
    meta: {
      title: $t('frameleaf_spaces_title'),
    },
  };
}) satisfies PageLoad;
