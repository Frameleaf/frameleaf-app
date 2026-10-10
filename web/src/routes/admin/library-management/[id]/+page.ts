import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** A library's own address (FL-78) opens it in the command center's Libraries area. */
export const load = (async ({ params, url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.viewLibrary({ id: params.id }));
}) satisfies PageLoad;
