import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** The Libraries list (FL-78) is an area of the settings command center. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.libraries());
}) satisfies PageLoad;
