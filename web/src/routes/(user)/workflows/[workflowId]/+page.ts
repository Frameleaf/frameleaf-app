import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  url = new URL(url);
  url.searchParams.set('workflowId', params.workflowId);
  return redirectUtility(url, 'workflows');
}) satisfies PageLoad;
