import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  return { batchId: url.searchParams.get('batch') ?? undefined, meta: { title: $t('frameleaf_activity_edits_title') } };
}) satisfies PageLoad;
