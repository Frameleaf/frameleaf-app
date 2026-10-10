import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    // the search stays in the address, so a reload or a shared link to the list keeps it
    query: url.searchParams.get('query') ?? '',
    meta: {
      title: $t('frameleaf_documents_title'),
    },
  };
}) satisfies PageLoad;
