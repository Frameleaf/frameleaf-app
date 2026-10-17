import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import type { PageLoad } from './$types';

/**
 * The legacy edit page is gone (AL-23): a shared link is edited in the list's Frameleaf form
 * (`SharedLinkForm`, design `SharedLinks.jsx`), so an old address opens the list with that form.
 */
export const load = (({ params }) => {
  redirect(307, Route.editSharedLink({ id: params.id }));
}) satisfies PageLoad;
