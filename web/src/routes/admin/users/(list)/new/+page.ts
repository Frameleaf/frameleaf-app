import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: accounts are managed in Users → People with server access; this address only redirects. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.newUser());
}) satisfies PageLoad;
