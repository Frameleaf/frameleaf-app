import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * FL-83: the Google Photos import is a workflow dialog in Command Center → Backup & import, as in
 * the design template. This old address only redirects there, keeping the import it named.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  redirect(307, Route.takeout({ import: url.searchParams.get('import') ?? undefined }));
}) satisfies PageLoad;
