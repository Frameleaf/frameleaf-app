import { getPublicConfig } from '@frameleaf/sdk';
import { redirect } from '@sveltejs/kit';
import { getOAuthContinue } from '$lib/frameleaf/auth-session-preference';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ parent, url }) => {
  await parent();

  const requested = Route.continue(url.searchParams.get('continue'), Route.photos());
  // FL-80: a provider's callback address has no `continue`; the sign-in kept it before leaving (and
  // `Route.continue` checks it again), so a visitor the callback just signed in is not sent home
  const isCallback = url.searchParams.has('code') || url.searchParams.has('error');
  const continueUrl = isCallback ? getOAuthContinue(requested) : requested;

  if (authManager.authenticated) {
    redirect(307, continueUrl);
  }

  if (!serverConfigManager.value.isInitialized) {
    // Admin not registered
    redirect(307, Route.register());
  }

  const publicConfig = await getPublicConfig();

  const $t = await getFormatter();
  return {
    meta: {
      title: $t('login'),
    },
    continueUrl,
    serverUrl: url.origin,
    publicConfig,
  };
}) satisfies PageLoad;
