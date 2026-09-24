/**
 * What each moved administration section loads when it opens (FL-71). These are the old route
 * loaders of `/admin/render-workers`, `/admin/processing-destinations` and
 * `/admin/physical-deduplication` and `/admin/users`, without the page titles the Command Center heading now carries.
 */
import {
  getAllLibraries,
  getLibraryStatistics,
  getManagedUploadStatistics,
  getMlWorkloadRoutes,
  getPhysicalDeduplicationPreview,
  getRenderWorkerLimits,
  getUserPreferencesAdmin,
  getUserSessionsAdmin,
  getUserStatisticsAdmin,
  getWorkerInventory,
  listMlDestinations,
  listRenderWorkers,
  searchRenderWorkerAudit,
  searchUsersAdmin,
} from '@immich/sdk';

export const loadRenderWorkers = async () => {
  const [workers, limits, audit, users] = await Promise.all([
    listRenderWorkers(),
    getRenderWorkerLimits(),
    searchRenderWorkerAudit({ take: 100 }),
    searchUsersAdmin({ withDeleted: true }),
  ]);
  return { workers, limits, audit, users };
};
export type RenderWorkersData = Awaited<ReturnType<typeof loadRenderWorkers>>;

export const loadProcessing = async () => {
  const [destinations, { routes }, inventory] = await Promise.all([
    listMlDestinations(),
    getMlWorkloadRoutes(),
    // The inventory is a read-only view; if it cannot be read, the destinations still load.
    getWorkerInventory().catch(() => null),
  ]);
  return { destinations, routes, inventory };
};
export type ProcessingData = Awaited<ReturnType<typeof loadProcessing>>;

export const loadDeduplication = async () => {
  const [preview, users] = await Promise.all([
    getPhysicalDeduplicationPreview(),
    searchUsersAdmin({ withDeleted: false }),
  ]);
  return { preview, users };
};

/** One account's detail, the old `/admin/users/[id]` layout loader (FL-76). */
export const loadUserDetail = async (id: string) => {
  const [user] = await searchUsersAdmin({ id, withDeleted: true }).catch(() => []);
  if (!user) {
    return null;
  }
  // Every library in the system, narrowed to this account's own for the account detail's
  // Libraries tab (FL-76).
  const [userPreferences, userStatistics, userSessions, allLibraries, uploads] = await Promise.all([
    getUserPreferencesAdmin({ id: user.id }),
    getUserStatisticsAdmin({ id: user.id }),
    getUserSessionsAdmin({ id: user.id }),
    getAllLibraries({}),
    // CC-29: the physical size of the account's uploads; the overview shows "—" when unreadable.
    getManagedUploadStatistics().catch(() => []),
  ]);
  const physicalBytes = uploads.find(({ ownerId }) => ownerId === user.id)?.usagePhysical ?? null;
  const libraries = allLibraries.filter((library) => library.ownerId === user.id);
  // Item counts for the Libraries tab: each external library's own (FL-76).
  const libraryStatistics = Object.fromEntries(
    await Promise.all(libraries.map(async ({ id }) => [id, await getLibraryStatistics({ id })] as const)),
  );
  return { user, userPreferences, userStatistics, userSessions, libraries, libraryStatistics, physicalBytes };
};
export type UserDetailData = NonNullable<Awaited<ReturnType<typeof loadUserDetail>>>;
