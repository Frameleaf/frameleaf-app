import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * FL-326 (spec §4.8): what a partner shares arrives as the viewer's own copies, so the partner's items
 * are in the viewer's own library and no partner's library is read any more. Old links land there.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  redirect(307, Route.photos());
}) satisfies PageLoad;
