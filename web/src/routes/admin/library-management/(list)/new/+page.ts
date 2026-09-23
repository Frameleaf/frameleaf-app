import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** Adding a library (FL-78) opens the form over the command center's Libraries area. */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.newLibrary());
}) satisfies PageLoad;
