import { authenticatedPageLoader } from '$lib/utils/page-load';
import type { PageLoad } from './$types';

export const load = authenticatedPageLoader('recently_added_page_title') satisfies PageLoad;
