import { getApiKeys, getSessions } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const $t = await getFormatter();
  if (url.searchParams.get('area') === 'utilities' || url.searchParams.get('screen') === 'care') {
    return { keys: [], sessions: [], commandCenter: true, meta: { title: $t('settings') } };
  }

  const keys = await getApiKeys();
  const sessions = await getSessions();

  return {
    commandCenter: false,
    keys,
    sessions,
    meta: {
      title: $t('settings'),
    },
  };
}) satisfies PageLoad;
