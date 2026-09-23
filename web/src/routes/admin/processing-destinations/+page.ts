import { getMlWorkloadRoutes, getWorkerInventory, listMlDestinations } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [destinations, { routes }, inventory] = await Promise.all([
    listMlDestinations(),
    getMlWorkloadRoutes(),
    getWorkerInventory(),
  ]);
  const $t = await getFormatter();

  return {
    destinations,
    routes,
    inventory,
    meta: {
      title: $t('admin.frameleaf_ml_destinations_title'),
    },
  };
}) satisfies PageLoad;
