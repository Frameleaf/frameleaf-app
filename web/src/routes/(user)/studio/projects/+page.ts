import { isStudioLibraryShelf } from '$lib/frameleaf/studio/project-library';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * The Studio project library (FL-91). The list itself is read by the page, not here: it follows
 * the shelf, the search and the order the person picks, and a snapshot taken during navigation
 * would only be stale by the time it arrived.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  const requested = url.searchParams.get('shelf');

  return {
    shelf: isStudioLibraryShelf(requested) ? requested : 'active',
    meta: {
      title: $t('frameleaf_studio_library_title'),
    },
  };
}) satisfies PageLoad;
