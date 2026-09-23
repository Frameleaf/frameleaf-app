import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

const FILTERS = new Set(['all', 'running', 'done', 'failed']);

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  const requested = url.searchParams.get('filter');

  return {
    // The list itself is not loaded here: the page watches the durable job feed and the browser's
    // own transfers together, and a server-rendered snapshot would only be stale by the time it
    // arrived.
    filter: requested && FILTERS.has(requested) ? (requested as 'all' | 'running' | 'done' | 'failed') : 'all',
    meta: {
      title: $t('frameleaf_activity_title'),
    },
  };
}) satisfies PageLoad;
