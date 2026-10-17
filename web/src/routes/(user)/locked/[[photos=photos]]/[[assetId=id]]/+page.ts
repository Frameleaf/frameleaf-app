import { getAuthStatus } from '@frameleaf/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  // Unlocking or locking in place loads the page again (LIB-P2).
  depends('locked:access');

  // LIB-P2: the page opens inside the app whether or not the session is unlocked; until it is, it
  // shows the Locked collection's card and asks for the PIN in a dialog rather than leaving for a
  // sign-in style PIN screen.
  const { isElevated, pinCode } = await getAuthStatus();
  const $t = await getFormatter();

  return {
    unlocked: isElevated && pinCode,
    meta: {
      title: $t('frameleaf_locked'),
    },
  };
}) satisfies PageLoad;
