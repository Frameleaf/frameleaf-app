import { getFrameleafSetup, type FrameleafSetupResponseDto } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * FL-176: an administrator of a server whose Frameleaf setup is incomplete gets setup (the flow
 * the server reports: a new server or an existing library); an existing library can also be
 * opened signed out, at "Sign in to finish setting up". Every other account gets the one-time
 * "Set up your account" tool, which can be reopened from the account menu.
 */
export const load = (async ({ url }) => {
  await authenticate(url, { public: true });
  const $t = await getFormatter();
  const server = serverConfigManager.value;
  const setupOpen = server.isInitialized && !server.isOnboarded;

  if (!authManager.authenticated) {
    if (!setupOpen) {
      redirect(307, Route.login({ continue: url.pathname + url.search }));
    }
    return {
      mode: 'setup' as const,
      flow: 'existing' as const,
      signedIn: false,
      saved: null as FrameleafSetupResponseDto | null,
      meta: { title: $t('frameleaf_setup_gate_title') },
    };
  }

  if (authManager.user.isAdmin && setupOpen) {
    const saved = await getFrameleafSetup();
    return {
      mode: 'setup' as const,
      flow: saved.flow,
      signedIn: true,
      saved,
      meta: { title: $t('frameleaf_setup_title') },
    };
  }

  return {
    mode: 'account' as const,
    flow: null,
    signedIn: true,
    saved: null,
    meta: { title: $t('frameleaf_setup_tool_title') },
  };
}) satisfies PageLoad;
