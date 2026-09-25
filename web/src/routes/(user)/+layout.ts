import { redirect } from '@sveltejs/kit';
import { authenticate } from '$lib/utils/auth';
import {
  getAssetInfoFromParam,
  isInaccessibleAssetError,
  isLockedFolderRoute,
  isSharedLinkRoute,
  libraryUrlWithoutAsset,
} from '$lib/utils/navigation';
import type { LayoutLoad } from './$types';

export const load = (async ({ url, params, route }) => {
  const sharedLinkRoute = isSharedLinkRoute(route.id);
  await authenticate(url, { public: sharedLinkRoute });
  // A shared link's page loads its item itself, after the link (FL-56, `loadSharedLink`), so a gone
  // link or an item outside it lands on the share's own error page, not the app's.
  if (sharedLinkRoute) {
    return { asset: undefined };
  }
  try {
    return { asset: await getAssetInfoFromParam(params) };
  } catch (error) {
    // FL-33: a link to an item that was deleted or is no longer readable opens the page it belongs
    // to without it, instead of an error page; the library session drops the stale open item. The
    // Locked view keeps its own PIN flow for items the session cannot read yet.
    if (params.assetId && !isLockedFolderRoute(route.id) && isInaccessibleAssetError(error)) {
      redirect(307, libraryUrlWithoutAsset(url, params.assetId));
    }
    throw error;
  }
}) satisfies LayoutLoad;
