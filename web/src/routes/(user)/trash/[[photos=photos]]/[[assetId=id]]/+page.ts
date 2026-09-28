import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * FL-71: Trash is a Command Center area (the rail's Trash opens it). The old `/trash` and
 * `/trash/photos/<id>` addresses only redirect there, keeping the open item.
 */
export const load = (async ({ params, url }) => {
  await authenticate(url);
  redirect(307, params.assetId ? Route.viewTrashedAsset({ id: params.assetId }) : Route.trash());
}) satisfies PageLoad;
