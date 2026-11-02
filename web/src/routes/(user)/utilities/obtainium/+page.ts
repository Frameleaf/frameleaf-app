import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import type { PageLoad } from './$types';

// Android direct updates (Obtainium) were removed: Frameleaf publishes its own apps. Old links land on Mobile apps.
export const load = (async ({ url }) => redirectUtility(url, 'downloads')) satisfies PageLoad;
