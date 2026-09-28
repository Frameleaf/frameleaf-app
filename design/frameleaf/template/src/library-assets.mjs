import { media } from "./media.js";
import { classifyLocked } from "./locked-content.mjs";
import { parseUtilities, utilityStorageKey } from "./utilities-data.mjs";

export const libraryAssetsKey = "frameleaf:library-assets:v1";
/** Any collection id shaped like a slug; the collections model is the authority for existence. */
const albumId = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const recipients = ["Jamie", "Emma"];
const visibilities = ["timeline", "archive", "locked"];
const booleans = [
  "favorite",
  "isLocked",
  "isSuppressed",
  "isSensitive",
  "isNsfw",
  "isEdited",
];
const texts = {
  description: 4096,
  takenAt: 40,
  date: 10,
  city: 120,
  state: 120,
  country: 120,
  stackId: 64,
  coverAlbumId: 64,
};
const numbers = { latitude: [-90, 90], longitude: [-180, 180] };
const lists = { tagIds: 64 };
const plainText = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u001f]/.test(value);
const finiteIn = (value, [min, max]) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const tagList = (value, limit) =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every((id) => plainText(id, 64) && id.trim());
const record = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};
const selection = (values, choices) => [
  ...new Set(values.filter((id) => choices.includes(id))),
];
export function parseLibraryAssets(raw) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
  if (
    !record(data) ||
    field(data, "version") !== 1 ||
    !record(field(data, "assets"))
  )
    return {};
  return Object.fromEntries(
    media.flatMap((asset) => {
      const entry = field(data.assets, asset.id);
      if (!record(entry)) return [];
      const next = {};
      for (const key of booleans)
        if (typeof field(entry, key) === "boolean")
          next[key] = field(entry, key);
      if (visibilities.includes(field(entry, "visibility")))
        next.visibility = field(entry, "visibility");
      for (const [key, limit] of Object.entries(texts))
        if (plainText(field(entry, key), limit)) next[key] = field(entry, key);
        else if (key === "stackId" && field(entry, key) === null)
          next.stackId = null;
      for (const [key, range] of Object.entries(numbers))
        if (finiteIn(field(entry, key), range)) next[key] = field(entry, key);
      for (const [key, limit] of Object.entries(lists))
        if (tagList(field(entry, key), limit))
          next[key] = [...new Set(field(entry, key).map((id) => id.trim()))];
      if (Array.isArray(field(entry, "albumIds")))
        next.albumIds = [...new Set(field(entry, "albumIds").filter(albumId))];
      if (Array.isArray(field(entry, "sharedWith")))
        next.sharedWith = selection(field(entry, "sharedWith"), recipients);
      return [[asset.id, next]];
    }),
  );
}
export function readLibraryAssets(storage = localStorage) {
  return parseLibraryAssets(storage.getItem(libraryAssetsKey));
}
export function mergeLibraryAssets(overrides, utilities) {
  const valid = parseLibraryAssets({ version: 1, assets: overrides || {} });
  return media.map((asset) => {
    const trash = utilities?.rows?.find(
      (row) => row.id === `library-${asset.id}`,
    );
    const override = valid[asset.id] || {};
    return {
      ...asset,
      ...override,
      ...(override.tagIds ? { tags: override.tagIds } : {}),
      ...(override.date && !override.takenAt
        ? { takenAt: `${override.date}T${(asset.takenAt || "T07:14:00").split("T")[1]}` }
        : {}),
      ...(["Trashed", "Deleted"].includes(trash?.status)
        ? { status: trash.status, deletedAt: trash.deletedAt }
        : {}),
    };
  });
}
function validPatch(patch) {
  if (!record(patch) || !Reflect.ownKeys(patch).length)
    throw Error("Choose a supported library change.");
  const result = {};
  for (const key of Reflect.ownKeys(patch)) {
    const value = field(patch, key);
    if (booleans.includes(key) && typeof value === "boolean")
      result[key] = value;
    else if (key === "visibility" && ["timeline", "archive"].includes(value))
      result[key] = value;
    else if (key in texts && (plainText(value, texts[key]) || (key === "stackId" && value === null)))
      result[key] = value;
    else if (key in numbers && finiteIn(value, numbers[key]))
      result[key] = value;
    else if (key in lists && tagList(value, lists[key]))
      result[key] = [...new Set(value.map((id) => id.trim()))];
    else if (key === "albumIds" && Array.isArray(value) && value.every(albumId))
      result[key] = [...new Set(value)];
    else if (
      key === "sharedWith" &&
      Array.isArray(value) &&
      value.every((id) => recipients.includes(id))
    )
      result[key] = [...new Set(value)];
    else
      throw Error(
        "This library change contains an unsupported value. Reload the item and try again.",
      );
  }
  return result;
}
function requireLiveAsset(id, actorId, state) {
  const asset = media.find((row) => row.id === id);
  const row = state.rows.find((item) => item.id === `library-${id}`);
  if (
    !asset ||
    asset.ownerId !== actorId ||
    !row ||
    row.ownerId !== actorId ||
    ["Trashed", "Deleted"].includes(row.status)
  )
    throw Error("This item is no longer available to change.");
  return { asset, row };
}
/** Recheck latest persisted lifecycle state; collection membership never grants ownership. */
export function changeLibraryAsset(
  id,
  patch,
  actorId = "taylor",
  storage = localStorage,
) {
  const state = parseUtilities(storage.getItem(utilityStorageKey));
  const { asset } = requireLiveAsset(id, actorId, state);
  const change = validPatch(patch);
  const current = readLibraryAssets(storage);
  const result = { ...current[id], ...change };
  if (change.sharedWith?.length && classifyLocked({ ...asset, ...result }))
    throw Error("Remove the Sensitive mark before sharing this item.");
  const next = { ...current, [id]: result };
  storage.setItem(
    libraryAssetsKey,
    JSON.stringify({ version: 1, assets: next }),
  );
  return next;
}
export function trashLibraryAsset(
  id,
  actorId = "taylor",
  storage = localStorage,
) {
  const state = parseUtilities(storage.getItem(utilityStorageKey));
  const { asset: source, row } = requireLiveAsset(id, actorId, state);
  const asset = { ...source, ...readLibraryAssets(storage)[id] };
  const at = new Date().toISOString();
  const next = {
    ...state,
    rows: state.rows.map((item) =>
      item.id === row.id
        ? {
            ...item,
            status: "Trashed",
            deletedAt: at,
            isLocked: asset.isLocked === true || asset.visibility === "locked",
            isSuppressed: asset.isSuppressed === true,
            isSensitive: asset.isSensitive === true,
            isNsfw: asset.isNsfw === true,
          }
        : item,
    ),
    history: [
      { title: `Moved ${row.name} to trash`, at },
      ...state.history,
    ].slice(0, 30),
  };
  storage.setItem(utilityStorageKey, JSON.stringify(next));
  return next;
}

/** Apply one validated patch to many owned assets in a single storage write; returns the new overrides. */
export function changeLibraryAssets(
  ids,
  patch,
  actorId = "taylor",
  storage = localStorage,
) {
  const state = parseUtilities(storage.getItem(utilityStorageKey));
  const change = validPatch(patch);
  const current = readLibraryAssets(storage);
  const next = { ...current };
  const changed = [];
  for (const id of [...new Set(ids)]) {
    const { asset } = requireLiveAsset(id, actorId, state);
    const result = { ...current[id], ...change };
    if (change.sharedWith?.length && classifyLocked({ ...asset, ...result }))
      throw Error("Remove the Sensitive mark before sharing this item.");
    next[id] = result;
    changed.push(id);
  }
  storage.setItem(
    libraryAssetsKey,
    JSON.stringify({ version: 1, assets: next }),
  );
  return { overrides: next, changed };
}
