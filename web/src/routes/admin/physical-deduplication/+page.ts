import { getPhysicalDeduplicationPreview, searchUsersAdmin } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [preview, users] = await Promise.all([
    getPhysicalDeduplicationPreview(),
    searchUsersAdmin({ withDeleted: false }),
  ]);
  const $t = await getFormatter();

  return {
    preview,
    users,
    meta: {
      title: $t('admin.physical_deduplication'),
    },
  };
}) satisfies PageLoad;
