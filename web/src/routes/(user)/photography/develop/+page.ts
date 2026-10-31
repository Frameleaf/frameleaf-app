import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  const only = url.searchParams.get('only');
  return {
    shootId: url.searchParams.get('shoot') ?? '',
    photoId: url.searchParams.get('photo') ?? undefined,
    only: only ? only.split(',').filter(Boolean) : null,
    meta: { title: $t('frameleaf_develop_editor') },
  };
}) satisfies PageLoad;
