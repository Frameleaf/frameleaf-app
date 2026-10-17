import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ parent }) => {
  await parent();
  const server = serverConfigManager.value;
  if (server.isInitialized) {
    // FL-176: the administrator just created here carries on with setup; anyone else signs in.
    await authManager.load();
    if (authManager.authenticated && authManager.user.isAdmin && !server.isOnboarded) {
      redirect(307, Route.onboarding());
    }
    redirect(307, Route.login());
  }

  const $t = await getFormatter();

  return {
    meta: {
      title: $t('frameleaf_setup_title'),
    },
  };
}) satisfies PageLoad;
