import { getAllPets, getPetCandidates } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  // Hidden pets are loaded here too: the grid hides them behind its own "show hidden"
  // switch, exactly as the People grid does, because hiding is a display choice and not
  // an access control.
  const [pets, candidates] = await Promise.all([getAllPets({ withHidden: true }), getPetCandidates({})]);
  const $t = await getFormatter();

  return {
    pets,
    candidates,
    meta: {
      title: $t('frameleaf_pets_title'),
    },
  };
}) satisfies PageLoad;
