import { redirect } from '@sveltejs/kit';
import { asMaintenanceSection, Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * FL-71: Maintenance is a Command Center area; this address only redirects there. An older link's
 * `?isOpen=<mode|backups|integrity>` keeps the panel it named, as that section of the area.
 */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  const section = (url.searchParams.get('isOpen') ?? '')
    .split(' ')
    .map((key) => asMaintenanceSection(key))
    .find((key) => key !== undefined);
  redirect(307, Route.systemMaintenance({ section }));
}) satisfies PageLoad;
