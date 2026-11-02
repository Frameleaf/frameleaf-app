import { extensionSignInRequest } from '$lib/frameleaf/extension-sign-in';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * FL-655: "Allow Save to Frameleaf", opened by the extension in the browser's sign-in window. Signed
 * out, it goes to the normal sign-in and comes back here.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    request: extensionSignInRequest(url.searchParams),
    meta: {
      title: $t('frameleaf_extension_allow_title'),
    },
  };
}) satisfies PageLoad;
