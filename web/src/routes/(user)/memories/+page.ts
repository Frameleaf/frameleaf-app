import { memoryManager } from '$lib/managers/memory-manager.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  const user = await authenticate(url);
  const $t = await getFormatter();

  // The memories are the page's one section: if they cannot load, the page still opens inside the
  // app and the index offers a retry.
  const loadFailed = await memoryManager
    .applyPreferences()
    .then(() => false)
    .catch(() => true);

  return {
    user,
    loadFailed,
    meta: {
      title: $t('memories'),
    },
  };
}) satisfies PageLoad;
