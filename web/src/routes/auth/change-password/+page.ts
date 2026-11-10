import { getAuthStatus } from '@frameleaf/sdk';
import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const local = url.searchParams.get('local') === '1';
  const requested = Route.continue(url.searchParams.get('continue'), Route.photos());
  const destination = Route.setupContinue(requested, url);
  const status = local ? await getAuthStatus().catch(() => undefined) : undefined;
  if (local ? status && !status.localPasswordRequired : !authManager.user.shouldChangePassword) {
    redirect(307, local ? destination : Route.photos());
  }
  const $t = await getFormatter();

  return {
    local,
    statusUnavailable: local && !status,
    destination,
    meta: {
      title: $t('change_password'),
    },
  };
}) satisfies PageLoad;
