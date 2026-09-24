import { authenticate } from '$lib/utils/auth';
import { getAssetInfoFromParam, isSharedLinkRoute } from '$lib/utils/navigation';
import type { LayoutLoad } from './$types';

export const load = (async ({ url, params, route }) => {
  const sharedLinkRoute = isSharedLinkRoute(route.id);
  await authenticate(url, { public: sharedLinkRoute });
  // A shared link's page loads its item itself, after the link (FL-56, `loadSharedLink`), so a gone
  // link or an item outside it lands on the share's own error page, not the app's.
  const asset = sharedLinkRoute ? undefined : await getAssetInfoFromParam(params);

  return {
    asset,
  };
}) satisfies LayoutLoad;
