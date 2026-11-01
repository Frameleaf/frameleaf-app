import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ parent }) => {
  await parent();
  const $t = await getFormatter();

  return {
    meta: {
      title: $t('frameleaf_auth_choose_password_title'),
    },
  };
}) satisfies PageLoad;
