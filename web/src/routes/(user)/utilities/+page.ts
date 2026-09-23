import { getSummary } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  // The queue counts are a convenience: the directory still opens if they cannot be read.
  const summary = await getSummary({}).catch(() => null);

  return {
    summary,
    meta: {
      title: $t('utilities'),
    },
  };
}) satisfies PageLoad;
