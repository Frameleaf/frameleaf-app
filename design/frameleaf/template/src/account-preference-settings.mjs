import {
  applyAccountPreferences,
  normalizeAccountPreferences,
} from "./account-preferences.mjs";

const GiB = 1024 ** 3;
// Exact IDs from settings-catalog.mjs / settings-advanced.mjs. Only true source equivalents belong here.
const mappings = [
  ["foldersEnabled", ["folders", "enabled"]],
  ["foldersSidebar", ["folders", "sidebarWeb"]],
  ["memories", ["memories", "enabled"]],
  ["memoriesSidebar", ["memories", "sidebarWeb"]],
  ["memoriesDuration", ["memories", "duration"], "integer"],
  ["peopleEnabled", ["people", "enabled"]],
  ["peopleSidebar", ["people", "sidebarWeb"]],
  ["peopleMinimumFaces", ["people", "minimumFaces"], "integer"],
  ["ratingsEnabled", ["ratings", "enabled"]],
  ["sharedLinksEnabled", ["sharedLinks", "enabled"]],
  ["sharedLinksSidebar", ["sharedLinks", "sidebarWeb"]],
  ["tagsEnabled", ["tags", "enabled"]],
  ["tagsSidebar", ["tags", "sidebarWeb"]],
  ["castEnabled", ["cast", "gCastEnabled"]],
  ["recentlyAddedSidebar", ["recentlyAdded", "sidebarWeb"]],
  ["personalEmailEnabled", ["emailNotifications", "enabled"]],
  ["personalAlbumInviteEmail", ["emailNotifications", "albumInvite"]],
  ["personalAlbumUpdateEmail", ["emailNotifications", "albumUpdate"]],
  ["advancedDownloadArchiveSize", ["download", "archiveSize"], "gib"],
  ["advancedDownloadMotionVideo", ["download", "includeEmbeddedVideos"]],
  ["showSupportBadge", ["purchase", "showSupportBadge"]],
];
export const ACCOUNT_PREFERENCE_SETTING_IDS = Object.freeze(
  mappings.map(([id]) => id),
);
const plainObject = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function decode(value, kind, id) {
  if (!kind) {
    if (typeof value !== "boolean")
      throw new Error(`${id}: choose true or false.`);
    return value;
  }
  const numeric =
    typeof value === "number" ||
    (typeof value === "string" &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()));
  if (!numeric || !Number.isFinite(Number(value)))
    throw new Error(`${id}: enter a valid number.`);
  const result =
    kind === "gib" ? Math.round(Number(value) * GiB) : Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(
      `${id}: use a positive whole ${kind === "gib" ? "byte count" : "number"}.`,
    );
  return result;
}

/** A canonical account update yields only mapped personal controls; no server/device settings are included. */
export function accountPreferencesToSettings(preferences) {
  const complete = normalizeAccountPreferences(preferences);
  return Object.fromEntries(
    mappings.map(([id, path, kind]) => {
      const value = path.reduce((group, key) => group[key], complete);
      return [id, kind === "gib" ? value / GiB : value];
    }),
  );
}

/** Only submitted, changed mapped fields become a partial update. Unmapped private data stays in the account. */
export function settingsToAccountPreferencesPatch(
  settings,
  previousSettings = {},
) {
  if (!plainObject(settings) || !plainObject(previousSettings))
    throw new Error("Personal settings must be plain objects.");
  const patch = {};
  for (const [id, path, kind] of mappings) {
    if (
      !Object.hasOwn(settings, id) ||
      Object.is(settings[id], previousSettings[id])
    )
      continue;
    const value = decode(settings[id], kind, id);
    if (Object.hasOwn(previousSettings, id)) {
      let prior;
      try {
        prior = decode(previousSettings[id], kind, id);
      } catch {
        /* A valid new value can repair older malformed state. */
      }
      if (Object.is(value, prior)) continue;
    }
    let destination = patch;
    for (const key of path.slice(0, -1)) destination = destination[key] ||= {};
    destination[path.at(-1)] = value;
  }
  applyAccountPreferences(undefined, patch); // Reuse source-shaped validation; return the partial, not defaults.
  return patch;
}

// Intentionally omitted: albumSort (also offers unsupported "Shared album order"), privacy/suppression,
// purchase.hideBuyButtonUntil, avatar/profile fields, birthday/video-moment rules, and device preferences.
