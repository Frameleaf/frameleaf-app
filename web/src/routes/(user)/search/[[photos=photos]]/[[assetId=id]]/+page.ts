import { authenticatedPageLoader } from '$lib/utils/page-load';
import type { PageLoad } from './$types';

export const load = authenticatedPageLoader('search') satisfies PageLoad;
