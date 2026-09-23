import { AnalyticsRange, getAnalyticsReport, getAnalyticsScopes } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * Library analytics (FL-79). `?scope=` and `?range=` keep the selection in the address so a link
 * from an account or library opens that scope; an unknown or forbidden scope falls back to the
 * whole server.
 */
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  const range = url.searchParams.get('range') === AnalyticsRange.$90Days ? AnalyticsRange.$90Days : AnalyticsRange.Year;
  const requested = url.searchParams.get('scope') ?? 'all';
  const { scopes } = await getAnalyticsScopes();
  const scope = scopes.some((option) => option.value === requested) ? requested : 'all';
  const report = await getAnalyticsReport({ scope, range });
  const $t = await getFormatter();

  return {
    scopes,
    report,
    meta: {
      title: $t('frameleaf_analytics_title'),
    },
  };
}) satisfies PageLoad;
