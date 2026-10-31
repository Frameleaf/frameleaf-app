import { getAllTags, getTagStatistics } from '@frameleaf/sdk';
import { error } from '@sveltejs/kit';
import { QueryParameter } from '$lib/constants';
import { tagPathExists } from '$lib/frameleaf/tag-tree';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  // The tags page is always reachable by its address, whatever the rail shows (FL-46): the rail
  // honours the account's Tags preferences, the page and the server's access checks do not.
  // A tag's page needs the library grid and the viewer; the list of tags does not, so that code is
  // fetched here, alongside the data and only for a tag (FL-139). The page waits for both, as it
  // waits for the data, so nothing appears late.
  const path = url.searchParams.get(QueryParameter.PATH) ?? '';
  const [tags, statistics, TagLibrary] = await Promise.all([
    getAllTags(),
    getTagStatistics(),
    path ? import('$lib/components/frameleaf/tags/TagLibrary.svelte').then((module) => module.default) : undefined,
  ]);

  // A tag that is gone, or suppressed while the session is locked (and so left out of the list),
  // gets the not-found page rather than an empty browser that hints something was there.
  if (!tagPathExists(tags, path)) {
    error(404, { message: 'Tag not found' });
  }

  return {
    path,
    tags,
    statistics,
    TagLibrary,
    meta: {
      title: $t('tags'),
    },
  };
}) satisfies PageLoad;
