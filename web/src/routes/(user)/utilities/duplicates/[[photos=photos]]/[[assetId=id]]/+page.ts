import { getDuplicateDecisions, getDuplicateReview } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * Duplicate review (FL-61): the owner's groups, each read as a whole, and the recent decisions an
 * undo can reach — so a decision made before a reload can still be undone after it.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const [groups, history] = await Promise.all([getDuplicateReview(), getDuplicateDecisions()]);
  const $t = await getFormatter();

  return {
    groups,
    history,
    meta: {
      title: $t('frameleaf_duplicates_title'),
    },
  };
}) satisfies PageLoad;
