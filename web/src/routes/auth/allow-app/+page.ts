import { allowAppRequest } from '$lib/frameleaf/connected-apps';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * FL-860: the Allow page a connected app opens (through the server's OAuth authorization endpoint,
 * FL-803). Signed out, it goes to the normal sign-in and comes back here with the same request.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    request: allowAppRequest(url.searchParams),
    meta: {
      title: $t('frameleaf_apps_allow_page_title'),
    },
  };
}) satisfies PageLoad;
