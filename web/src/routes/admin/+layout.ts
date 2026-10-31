import { authenticate } from '$lib/utils/auth';
import type { LayoutLoad } from './$types';

// Every /admin address only redirects into the Command Center, which loads the settings it needs.
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
}) satisfies LayoutLoad;
