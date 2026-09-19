import { listICloudConnections } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  return { initial: await listICloudConnections(), meta: { title: $t('icloud_sync.title') } };
}) satisfies PageLoad;
