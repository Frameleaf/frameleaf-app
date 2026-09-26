import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => redirectUtility(url, 'duplicates', params.assetId)) satisfies PageLoad;
