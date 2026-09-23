import { getRenderWorkerLimits, listRenderWorkers, searchRenderWorkerAudit, searchUsersAdmin } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [workers, limits, audit, users] = await Promise.all([
    listRenderWorkers(),
    getRenderWorkerLimits(),
    searchRenderWorkerAudit({ take: 100 }),
    searchUsersAdmin({ withDeleted: true }),
  ]);
  const $t = await getFormatter();

  return {
    workers,
    limits,
    audit,
    users,
    meta: {
      title: $t('admin.render_workers'),
    },
  };
}) satisfies PageLoad;
