import { sql } from 'kysely';
import type { AlbumRepository } from 'src/repositories/album.repository.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { getHiddenContentFilter, hiddenContentAssetIdExists, hiddenFromOthers } from 'src/utils/database.js';
import { type SubfolderRule, folderOf } from 'src/utils/folder-albums.js';
import { isDefaultVisible, notLockedOrOwnedBy } from 'src/utils/locked.js';

/**
 * FL-1838: "Folders in this album". An album made from a folder holds the photos of the folders inside it (Original,
 * RAW, Edits, Video). Per folder, the album shows its photos with the others, in a section of their own, as an album
 * inside, or not at all; and the same photo found in several folders shows once (the preferred version in front, the
 * others behind it) or every time. Hidden photos stay in the library, in search and on disk: only the album view leaves
 * them out.
 */

export type AlbumFolderDisplay = 'with' | 'section' | 'album' | 'hidden';
export type AlbumFolderVersions = 'one' | 'each';
export type AlbumFolderChoices = {
  /** Per folder name, matched without regard to case. A name left out uses `defaultFolderDisplay`. */
  folders: Record<string, AlbumFolderDisplay>;
  versions: AlbumFolderVersions;
  /** Which folder's version stands in front, first wins. Folders left out come after, in name order. */
  prefer: string[];
};

/** The photographer defaults (owner 2026-11-27): Original and Edits with the others, RAW hidden, Video its own section. */
const DEFAULT_DISPLAY: Readonly<Record<string, AlbumFolderDisplay>> = {
  raw: 'hidden',
  video: 'section',
  videos: 'section',
};
export const DEFAULT_ALBUM_FOLDER_CHOICES: AlbumFolderChoices = {
  folders: {},
  versions: 'one',
  prefer: ['Edits', 'Original', 'RAW'],
};

export const resolveAlbumFolderChoices = (
  stored: Partial<AlbumFolderChoices> | null | undefined,
): AlbumFolderChoices => ({
  folders: { ...stored?.folders },
  versions: stored?.versions ?? DEFAULT_ALBUM_FOLDER_CHOICES.versions,
  prefer: stored?.prefer ?? DEFAULT_ALBUM_FOLDER_CHOICES.prefer,
});

/** How a folder shows. '' is the album's own folder, whose photos are always with the others. */
export const folderDisplay = (choices: AlbumFolderChoices, name: string): AlbumFolderDisplay => {
  if (!name) {
    return 'with';
  }
  const lower = name.toLowerCase();
  for (const [key, display] of Object.entries(choices.folders)) {
    if (key.toLowerCase() === lower) {
      return display;
    }
  }
  return DEFAULT_DISPLAY[lower] ?? 'with';
};

/**
 * The FL-1837 rules these choices make for the folders they name: an album inside is a real album the sync makes
 * ('own'); any other choice keeps the folder's photos in the album ('join'), where only how they show differs.
 */
export const subfolderRulesOf = (choices: AlbumFolderChoices): Record<string, SubfolderRule> =>
  Object.fromEntries(
    Object.entries(choices.folders).map(([name, display]) => [
      name.toLowerCase(),
      display === 'album' ? 'own' : 'join',
    ]),
  );

/** The folder directly inside `albumFolder` that holds `itemFolder`; '' when the item is in the album's folder itself. */
export const subfolderOf = (itemFolder: string, albumFolder: string) => {
  const prefix = albumFolder === '/' ? '/' : `${albumFolder}/`;
  return itemFolder.startsWith(prefix) ? itemFolder.slice(prefix.length).split('/', 1)[0] : '';
};

export type AlbumFolderItem = {
  id: string;
  /** The folder inside the album's folder ('' for the album's own folder) */
  folder: string;
  originalFileName: string;
  /** capture time */
  takenAt: Date | string;
  isVideo: boolean;
};

export type AlbumFolderVersionRow = { assetId: string; frontAssetId: string; matchedBy: 'name' | 'time' };

/** Files sharing a name are versions of one photo only when taken within this long of each other. */
const NAME_MATCH_WINDOW = 60 * 60 * 1000;

const EDIT_SUFFIX = /(?:[ ._-](?:edit|edited|copy|final|export|exported)\d*| \(\d+\))$/i;

/** A file's name without its extension and without what an editor adds to it: IMG_4821.CR3, IMG_4821-edit.jpg → img_4821. */
export const fileStem = (fileName: string) => {
  let stem = fileName.replace(/\.[^./]*$/, '').toLowerCase();
  for (let next = stem.replace(EDIT_SUFFIX, ''); next !== stem && next; next = stem.replace(EDIT_SUFFIX, '')) {
    stem = next;
  }
  return stem;
};

/**
 * The same photo in more than one file: files of one kind sharing a name stem, and a file whose name matched nothing
 * joined to the one other photo in another folder taken at the same moment (an edit saved under a new name, owner
 * 2026-11-27). Only the folders shown with the others or hidden take part: a section and an album inside show every
 * file of theirs. Each group's front is the version from the most preferred folder shown with the others; a group with
 * none shown has no front (all of it is hidden anyway). Returns a row for every member of a group of two or more, and
 * how many groups matched by name only and how many needed the capture time.
 */
export const matchAlbumVersions = (items: AlbumFolderItem[], choices: AlbumFolderChoices) => {
  const shown = (item: AlbumFolderItem) => {
    const display = folderDisplay(choices, item.folder);
    return display === 'with' || display === 'hidden';
  };
  const byName = new Map<string, AlbumFolderItem[]>();
  for (const item of items) {
    if (!shown(item)) {
      continue;
    }
    const key = `${item.isVideo ? 'v' : 'p'}:${fileStem(item.originalFileName)}`;
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  // A name only matches across folders, and only photos taken within an hour of each other: two cameras, or a
  // counter that started again, give different photos the same name (IMG_0001.JPG in Day 1 and in Day 2).
  const time = (item: AlbumFolderItem) => new Date(item.takenAt).getTime();
  const groups: { members: AlbumFolderItem[]; byTime: Set<string> }[] = [];
  for (const sameName of byName.values()) {
    const clusters: AlbumFolderItem[][] = [];
    for (const item of sameName.toSorted((a, b) => time(a) - time(b))) {
      const cluster = clusters.find(
        (members) =>
          members.every(({ folder }) => folder !== item.folder) && time(item) - time(members[0]) <= NAME_MATCH_WINDOW,
      );
      if (cluster) {
        cluster.push(item);
      } else {
        clusters.push([item]);
      }
    }
    groups.push(...clusters.map((members) => ({ members, byTime: new Set<string>() })));
  }
  // a single file whose name matched nothing joins the one group taken at the same second in another folder
  const moment = (item: AlbumFolderItem) =>
    `${item.isVideo ? 'v' : 'p'}:${Math.floor(new Date(item.takenAt).getTime() / 1000)}`;
  const atMoment = new Map<string, typeof groups>();
  for (const group of groups) {
    for (const key of new Set(group.members.map((item) => moment(item)))) {
      atMoment.set(key, [...(atMoment.get(key) ?? []), group]);
    }
  }
  // only when that moment holds just these two groups, so a burst or two cameras never pair the wrong photos
  for (const group of groups) {
    if (group.members.length !== 1) {
      continue;
    }
    const [item] = group.members;
    const atThatMoment = atMoment.get(moment(item)) ?? [];
    const other = atThatMoment.find((candidate) => candidate !== group);
    if (
      atThatMoment.length !== 2 ||
      !other ||
      other.members.length === 0 ||
      other.members.some(({ folder }) => folder === item.folder)
    ) {
      continue;
    }
    if (other.members.length === 1) {
      other.byTime.add(other.members[0].id);
    }
    other.members.push(item);
    other.byTime.add(item.id);
    group.members = [];
  }

  const rank = (folder: string) => {
    const index = choices.prefer.findIndex((name) => name.toLowerCase() === folder.toLowerCase());
    return index === -1 ? choices.prefer.length : index;
  };
  const rows: AlbumFolderVersionRow[] = [];
  let matchedByName = 0;
  let matchedByTime = 0;
  for (const { members, byTime } of groups) {
    if (members.length < 2) {
      continue;
    }
    const front = members
      .filter((item) => folderDisplay(choices, item.folder) === 'with')
      .toSorted(
        (a, b) => rank(a.folder) - rank(b.folder) || a.folder.localeCompare(b.folder) || a.id.localeCompare(b.id),
      )[0];
    if (byTime.size > 0) {
      matchedByTime++;
    } else {
      matchedByName++;
    }
    if (!front) {
      continue;
    }
    for (const item of members) {
      rows.push({ assetId: item.id, frontAssetId: front.id, matchedBy: byTime.has(item.id) ? 'time' : 'name' });
    }
  }
  return { rows, matchedByName, matchedByTime };
};

/** `subfolderOf` in SQL, for the asset row `alias`. */
export const subfolderSql = (folderPath: string, alias = 'asset') => {
  const prefix = folderPath === '/' ? '/' : `${folderPath}/`;
  const folder = folderOf(alias);
  return sql<string>`(case when left(${folder}, char_length(${prefix}::text)) = ${prefix}::text
    then split_part(substr(${folder}, char_length(${prefix}::text) + 1), '/', 1) else '' end)`;
};

/**
 * What an album made from a folder shows of itself, worked out from its choices for a timeline request: `only` one
 * folder (a chip), or the main photos, which leave out the folders not shown with the others and, with "show it once",
 * the versions behind another one.
 */
export type AlbumFolderView = {
  albumId: string;
  folderPath: string;
  /** lower case; set when the album is narrowed to one folder */
  only?: string;
  /** lower case: the folders not shown with the others */
  exclude: string[];
  oneVersion: boolean;
  /** lower case: the show-in-front order */
  prefer: string[];
};

export const albumFolderView = (
  albumId: string,
  folderPath: string,
  choices: AlbumFolderChoices,
  only?: string,
): AlbumFolderView => ({
  albumId,
  folderPath,
  ...(only !== undefined && { only: only.toLowerCase() }),
  // every name not shown with the others is a default or a choice; any other folder joins them
  exclude: [
    ...new Set([...Object.keys(DEFAULT_DISPLAY), ...Object.keys(choices.folders)].map((name) => name.toLowerCase())),
  ].filter((name) => folderDisplay(choices, name) !== 'with'),
  oneVersion: choices.versions === 'one',
  prefer: choices.prefer.map((name) => name.toLowerCase()),
});

/** Works the album's versions out again; true when they changed. */
export const refreshAlbumFolderVersions = async (
  albumRepository: Pick<AlbumRepository, 'getFolderAlbumItems' | 'getFolderVersionRows' | 'replaceFolderVersions'>,
  albumId: string,
  folderPath: string,
  choices: AlbumFolderChoices,
) => {
  const items = await albumRepository.getFolderAlbumItems(albumId, folderPath);
  const result = matchAlbumVersions(items, choices);
  const key = (rows: AlbumFolderVersionRow[]) =>
    rows
      .map(({ assetId, frontAssetId, matchedBy }) => `${assetId}:${frontAssetId}:${matchedBy}`)
      .toSorted()
      .join(',');
  const before = await albumRepository.getFolderVersionRows(albumId);
  const changed = key(before as AlbumFolderVersionRow[]) !== key(result.rows);
  if (changed) {
    await albumRepository.replaceFolderVersions(albumId, result.rows);
  }
  return { ...result, items, changed };
};

/** What one viewer may see (the timeline's own options): their Locked session, hidden content and others' rules. */
export type VersionViewer = HiddenContentQueryOptions & { lockedOwnerId?: string; revealLockedOwnerId?: string };

/**
 * FL-1841: whether the viewer may see the asset row `alias` in the album, by the album read's own rules: on the timeline
 * or in the archive, not trashed or offline, Locked only when it is the viewer's own in an elevated session, and not
 * hidden by their hidden content or by its owner's Locked rules.
 */
export const versionVisibleTo = (alias: string, viewer: VersionViewer) => {
  const parts = [
    sql`${sql.ref(`${alias}.deletedAt`)} is null`,
    sql`${sql.ref(`${alias}.isOffline`)} = false`,
    sql`${sql.ref(`${alias}.type`)} in (${sql.lit(AssetType.Image)}, ${sql.lit(AssetType.Video)})`,
    viewer.lockedOwnerId
      ? sql`(${sql.ref(`${alias}.visibility`)} in (${sql.lit(AssetVisibility.Archive)}, ${sql.lit(AssetVisibility.Timeline)})
          and ${notLockedOrOwnedBy(viewer.lockedOwnerId, alias)})`
      : isDefaultVisible(alias, viewer.revealLockedOwnerId),
  ];
  if (viewer.othersRulesViewerId !== undefined) {
    parts.push(sql`not ${hiddenFromOthers(viewer.othersRulesViewerId, alias)}`);
  }
  const filter = getHiddenContentFilter(viewer);
  if (filter && !viewer.onlyHiddenContent) {
    parts.push(sql`not ${hiddenContentAssetIdExists(sql.ref(`${alias}.id`), filter)}`);
  }
  return sql<boolean>`(${sql.join(parts, sql` and `)})`;
};

/** A version's place in the show-in-front order, then its folder, then its id: lower stands in front. */
const versionRank = (view: AlbumFolderView, alias: string) => {
  const folder = sql`lower(${subfolderSql(view.folderPath, alias)})`;
  return sql`(coalesce(array_position(${view.prefer}::text[], ${folder}), ${sql.lit(PREFER_LAST)}), ${folder}, ${sql.ref(`${alias}.id`)}::text)`;
};
const PREFER_LAST = 100_000;

/**
 * The other versions of the asset row `asset` that are in the album: `album_folder_version` groups them by the version
 * the sync put in front, which here only names the group. Which one stands in front is decided per viewer.
 */
const otherVersions = (view: AlbumFolderView, alias: string) => sql`album_folder_version me
  inner join album_folder_version other on other."albumId" = me."albumId" and other."frontAssetId" = me."frontAssetId"
  inner join album_asset other_member on other_member."albumId" = other."albumId" and other_member."assetId" = other."assetId"
  inner join asset ${sql.id(alias)} on ${sql.ref(`${alias}.id`)} = other."assetId"`;

/**
 * Whether the album view shows the asset row `asset` (see `AlbumFolderView`). With "show it once" a photo stands back
 * when another version of it is one this viewer may see, from a folder shown with the others, and earlier in the
 * show-in-front order (FL-1841): a version hidden from them, by their rules or Locked, leaves the next one in front.
 */
export const albumFolderPredicate = (view: AlbumFolderView, viewer: VersionViewer = {}) => {
  const folder = sql`lower(${subfolderSql(view.folderPath)})`;
  if (view.only !== undefined) {
    return sql<boolean>`${folder} = ${view.only}`;
  }
  const parts = [];
  if (view.exclude.length > 0) {
    parts.push(sql`${folder} <> all(${view.exclude}::text[])`);
  }
  if (view.oneVersion) {
    const otherFolder = sql`lower(${subfolderSql(view.folderPath, 'better')})`;
    parts.push(sql`not exists (select 1 from ${otherVersions(view, 'better')}
      where me."albumId" = ${view.albumId}::uuid and me."assetId" = asset.id and other."assetId" <> asset.id
        ${view.exclude.length > 0 ? sql`and ${otherFolder} <> all(${view.exclude}::text[])` : sql``}
        and ${versionVisibleTo('better', viewer)}
        and ${versionRank(view, 'better')} < ${versionRank(view, 'asset')})`);
  }
  return parts.length > 0 ? sql<boolean>`(${sql.join(parts, sql` and `)})` : sql<boolean>`true`;
};

/** How many versions of the asset row `asset` this viewer may see, itself included (0 when it has none). */
export const albumVersionCount = (view: AlbumFolderView, viewer: VersionViewer = {}) =>
  sql<number>`(select count(*) from ${otherVersions(view, 'version')}
    where me."albumId" = ${view.albumId}::uuid and me."assetId" = asset.id and ${versionVisibleTo('version', viewer)})::int`;
