/**
 * Backup › Restore › Files or folders (FL-1666), after the prototype's `backup-browse.mjs`: browsing a
 * Cloud Backup by date and folder, and the sums the page shows. Paths are the server's own, as they were
 * backed up; `/` is the top.
 */
import type { CloudBackupFileVersionDto, CloudBackupManifestDto } from '@frameleaf/sdk';

/** A ticked file or folder, with what it held in the backup being browsed. */
export type BrowsePick = { path: string; folder: boolean; size: number; files: number };

/** Entries read from a folder at a time. */
export const BROWSE_PAGE = 200;

export const childPath = (folder: string, name: string) => (folder === '/' ? `/${name}` : `${folder}/${name}`);

export const nameOf = (path: string) => path.split('/').findLast(Boolean) ?? '/';

/** The folders from the top down to this one, the top itself left out. */
export const crumbsOf = (path: string) => {
  const names = path.split('/').filter(Boolean);
  return names.map((name, index) => ({ name, path: `/${names.slice(0, index + 1).join('/')}` }));
};

/** The folders above a path, as words: "photos › library › 2026". Empty at the top. */
export const folderWords = (path: string) =>
  crumbsOf(path)
    .slice(0, -1)
    .map(({ name }) => name)
    .join(' › ');

/** Chosen directly, or inside a folder that is. */
export const isChosen = (picks: readonly BrowsePick[], path: string) =>
  picks.some((pick) => pick.path === path || path.startsWith(`${pick.path}/`));

/** Tick or untick. Ticking a folder replaces anything ticked inside it. */
export const togglePick = (picks: readonly BrowsePick[], pick: BrowsePick): BrowsePick[] => {
  if (picks.some((item) => item.path === pick.path)) {
    return picks.filter((item) => item.path !== pick.path);
  }
  if (isChosen(picks, pick.path)) {
    return [...picks];
  }
  return [...picks.filter((item) => !item.path.startsWith(`${pick.path}/`)), pick];
};

/** What a restore of these picks brings back. Picks never overlap, so they add up. */
export const pickTotals = (picks: readonly BrowsePick[]) => ({
  files: picks.reduce((sum, pick) => sum + pick.files, 0),
  size: picks.reduce((sum, pick) => sum + pick.size, 0),
});

/** The copy in the backup being browsed: the newest one made on or before it. */
export const heldVersion = (versions: readonly CloudBackupFileVersionDto[], browsing: CloudBackupManifestDto) => {
  const at = new Date(browsing.createdAt).getTime();
  return versions.find((version) => new Date(version.createdAt).getTime() <= at) ?? versions.at(-1);
};

/** The calendar day of a moment in the viewer's time zone, as `restoreDates` names its rows. */
export const dayOf = (at: Date) => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

/** The newest kept Cloud Backup of a day (manifests come newest first). */
export const manifestOnDay = (manifests: readonly CloudBackupManifestDto[], day: string) =>
  manifests.find((manifest) => dayOf(new Date(manifest.createdAt)) === day);

/** A folder to save to: a whole path on this server. */
export const isFolderPath = (value: string) => /^\/\S/.test(value.trim()) && !value.split('/').includes('..');
