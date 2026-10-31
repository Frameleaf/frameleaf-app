import { getAllAlbums, getAuthStatus } from '@frameleaf/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  await authenticate(url);
  // Unlocking or locking in place loads the page again (LIB-P2).
  depends('suppressed:access');

  const { isElevated, pinCode } = await getAuthStatus();
  const unlocked = isElevated && pinCode;
  const tab = url.searchParams.get('tab') === 'albums' ? 'albums' : 'timeline';
  const $t = await getFormatter();
  const meta = { title: $t('suppressed_content') };

  // LIB-P2: until the session is unlocked the page opens inside the app with a card that asks for
  // the PIN in a dialog; nothing suppressed is loaded before then.
  if (!unlocked) {
    return { unlocked, ownedAlbums: [], sharedAlbums: [], tab, meta };
  }

  const [ownedAlbums, sharedAlbums] = await Promise.all([
    getAllAlbums({ suppressedOnly: true }),
    getAllAlbums({ isShared: true, suppressedOnly: true }),
  ]);

  return {
    unlocked,
    ownedAlbums: ownedAlbums.filter((album) => album.assetCount > 0),
    sharedAlbums: sharedAlbums.filter((album) => album.assetCount > 0),
    tab,
    meta,
  };
}) satisfies PageLoad;
