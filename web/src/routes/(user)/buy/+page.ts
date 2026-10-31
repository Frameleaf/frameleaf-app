import { takeLinkNotice, takePendingLinkCode } from '$lib/frameleaf/license-relay';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * FL-157, CLD-004: Support Frameleaf. A one-time link code from the Frameleaf account site
 * (`/link?linkCode=…`) waits in session storage and is taken once for this server to redeem; an old
 * link that carried a key, or a malformed code, only leaves a notice asking for the key to be pasted. Neither is ever read
 * from this page's address.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    meta: { title: $t('buy') },
    linkCode: takePendingLinkCode(),
    linkNotice: takeLinkNotice(),
  };
}) satisfies PageLoad;
