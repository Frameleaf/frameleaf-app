import { getAdminConfigWithRevision, getConfigDefaults } from '@immich/sdk';
import { utilityTool } from '$lib/frameleaf/utilities';
import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  // FL-69: the utilities area is hosted once, where every account can reach it.
  if (url.searchParams.get('area') === 'utilities') {
    await redirectUtility(url, utilityTool(url.searchParams.get('section'))?.id);
  }
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
