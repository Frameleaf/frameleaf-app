import { getAllTags } from '@immich/sdk';
import { error } from '@sveltejs/kit';
import { QueryParameter } from '$lib/constants';
import { tagPathExists } from '$lib/frameleaf/tag-tree';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  const tags = await getAllTags();
  const path = url.searchParams.get(QueryParameter.PATH) ?? '';

  // A tag that is gone, or suppressed while the session is locked (and so left out of the list),
  // gets the not-found page rather than an empty browser that hints something was there.
  if (!tagPathExists(tags, path)) {
    error(404, { message: 'Tag not found' });
  }

  return {
    path,
    tags,
    meta: {
      title: $t('tags'),
    },
  };
}) satisfies PageLoad;
