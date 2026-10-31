import { authenticatedPageLoader } from '$lib/utils/page-load';
import type { PageLoad } from './$types';

export const load = authenticatedPageLoader('best_photos_page_title') satisfies PageLoad;
