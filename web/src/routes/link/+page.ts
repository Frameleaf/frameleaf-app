import { redirect } from '@sveltejs/kit';
import { OpenQueryParam } from '$lib/constants';
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
 * Links into the app. FL-157: a licence key from the Frameleaf store arrives only in the fragment
 * (`#target=frameleaf_license&key=…`), which a load function never sees; without a `target` query
 * the page itself reads the fragment. The previous `?target=activate_license&licenseKey=…` form put
 * a key in the address and is no longer accepted.
 */
export const load = (({ url }) => {
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
