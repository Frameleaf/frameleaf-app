import { redirect } from '@sveltejs/kit';
import { fromQueueSlug, Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: one queue opens inside Compute & jobs → Job manager; this address only redirects. */
export const load = (async ({ params, url }) => {
  await authenticate(url, { admin: true });
  const name = fromQueueSlug(params.name);
  redirect(307, name ? Route.viewQueue({ name }) : Route.queues());
}) satisfies PageLoad;
