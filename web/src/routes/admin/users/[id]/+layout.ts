import {
  getAllLibraries,
  getLibraryStatistics,
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

  // Every library in the system, the same call the library-management list page makes, narrowed
  // to this account's own for the account detail's Libraries tab (FL-76).
  const [userPreferences, userStatistics, userSessions, allLibraries] = await Promise.all([
    getUserPreferencesAdmin({ id: user.id }),
    getUserStatisticsAdmin({ id: user.id }),
    getUserSessionsAdmin({ id: user.id }),
    getAllLibraries({}),
  ]);
  const libraries = allLibraries.filter((library) => library.ownerId === user.id);

  // Item counts for the Libraries tab: each external library's own, and the managed uploads row
  // is the account's total less these (FL-76). The same statistics the library pages show.
  const libraryStatistics = Object.fromEntries(
    await Promise.all(libraries.map(async ({ id }) => [id, await getLibraryStatistics({ id })] as const)),
  );

  const $t = await getFormatter();

  return {
    user,
    userPreferences,
    userStatistics,
    userSessions,
    libraries,
    libraryStatistics,
    meta: {
      title: $t('admin.user_details'),
    },
  };
}) satisfies LayoutLoad;
