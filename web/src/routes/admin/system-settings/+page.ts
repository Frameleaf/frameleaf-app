import { getAdminConfigWithRevision, getConfigDefaults } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  // FL-66: the saved settings with the revision the settings draft is made against.
  const current = await getAdminConfigWithRevision();
  const defaultConfig = await getConfigDefaults();
  const $t = await getFormatter();

  return {
    current,
    defaultConfig,
    meta: {
      title: $t('admin.system_settings'),
    },
  };
}) satisfies PageLoad;
