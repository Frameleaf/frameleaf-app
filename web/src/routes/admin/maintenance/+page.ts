import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: Maintenance is a Command Center area; this address only redirects there. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.systemMaintenance());
}) satisfies PageLoad;
