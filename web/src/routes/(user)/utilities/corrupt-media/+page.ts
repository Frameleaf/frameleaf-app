import { MediaHealthCategory } from '@immich/sdk';
import { loadLibraryCareHealth } from '$lib/frameleaf/library-care-load';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => loadLibraryCareHealth(url, MediaHealthCategory.Corrupt)) satisfies PageLoad;
