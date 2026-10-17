import { authenticatedPageLoader } from '$lib/utils/page-load';
import type { LayoutLoad } from './$types';

export const load = authenticatedPageLoader('shared_links') satisfies LayoutLoad;
