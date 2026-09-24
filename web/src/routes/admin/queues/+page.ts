import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: the Job manager is a Compute & jobs section of the Command Center; this address only redirects. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.queues());
}) satisfies PageLoad;
