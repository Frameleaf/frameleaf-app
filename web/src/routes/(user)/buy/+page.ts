import { takePendingLicenseKey } from '$lib/frameleaf/license-relay';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * FL-157: Support Frameleaf. A key the Frameleaf store handed over (`/link#target=frameleaf_license`)
 * is waiting in session storage; it is taken once and pre-filled, never read from the address.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    meta: { title: $t('buy') },
    pendingKey: takePendingLicenseKey(),
  };
}) satisfies PageLoad;
