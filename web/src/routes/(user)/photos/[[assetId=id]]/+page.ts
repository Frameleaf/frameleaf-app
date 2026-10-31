import { authenticatedPageLoader } from '$lib/utils/page-load';
import type { PageLoad } from './$types';

export const load = authenticatedPageLoader('photos') satisfies PageLoad;
