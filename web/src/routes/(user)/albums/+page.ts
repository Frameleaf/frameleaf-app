import { getAlbumTree } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  depends('album:data');
  const tree = await getAlbumTree();
  const $t = await getFormatter();

  return {
    tree,
    meta: {
      title: $t('albums'),
    },
  };
}) satisfies PageLoad;
