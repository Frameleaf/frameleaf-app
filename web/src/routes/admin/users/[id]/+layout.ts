import {
  getAllLibraries,
  getUserPreferencesAdmin,
  getUserSessionsAdmin,
  getUserStatisticsAdmin,
  searchUsersAdmin,
} from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { UUID_REGEX } from '$lib/constants';
import { Route } from '$lib/route';
import { authenticate, requestServerInfo } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { LayoutLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url, { admin: true });
  await requestServerInfo();

  if (!UUID_REGEX.test(params.id)) {
    redirect(307, Route.users());
  }

  const [user] = await searchUsersAdmin({ id: params.id, withDeleted: true }).catch(() => []);
  if (!user) {
    redirect(307, Route.users());
  }

  // `libraries` is every library in the system, the same call the library-management list page
  // makes; the account detail's Libraries tab (FL-76) filters it to this account's own.
  const [userPreferences, userStatistics, userSessions, libraries] = await Promise.all([
    getUserPreferencesAdmin({ id: user.id }),
    getUserStatisticsAdmin({ id: user.id }),
    getUserSessionsAdmin({ id: user.id }),
    getAllLibraries(),
  ]);

  const $t = await getFormatter();

  return {
    user,
    userPreferences,
    userStatistics,
    userSessions,
    libraries,
    meta: {
      title: $t('admin.user_details'),
    },
  };
}) satisfies LayoutLoad;
