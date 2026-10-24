/**
 * FL-539: the rest of each Utilities tool's state (prototype `settings-v2/library/utilities.jsx`,
 * `TOOLS`): the largest original, Live Photos to pair, when iCloud Photos last checked, the workflows
 * there are, and the phones connected. Each is read on its own and left out when it cannot be, so
 * the directory never waits on one of them. "Checked last night" comes from the overnight runs, which
 * only an administrator can read.
 */
import {
  getLivePhotoCandidates,
  getOvernight,
  listBackupDevices,
  listICloudConnections,
  searchLargeAssets,
  searchWorkflows,
} from '@frameleaf/sdk';

export type UtilityExtras = {
  largestBytes: number | null;
  toPair: number | null;
  icloudCheckedAt: string | null;
  icloudConnected: boolean;
  workflows: number | null;
  phones: number | null;
  /** When the last overnight run finished, for "Checked last night". */
  checkedAt: string | null;
};

const settled = <T>(result: PromiseSettledResult<T>) => (result.status === 'fulfilled' ? result.value : undefined);

/** A night's checks count as "last night" for a day and a half after they finish. */
export const CHECKED_LAST_NIGHT_MS = 36 * 60 * 60 * 1000;

export const checkedLastNight = (checkedAt: string | null, now = Date.now()) =>
  !!checkedAt && now - new Date(checkedAt).getTime() <= CHECKED_LAST_NIGHT_MS;

export const loadUtilityExtras = async (isAdmin: boolean): Promise<UtilityExtras> => {
  const results = await Promise.allSettled([
    searchLargeAssets({ minFileSize: 0, size: 1, withExif: true }),
    getLivePhotoCandidates(),
    listICloudConnections(),
    searchWorkflows({}),
    listBackupDevices({ limit: 100 }),
    isAdmin ? getOvernight() : Promise.reject(new Error('not an administrator')),
  ]);
  const largest = settled(results[0])?.[0];
  const pairs = settled(results[1]);
  const icloud = settled(results[2]);
  const workflows = settled(results[3]);
  const phones = settled(results[4]);
  const overnight = settled(results[5]);
  const finished = (icloud?.connections ?? [])
    .map((connection) => connection.run?.finishedAt)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
  return {
    largestBytes: largest?.exifInfo?.fileSizeInByte ?? null,
    toPair: pairs ? (pairs.suggestionsEnabled ? pairs.total : 0) : null,
    icloudCheckedAt: finished ?? null,
    icloudConnected: (icloud?.connections.length ?? 0) > 0,
    workflows: workflows ? workflows.length : null,
    phones: phones ? phones.devices.length : null,
    checkedAt: overnight?.nights[0]?.finishedAt ?? null,
  };
};
