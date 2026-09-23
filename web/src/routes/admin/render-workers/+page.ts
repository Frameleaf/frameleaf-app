import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: this page is a Command Center section now; its old address only redirects there. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.renderWorkers());
}) satisfies PageLoad;
