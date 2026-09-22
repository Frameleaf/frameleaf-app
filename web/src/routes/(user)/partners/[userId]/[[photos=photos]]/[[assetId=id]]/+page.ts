import { getPartners, getUser, PartnerDirection, type PartnerResponseDto } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  const [user, partners] = await Promise.all([
    getUser({ id: params.userId }),
    // `getUser` alone does not carry `inTimeline` (PartnerLibraryHeader.svelte, FL-54's
    // Frameleaf redesign of this page's header, needs it); this partner shared their
    // library with the signed-in user, so the direction is "shared with" me.
    getPartners({ direction: PartnerDirection.SharedWith }),
  ]);
  const partner: PartnerResponseDto = partners.find((entry) => entry.id === user.id) ?? { ...user, inTimeline: true };
  const $t = await getFormatter();

  return {
    partner,
    meta: {
      title: $t('partner'),
    },
  };
}) satisfies PageLoad;
