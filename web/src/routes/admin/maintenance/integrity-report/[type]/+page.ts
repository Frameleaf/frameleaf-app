import { IntegrityReport } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/** FL-71: an integrity report opens inside Maintenance → Integrity checks; this address only redirects. */
export const load = (async ({ params, url }) => {
  await authenticate(url, { admin: true });
  const reportType = Object.values(IntegrityReport).find((type) => type === params.type);
  redirect(307, reportType ? Route.systemMaintenanceIntegrityReport({ reportType }) : Route.systemMaintenance());
}) satisfies PageLoad;
