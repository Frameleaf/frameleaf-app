import { media } from "./media.js";
import { classifyLocked } from "./locked-content.mjs";
import { parseUtilities, utilityStorageKey } from "./utilities-data.mjs";

export const libraryAssetsKey = "frameleaf:library-assets:v1";
const albums = ["family", "summer-rockies", "everyday", "winter-2026"];
const recipients = ["Jamie", "Emma"];
const visibilities = ["timeline", "archive", "locked"];
const booleans = [
  "favorite",
  "isLocked",
  "isSuppressed",
  "isSensitive",
  "isNsfw",
];
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
      for (const [key, choices] of [
        ["albumIds", albums],
        ["sharedWith", recipients],
      ])
        if (Array.isArray(field(entry, key)))
          next[key] = selection(field(entry, key), choices);
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
    return {
      ...asset,
      ...valid[asset.id],
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
    else if (
      ["albumIds", "sharedWith"].includes(key) &&
      Array.isArray(value) &&
      value.every((id) =>
        (key === "albumIds" ? albums : recipients).includes(id),
      )
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
