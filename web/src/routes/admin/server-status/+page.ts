import { redirect } from '@sveltejs/kit';
import { analyticsAreaUrl } from '$lib/frameleaf/settings-areas';
import type { PageLoad } from './$types';

/**
 * Library analytics lives in the command center (FL-79), where the design template mounts it. The
 * old server statistics address keeps working and carries its scope and range across.
 */
export const load = (({ url }) =>
  redirect(
    307,
    analyticsAreaUrl({
      scope: url.searchParams.get('scope') ?? undefined,
      range: url.searchParams.get('range') ?? undefined,
    }),
  )) satisfies PageLoad;
