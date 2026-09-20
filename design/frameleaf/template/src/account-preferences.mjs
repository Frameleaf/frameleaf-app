// Sources: server/src/utils/preferences.ts, dtos/user-preferences.dto.ts and enum.ts.
// These are account preferences, not administrator-enforced module permissions.
export const AVATAR_COLORS = Object.freeze([
  "primary",
  "pink",
  "red",
  "yellow",
  "blue",
  "green",
  "purple",
  "orange",
  "gray",
  "amber",
]);
export const ACCOUNT_FEATURES = Object.freeze(
  [
    {
      id: "folders",
      label: "Folders",
      description: "Browse photos using their folder organization.",
      enabledPath: ["folders", "enabled"],
      sidebarPath: ["folders", "sidebarWeb"],
    },
    {
      id: "memories",
      label: "Memories",
      description: "Show memories in your library.",
      enabledPath: ["memories", "enabled"],
      sidebarPath: ["memories", "sidebarWeb"],
    },
    {
      id: "people",
      label: "People",
      description: "Show people and face organization tools.",
      enabledPath: ["people", "enabled"],
      sidebarPath: ["people", "sidebarWeb"],
    },
    {
      id: "sharedLinks",
      label: "Shared links",
      description:
        "Show shared-link tools. Existing links stay active when these controls are hidden.",
      enabledPath: ["sharedLinks", "enabled"],
      sidebarPath: ["sharedLinks", "sidebarWeb"],
    },
    {
      id: "tags",
      label: "Tags",
      description: "Show tags and tag-based organization tools.",
      enabledPath: ["tags", "enabled"],
      sidebarPath: ["tags", "sidebarWeb"],
    },
    {
      id: "ratings",
      label: "Ratings",
      description: "Show star ratings and rating controls.",
      enabledPath: ["ratings", "enabled"],
    },
    {
      id: "cast",
      label: "Google Cast",
      description: "Enable Google Cast controls for this account.",
      enabledPath: ["cast", "gCastEnabled"],
    },
  ].map((feature) =>
    Object.freeze({
      ...feature,
      enabledPath: Object.freeze(feature.enabledPath),
      ...(feature.sidebarPath
        ? { sidebarPath: Object.freeze(feature.sidebarPath) }
        : {}),
    }),
  ),
);

export function createAccountPreferences() {
  return {
    albums: { defaultAssetOrder: "desc" },
    folders: { enabled: false, sidebarWeb: false },
    memories: { enabled: true, duration: 5, sidebarWeb: false },
    people: { enabled: true, sidebarWeb: false, minimumFaces: 3 },
    sharedLinks: { enabled: true, sidebarWeb: false },
    ratings: { enabled: false },
    tags: { enabled: false, sidebarWeb: false },
    emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
    download: { archiveSize: 4 * 1024 ** 3, includeEmbeddedVideos: false },
    purchase: {
      showSupportBadge: true,
      hideBuyButtonUntil: new Date(2022, 1, 12).toISOString(),
    },
    cast: { gCastEnabled: false },
    privacy: { suppression: { tagIds: [], personIds: [], scope: "owned" } },
    recentlyAdded: { sidebarWeb: false },
  };
}

const invalid = (path, expectation) => {
  throw new Error(`${path}: ${expectation}.`);
};
const boolean = (value, path) =>
  typeof value === "boolean" ? value : invalid(path, "choose true or false");
const positiveInteger = (value, path) =>
  Number.isSafeInteger(value) && value >= 1
    ? value
    : invalid(path, "enter a whole number of at least 1");
const oneOf = (choices) => (value, path) =>
  choices.includes(value)
    ? value
    : invalid(path, `choose ${choices.join(" or ")}`);
const uuidV4 =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const uuidList = (value, path) => {
  if (
    !Array.isArray(value) ||
    [...value].some((id) => typeof id !== "string" || !uuidV4.test(id))
  )
    invalid(path, "use an array of valid UUID version 4 identifiers");
  // Keep order and IDs exactly as supplied. Preferences never contain private tag/person names.
  return [...value];
};
const dateString = (value, path) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    invalid(path, "use a valid calendar date or ISO timestamp");
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    !Number.isFinite(Date.parse(value))
  )
    invalid(path, "use a valid calendar date or ISO timestamp");
  return value;
};
const visibility = { enabled: boolean, sidebarWeb: boolean };
const schema = {
  albums: { defaultAssetOrder: oneOf(["asc", "desc"]) },
  folders: visibility,
  memories: { ...visibility, duration: positiveInteger },
  people: { ...visibility, minimumFaces: positiveInteger },
  sharedLinks: visibility,
  ratings: { enabled: boolean },
  tags: visibility,
  emailNotifications: {
    enabled: boolean,
    albumInvite: boolean,
    albumUpdate: boolean,
  },
  download: { archiveSize: positiveInteger, includeEmbeddedVideos: boolean },
  purchase: { showSupportBadge: boolean, hideBuyButtonUntil: dateString },
  cast: { gCastEnabled: boolean },
  privacy: {
    suppression: {
      tagIds: uuidList,
      personIds: uuidList,
      scope: oneOf(["owned", "visible"]),
    },
  },
  recentlyAdded: { sidebarWeb: boolean },
};
function mergeValidated(base, value, fields, path = "preferences") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(path, "use a plain object");
  const next = structuredClone(base);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.hasOwn(fields, key))
      invalid(path, "contains an unknown preference");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      invalid(path, "use plain values without getters");
    const setting = descriptor.value;
    if (setting === undefined) continue; // Optional DTO properties and older absent fields retain defaults/current values.
    const rule = fields[key],
      label = `${path}.${key}`;
    next[key] =
      typeof rule === "function"
        ? rule(setting, label)
        : mergeValidated(next[key], setting, rule, label);
  }
  return next;
}

/** Older accounts may have no preferences or only some groups. Unknown fields and malformed values fail closed. */
export function normalizeAccountPreferences(value) {
  return value === undefined
    ? createAccountPreferences()
    : mergeValidated(createAccountPreferences(), value, schema);
}
/** Merge a validated deep partial without mutating either account's state or the submitted patch. */
export function applyAccountPreferences(current, patch) {
  return mergeValidated(normalizeAccountPreferences(current), patch, schema);
}
