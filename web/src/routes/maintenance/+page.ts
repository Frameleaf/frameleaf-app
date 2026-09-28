import { getServerVersion } from '@immich/sdk';
import { loadMaintenanceAuth, loadMaintenanceStatus } from '$lib/utils/maintenance';
import type { PageLoad } from '../admin/$types';

export const load = (async () => {
  const [auth] = await Promise.allSettled([loadMaintenanceAuth(), loadMaintenanceStatus()]);
  // FL-81: a sign-in link the server refused (expired or from an earlier maintenance) is reported
  const signInLinkRejected = auth.status === 'fulfilled' && auth.value === 'rejected';

  try {
    const { major, minor, patch } = await getServerVersion();
    return { expectedVersion: `${major}.${minor}.${patch}`, signInLinkRejected };
  } catch {
    return { expectedVersion: '0.0.0', signInLinkRejected };
  }
}) satisfies PageLoad;
