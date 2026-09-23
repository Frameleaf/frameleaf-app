import { getMlWorkloadRoutes, listMlDestinations } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [destinations, { routes }] = await Promise.all([listMlDestinations(), getMlWorkloadRoutes()]);
  const $t = await getFormatter();

  return {
    destinations,
    routes,
    meta: {
      title: $t('admin.frameleaf_ml_destinations_title'),
    },
  };
}) satisfies PageLoad;
