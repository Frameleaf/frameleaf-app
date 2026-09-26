import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * FL-71: this page is a Command Center section now; its old address only redirects there. The old
 * page's `#workers` anchor (Workers & endpoints) opens that section instead of the destinations.
 *
 * A load function may not read `url.hash`, and the fragment never reaches a server. The web app
 * renders in the browser (`ssr = false`), so an address opened directly (a bookmark or pasted link)
 * still has its fragment in `location`. The application itself no longer links here.
 */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  const workers = browser && location.pathname === url.pathname && location.hash === '#workers';
  redirect(307, workers ? Route.systemWorkers() : Route.systemProcessingDestinations());
}) satisfies PageLoad;
