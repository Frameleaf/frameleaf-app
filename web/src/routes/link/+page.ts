import { redirect } from '@sveltejs/kit';
import { OpenQueryParam } from '$lib/constants';
import { isLicenseRelay } from '$lib/frameleaf/license-relay';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { Route } from '$lib/route';
import type { PageLoad } from './$types';

enum LinkTarget {
  HOME = 'home',
  UNSUBSCRIBE = 'unsubscribe',
  VIEW_ASSET = 'view_asset',
  /** FL-158: back from Frameleaf with a Frameleaf account to link on this server. */
  FRAMELEAF_ACCOUNT = 'frameleaf_account',
}

/**
 * Links into the app. CLD-004: a licence never arrives as a key in the address. The account site
 * sends a one-time code (`?target=frameleaf_license&linkCode=flc_…`); that, and any old link still
 * carrying a key (`?licenseKey=…`, `?key=…`), is left to `+page.svelte`, which clears the address
 * before anything else happens and never uses a key. A load function cannot see the fragment, so
 * without a `target` query the page reads that too.
 */
export const load = (({ url }) => {
  // never redirect with a code or key still in the address: the page takes it out first
  if (isLicenseRelay(url.pathname + url.search)) {
    return {};
  }
  const queryParams = url.searchParams;
  const target = queryParams.get('target') as LinkTarget | null;
  switch (target) {
    case null: {
      // the fragment, if any, is handled by +page.svelte
      return {};
    }

    case LinkTarget.HOME: {
      return redirect(307, Route.photos());
    }

    case LinkTarget.UNSUBSCRIBE: {
      return redirect(307, Route.userSettings({ isOpen: OpenQueryParam.NOTIFICATIONS }));
    }

    case LinkTarget.VIEW_ASSET: {
      const id = queryParams.get('id');
      if (id) {
        return redirect(307, Route.viewAsset({ id }));
      }
      break;
    }

    case LinkTarget.FRAMELEAF_ACCOUNT: {
      return redirect(307, commandCenterUrl('preferences', 'frameleaf-account'));
    }
  }

  return redirect(307, Route.photos());
}) satisfies PageLoad;
