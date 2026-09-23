import { getPet } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  // Owner-scoped on the server: another account's pet is "not found", exactly like a deleted one.
  const pet = await getPet({ id: params.petId });
  const $t = await getFormatter();

  return {
    pet,
    meta: {
      title: pet.name || $t('frameleaf_pets_unnamed'),
    },
  };
}) satisfies PageLoad;
