import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => redirectUtility(url, 'downloads')) satisfies PageLoad;
