// Selection state helpers and bulk action descriptors for the library. All
// functions are pure; selections are ordered id arrays (Sets are accepted too).
const toList = (value) =>
  value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value.filter((id) => typeof id === "string")
      : [];
const union = (current, extra) => {
  const seen = new Set(toList(current));
  const next = [...seen];
  for (const id of extra) if (typeof id === "string" && !seen.has(id)) {
    seen.add(id);
    next.push(id);
  }
  return next;
};
const isVideo = (asset) => ["video", "VIDEO"].includes(asset?.type);
const isFavorite = (asset) => Boolean(asset?.favorite ?? asset?.isFavorite);

export const isSelected = (current, id) => toList(current).includes(id);
export function toggleSelection(current, id) {
  const list = toList(current);
  if (typeof id !== "string") return list;
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
/** Select everything between the anchor and the target (inclusive) in visible order. */
export function selectRange(orderedIds, anchorId, targetId, current = []) {
  const order = Array.isArray(orderedIds) ? orderedIds : [];
  const target = order.indexOf(targetId);
  if (target < 0) return toList(current);
  const anchor = order.indexOf(anchorId);
  if (anchor < 0) return union(current, [targetId]);
  const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
  return union(current, order.slice(from, to + 1));
}
export const selectAll = (orderedIds, current = []) =>
  union(current, Array.isArray(orderedIds) ? orderedIds : []);
export const clearSelection = () => [];
/** Add or remove a whole group (used by the per-day select-all checkbox). */
export function selectGroup(current, groupIds, checked) {
  const ids = Array.isArray(groupIds) ? groupIds : [];
  if (checked) return union(current, ids);
  const remove = new Set(ids);
  return toList(current).filter((id) => !remove.has(id));
}
/** "none" | "some" | "all" for a group checkbox. */
export function groupSelectionState(groupIds, current) {
  const ids = Array.isArray(groupIds) ? groupIds : [];
  if (!ids.length) return "none";
  const selected = new Set(toList(current));
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
}
/** The anchor for the next shift-click after `id` was toggled. */
export function nextAnchor(selection, id, previousAnchor = null) {
  const list = toList(selection);
  if (list.includes(id)) return id;
  if (previousAnchor && list.includes(previousAnchor)) return previousAnchor;
  return list.at(-1) ?? null;
}

const GROUP_ORDER = ["primary", "organize", "visibility", "album", "jobs"];
export const bulkActionGroups = [
  { id: "primary", title: "Actions" },
  { id: "organize", title: "Organize" },
  { id: "visibility", title: "Visibility" },
  { id: "album", title: "Album" },
  { id: "jobs", title: "Jobs" },
];

/**
 * Ordered bulk action descriptors for a selection.
 * context: { assets, count, albumId, trash, sharedLink }
 */
export function bulkActions(context = {}) {
  const assets = Array.isArray(context.assets)
    ? context.assets.filter(Boolean)
    : [];
  const count = assets.length || Math.max(0, Number(context.count) || 0);
  const has = count > 0;
  const albumId =
    typeof context.albumId === "string" && context.albumId
      ? context.albumId
      : null;
  const trash = Boolean(context.trash);
  const sharedLink = Boolean(context.sharedLink);
  const live = !trash;
  const any = (predicate) => assets.some(predicate);
  const photos = assets.filter((asset) => !isVideo(asset));
  const videos = assets.filter(isVideo);
  const canLinkLive =
    photos.length === 1 && videos.length === 1 && !photos[0].isLivePhoto;

  const rows = [
    {
      id: "favorite",
      label: "Favorite",
      icon: "mdiHeartOutline",
      group: "primary",
      needs: "assets",
      undoable: true,
      available: live && has && (!assets.length || any((a) => !isFavorite(a))),
    },
    {
      id: "unfavorite",
      label: "Remove from favorites",
      icon: "mdiHeart",
      group: "primary",
      needs: "assets",
      undoable: true,
      available: live && has && any(isFavorite),
    },
    {
      id: "add-to-album",
      label: "Add to album",
      icon: "mdiImageAlbum",
      group: "primary",
      needs: "assets",
      available: live && has,
    },
    {
      id: "create-shared-link",
      label: "Share link",
      icon: "mdiLinkVariant",
      group: "primary",
      needs: "assets",
      available: live && has,
    },
    {
      id: "download",
      label: "Download",
      icon: "mdiDownloadOutline",
      group: "primary",
      needs: "assets",
      available: has,
    },
    {
      id: "delete",
      label: "Delete",
      icon: "mdiDeleteOutline",
      group: "primary",
      needs: "assets",
      danger: true,
      undoable: true,
      available: live && has,
    },
    {
      id: "restore",
      label: "Restore",
      icon: "mdiDeleteRestore",
      group: "primary",
      needs: "trash",
      available: trash && has,
    },
    {
      id: "delete-permanently",
      label: "Delete permanently",
      icon: "mdiDeleteForeverOutline",
      group: "primary",
      needs: "trash",
      danger: true,
      confirm: true,
      available: trash && has,
    },
    {
      id: "stack",
      label: "Stack",
      icon: "mdiLayersPlus",
      group: "organize",
      needs: "assets",
      undoable: true,
      available: live && count >= 2,
    },
    {
      id: "unstack",
      label: "Unstack",
      icon: "mdiLayersOutline",
      group: "organize",
      needs: "stack",
      undoable: true,
      available: live && any((a) => Boolean(a.stackId)),
    },
    {
      id: "link-live-photo",
      label: "Link Live Photo",
      icon: "mdiMotionPlayOutline",
      group: "organize",
      needs: "pair",
      available: live && canLinkLive,
    },
    {
      id: "unlink-live-photo",
      label: "Unlink Live Photo",
      icon: "mdiMotionPauseOutline",
      group: "organize",
      needs: "live",
      available: live && any((a) => Boolean(a.isLivePhoto)),
    },
    {
      id: "tag",
      label: "Tag",
      icon: "mdiTagPlusOutline",
      group: "organize",
      needs: "assets",
      dialog: true,
      undoable: true,
      available: live && has,
    },
    {
      id: "change-date",
      label: "Change date",
      icon: "mdiCalendarEdit",
      group: "organize",
      needs: "assets",
      dialog: true,
      undoable: true,
      available: live && has,
    },
    {
      id: "change-description",
      label: "Change description",
      icon: "mdiTextBoxOutline",
      group: "organize",
      needs: "assets",
      dialog: true,
      undoable: true,
      available: live && has,
    },
    {
      id: "change-location",
      label: "Change location",
      icon: "mdiMapMarkerOutline",
      group: "organize",
      needs: "assets",
      dialog: true,
      undoable: true,
      available: live && has,
    },
    {
      id: "archive",
      label: "Archive",
      icon: "mdiArchiveOutline",
      group: "visibility",
      needs: "assets",
      undoable: true,
      available:
        live && has && (!assets.length || any((a) => a.visibility !== "archive")),
    },
    {
      id: "unarchive",
      label: "Unarchive",
      icon: "mdiArchiveOutline",
      group: "visibility",
      needs: "assets",
      undoable: true,
      available: live && any((a) => a.visibility === "archive"),
    },
    {
      id: "mark-sensitive",
      label: "Mark sensitive",
      icon: "mdiShieldLockOutline",
      group: "visibility",
      needs: "assets",
      undoable: true,
      available: live && has && (!assets.length || any((a) => !a.isSensitive)),
    },
    {
      id: "unmark-sensitive",
      label: "Remove sensitive mark",
      icon: "mdiShieldOutline",
      group: "visibility",
      needs: "assets",
      undoable: true,
      available: live && any((a) => Boolean(a.isSensitive)),
    },
    {
      id: "remove-from-album",
      label: "Remove from album",
      icon: "mdiPlaylistRemove",
      group: "album",
      needs: "album",
      undoable: true,
      available: live && has && Boolean(albumId),
    },
    {
      id: "set-album-cover",
      label: "Set as album cover",
      icon: "mdiImageOutline",
      group: "album",
      needs: "single",
      available: live && count === 1 && Boolean(albumId),
    },
    {
      id: "remove-from-shared-link",
      label: "Remove from shared link",
      icon: "mdiLinkOff",
      group: "album",
      needs: "sharedLink",
      available: live && has && sharedLink,
    },
    {
      id: "refresh-thumbnails",
      label: "Refresh thumbnails",
      icon: "mdiImageMultipleOutline",
      group: "jobs",
      needs: "assets",
      available: has,
    },
    {
      id: "refresh-metadata",
      label: "Refresh metadata",
      icon: "mdiDatabaseRefreshOutline",
      group: "jobs",
      needs: "assets",
      available: has,
    },
    {
      id: "refresh-encoded",
      label: "Refresh encoded video",
      icon: "mdiMovieEditOutline",
      group: "jobs",
      needs: "video",
      available: has && (!assets.length || videos.length > 0),
    },
  ];
  return rows
    .map((row) => ({
      danger: false,
      dialog: false,
      confirm: false,
      undoable: false,
      ...row,
      albumId: row.needs === "album" || row.needs === "single" ? albumId : undefined,
    }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

const TOGGLE_PATCHES = {
  favorite: { favorite: true },
  unfavorite: { favorite: false },
  archive: { visibility: "archive" },
  unarchive: { visibility: "timeline" },
  "mark-sensitive": { isSensitive: true },
  "unmark-sensitive": { isSensitive: false },
  unstack: { stackId: null },
};
const ACTION_FIELDS = {
  favorite: ["favorite"],
  unfavorite: ["favorite"],
  archive: ["visibility"],
  unarchive: ["visibility"],
  "mark-sensitive": ["isSensitive"],
  "unmark-sensitive": ["isSensitive"],
  stack: ["stackId", "stackPrimary"],
  unstack: ["stackId", "stackPrimary"],
  tag: ["tagIds"],
  "change-date": ["takenAt", "date"],
  "change-description": ["description"],
  "change-location": ["city", "state", "country", "latitude", "longitude"],
  "remove-from-album": ["albumIds"],
  delete: ["visibility", "trashed"],
};
/** Forward patch for simple toggle actions; null for actions that need a payload. */
export const actionPatch = (actionId) =>
  TOGGLE_PATCHES[actionId] ? { ...TOGGLE_PATCHES[actionId] } : null;
/** Which asset fields an action changes (what `captureBefore` should snapshot). */
export const actionFields = (actionId) => [...(ACTION_FIELDS[actionId] || [])];
/** Snapshot the listed fields of each asset so the change can be reverted. */
export function captureBefore(assets, fields) {
  const keys = Array.isArray(fields) ? fields : [];
  const before = {};
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset.id !== "string") continue;
    before[asset.id] = Object.fromEntries(
      keys.map((key) => [
        key,
        Array.isArray(asset[key]) ? [...asset[key]] : (asset[key] ?? null),
      ]),
    );
  }
  return before;
}
/** An undo record the coordinator keeps for the undo toast. */
export function undoRecord(action, ids, before = {}, extra = {}) {
  const list = [...new Set(toList(ids))];
  const snapshot = {};
  for (const id of list)
    if (before && typeof before === "object" && before[id])
      snapshot[id] = { ...before[id] };
  return {
    id: `${action}:${list.join(",")}`,
    action,
    ids: list,
    before: snapshot,
    label: actionLabel(action, list.length),
    ...extra,
  };
}
/** [id, patch] pairs that revert an undo record via changeLibraryAsset. */
export const undoPatches = (record) =>
  record && record.before
    ? record.ids
        .filter((id) => record.before[id])
        .map((id) => [id, { ...record.before[id] }])
    : [];

const plural = (count, noun = "item") =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
/** Past-tense status copy for toasts. */
export function actionLabel(action, count) {
  const items = plural(count);
  const labels = {
    favorite: `Added ${items} to favorites`,
    unfavorite: `Removed ${items} from favorites`,
    "add-to-album": `Added ${items} to the album`,
    "create-shared-link": `Shared link created for ${items}`,
    download: `Preparing ${items} to download`,
    delete: `Moved ${items} to trash`,
    "delete-permanently": `Deleted ${items} permanently`,
    restore: `Restored ${items}`,
    stack: `Stacked ${items}`,
    unstack: `Unstacked ${items}`,
    "link-live-photo": "Linked Live Photo",
    "unlink-live-photo": `Unlinked ${items}`,
    tag: `Tagged ${items}`,
    "change-date": `Changed the date on ${items}`,
    "change-description": `Changed the description on ${items}`,
    "change-location": `Changed the location on ${items}`,
    archive: `Archived ${items}`,
    unarchive: `Unarchived ${items}`,
    "mark-sensitive": `Marked ${items} sensitive`,
    "unmark-sensitive": `Removed the sensitive mark from ${items}`,
    "remove-from-album": `Removed ${items} from the album`,
    "remove-from-shared-link": `Removed ${items} from the shared link`,
    "set-album-cover": "Album cover updated",
    "refresh-thumbnails": `Refreshing thumbnails for ${items}`,
    "refresh-metadata": `Refreshing metadata for ${items}`,
    "refresh-encoded": `Re-encoding ${items}`,
  };
  return labels[action] || `Updated ${items}`;
}
