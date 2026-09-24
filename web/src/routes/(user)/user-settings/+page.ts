import { getAdminConfigWithRevision, getConfigDefaults } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * The one Command Center (FL-71) for every account. Only `screen` is read here, so moving between
 * areas and sections never reloads the page's data. An administrator's server settings, with the
 * revision the settings draft is made against (FL-66), load with the page; an account without
 * administration never asks for them.
 */
export const load = (async ({ url }) => {
  await authenticate(url);

  // The old separate Library Care screen is gone (September 24): Library care is a settings area,
  // the hub for fixes, so older links land there.
  if (url.searchParams.get('screen') === 'care') {
    redirect(307, commandCenterUrl('care'));
  }

  const $t = await getFormatter();
  const meta = { title: $t('settings') };

  if (!authManager.user.isAdmin) {
    return { screen: 'settings' as const, system: null, meta };
  }

  await systemConfigManager.init();
  const [current, defaultConfig] = await Promise.all([getAdminConfigWithRevision(), getConfigDefaults()]);
  return { screen: 'settings' as const, system: { current, defaultConfig }, meta };
}) satisfies PageLoad;
