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
  const requested = url.searchParams.get('continue');
  const destination =
    requested && /^\/(?![/\\])/.test(requested) ? Route.setupContinue(requested, url) : Route.photos();
  if (local ? !(await getAuthStatus()).localPasswordRequired : !authManager.user.shouldChangePassword) {
    redirect(307, local ? destination : Route.photos());
  }
  const $t = await getFormatter();

  return {
    local,
    destination,
    meta: {
      title: $t('change_password'),
    },
  };
}) satisfies PageLoad;
