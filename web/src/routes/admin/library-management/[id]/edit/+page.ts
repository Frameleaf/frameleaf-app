import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** The edit address (FL-78) opens the library with its edit form showing. */
export const load = (async ({ params, url }) => {
  await authenticate(url, { admin: true });
  redirect(307, Route.editLibrary({ id: params.id }));
}) satisfies PageLoad;
