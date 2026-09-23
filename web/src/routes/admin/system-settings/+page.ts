import { redirect } from '@sveltejs/kit';
import { areaForSection, commandCenterUrl, isSettingsAreaId } from '$lib/frameleaf/settings-areas';
import { utilityTool } from '$lib/frameleaf/utilities';
import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

/**
 * The old administrator settings page (FL-71). Settings now live in the one Command Center at
 * `/user-settings`; this address only redirects there, keeping the area, the section an older
 * `?isOpen=` link named (with an explicit area, since a bare key there means an account section)
 * and every other parameter.
 */
// The empty +page.svelte beside this loader stays only because the Confluence-mirrored
// docs/docs/developer/frameleaf-settings-inventory.md cites its path; retire it at the next re-sync.
export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });
  // FL-69: the utilities area is hosted once, where every account can reach it.
  if (url.searchParams.get('area') === 'utilities') {
    await redirectUtility(url, utilityTool(url.searchParams.get('section'))?.id);
  }
  const params = new URLSearchParams(url.search);
  const requested = params.get('area');
  params.delete('area');
  const isOpen = params.get('isOpen') ?? '';
  const area = isSettingsAreaId(requested)
    ? requested
    : isOpen
        .split(' ')
        .map((key) => areaForSection(key === 'oauth' ? 'authentication' : key))
        .find(Boolean);
  // The OAuth group sits inside the sign-in methods form.
  const section = area
    ? isOpen
        .split(' ')
        .map((key) => (key === 'oauth' ? 'authentication' : key))
        .find((key) => areaForSection(key) === area)
    : undefined;
  const target = new URL(commandCenterUrl(area, params.has('section') ? undefined : section), url);
  for (const [key, value] of params) {
    target.searchParams.append(key, value);
  }
  redirect(307, `${target.pathname}${target.search}`);
}) satisfies PageLoad;
