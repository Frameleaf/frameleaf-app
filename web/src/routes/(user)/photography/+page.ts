import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  return {
    // FL-420: the RAW develop editor returns to the shoot it was opened from (Proof: its galleries).
    shoot: url.searchParams.get('shoot') ?? undefined,
    // FL-702: `website` opens the studio website (the link in an inquiry email).
    // FL-1037: `payments` is where Stripe sends the studio back after connecting its account.
    section: (['galleries', 'website', 'payments'] as const).find(
      (section) => section === url.searchParams.get('section'),
    ),
    meta: { title: $t('frameleaf_photography') },
  };
}) satisfies PageLoad;
