// Command index and ranking for the command palette and the search dialog's
// "Go to" section. Pure functions; the coordinator supplies the inputs.
export const COMMANDS_KEY = "frameleaf:commands:v1";
export const RECENT_COMMAND_LIMIT = 8;

export const commandGroups = Object.freeze([
  { id: "actions", title: "Actions" },
  { id: "pages", title: "Pages" },
  { id: "settings", title: "Settings" },
  { id: "people", title: "People" },
  { id: "collections", title: "Albums" },
  { id: "places", title: "Places" },
]);
const groupOrder = new Map(commandGroups.map((group, index) => [group.id, index]));

const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value) => (typeof value === "string" ? value.trim() : "");
const list = (value) => (Array.isArray(value) ? value.filter(record) : []);
export const foldText = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
const words = (value) => foldText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const keywordText = (value) =>
  Array.isArray(value) ? value.map(string).filter(Boolean).join(" ") : string(value);

function command(group, id, title, extra = {}) {
  const subtitle = string(extra.subtitle);
  const keywords = keywordText(extra.keywords);
  return {
    id,
    group,
    title,
    subtitle,
    icon: string(extra.icon) || defaultIcons[group],
    shortcut: string(extra.shortcut),
    keywords,
    payload: extra.payload || { kind: group, id },
    run: typeof extra.run === "function" ? extra.run : undefined,
    haystack: foldText(`${subtitle} ${keywords}`),
    folded: foldText(title),
  };
}
const defaultIcons = {
  actions: "mdiLightbulbOnOutline",
  pages: "mdiViewGridOutline",
  settings: "mdiCogOutline",
  people: "mdiAccountOutline",
  collections: "mdiImageAlbum",
  places: "mdiMapMarkerOutline",
};

/**
 * Build the flat command list. Every input is optional:
 * pages [{ id, title, subtitle, icon, keywords, shortcut }]
 * settingsAreas [{ id, title, description, icon, group }] (settings-catalog shape)
 * settingsSections { [areaId]: [{ id, title, description }] } (optional)
 * actions [{ id, title, subtitle, icon, keywords, shortcut, run }]
 * people [{ id, name, count }]
 * collections [{ id, title | name, kind, count }]
 * places [{ value | name, field, count }]
 */
export function buildCommandIndex(input = {}) {
  const source = record(input) ? input : {};
  const result = [];
  for (const item of list(source.actions)) {
    const id = string(item.id),
      title = string(item.title);
    if (!id || !title) continue;
    result.push(
      command("actions", `action:${id}`, title, {
        ...item,
        payload: { kind: "action", id },
      }),
    );
  }
  for (const item of list(source.pages)) {
    const id = string(item.id),
      title = string(item.title);
    if (!id || !title) continue;
    result.push(
      command("pages", `page:${id}`, title, {
        ...item,
        subtitle: string(item.subtitle) || "Page",
        payload: { kind: "page", id },
      }),
    );
  }
  const areaTitles = new Map();
  for (const area of list(source.settingsAreas)) {
    const id = string(area.id),
      title = string(area.title);
    if (!id || !title) continue;
    areaTitles.set(id, title);
    result.push(
      command("settings", `settings:${id}`, title, {
        icon: area.icon,
        subtitle: `Settings · ${string(area.group) || "Command center"}`,
        keywords: [string(area.description), string(area.group), ...keywordList(area.keywords)],
        payload: { kind: "settings", area: id, section: "" },
      }),
    );
  }
  if (record(source.settingsSections)) {
    for (const [areaId, sections] of Object.entries(source.settingsSections)) {
      if (!areaTitles.has(areaId)) continue;
      for (const section of list(sections)) {
        const id = string(section.id),
          title = string(section.title);
        if (!id || !title) continue;
        result.push(
          command("settings", `settings:${areaId}/${id}`, title, {
            icon:
              string(section.icon) ||
              list(source.settingsAreas).find((area) => area.id === areaId)?.icon,
            subtitle: `${areaTitles.get(areaId)} · Settings`,
            keywords: [
              string(section.description),
              areaTitles.get(areaId),
              ...keywordList(section.keywords),
            ],
            payload: { kind: "settings", area: areaId, section: id },
          }),
        );
      }
    }
  }
  for (const person of list(source.people)) {
    const id = string(person.id),
      name = string(person.name);
    if (!id || !name) continue;
    result.push(
      command("people", `person:${id}`, name, {
        icon: person.icon,
        subtitle: countLabel(person.count, "photo") || "Person",
        keywords: ["person", "people", "face"],
        payload: { kind: "person", id },
      }),
    );
  }
  for (const item of list(source.collections)) {
    const id = string(item.id),
      title = string(item.title) || string(item.name);
    if (!id || !title) continue;
    const kind = string(item.kind) || "album";
    result.push(
      command("collections", `collection:${kind}:${id}`, title, {
        icon:
          string(item.icon) ||
          { album: "mdiImageAlbum", space: "mdiAccountGroupOutline", tag: "mdiTagOutline" }[
            kind
          ],
        subtitle: [kindLabel(kind), countLabel(item.count, "item")]
          .filter(Boolean)
          .join(" · "),
        keywords: [kind, kindLabel(kind), ...keywordList(item.keywords)],
        payload: { kind: "collection", type: kind, id },
      }),
    );
  }
  for (const place of list(source.places)) {
    const value = string(place.value) || string(place.name);
    if (!value) continue;
    const field = ["city", "state", "country"].includes(place.field)
      ? place.field
      : "city";
    result.push(
      command("places", `place:${field}:${foldText(value)}`, value, {
        icon: place.icon,
        subtitle: [
          { city: "City", state: "State / province", country: "Country" }[field],
          countLabel(place.count, "photo"),
        ]
          .filter(Boolean)
          .join(" · "),
        keywords: ["place", "location", field],
        payload: { kind: "place", field, value },
      }),
    );
  }
  const seen = new Set();
  return result.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
const keywordList = (value) =>
  Array.isArray(value) ? value.map(string).filter(Boolean) : value ? [string(value)] : [];
const kindLabel = (kind) =>
  ({ album: "Album", space: "Space", tag: "Tag", smart: "Smart album" })[kind] ||
  kind[0].toUpperCase() + kind.slice(1);
const countLabel = (count, noun) =>
  Number.isInteger(count) && count >= 0
    ? `${count.toLocaleString("en")} ${noun}${count === 1 ? "" : "s"}`
    : "";

// Scoring tiers. Higher wins; ties fall back to group order and title.
const tiers = {
  exact: 1000,
  prefix: 900,
  wordStart: 800,
  fuzzy: 600,
  keywordPrefix: 500,
  keywordWordStart: 400,
};
function subsequenceScore(haystack, needle) {
  // Every needle character appears in order; tighter runs score higher.
  let index = 0,
    gaps = 0,
    previous = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found < 0) return 0;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    index = found + 1;
  }
  return Math.max(1, 100 - Math.min(99, gaps));
}
function termScore(item, term) {
  if (!term) return 0;
  const title = item.folded;
  if (title === term) return tiers.exact;
  if (title.startsWith(term)) return tiers.prefix + Math.max(0, 60 - title.length);
  if (words(title).some((word) => word.startsWith(term)))
    return tiers.wordStart + Math.max(0, 60 - title.length);
  const fuzzy = subsequenceScore(title, term);
  if (fuzzy) return tiers.fuzzy - 100 + fuzzy;
  const keywords = item.haystack;
  if (!keywords) return 0;
  if (keywords.startsWith(term)) return tiers.keywordPrefix;
  // Keywords and subtitles match on word starts only; fuzzy matching there
  // surfaces too many unrelated commands.
  return words(keywords).some((word) => word.startsWith(term))
    ? tiers.keywordWordStart
    : 0;
}
export function scoreCommand(item, query) {
  const terms = words(query);
  if (!terms.length || !record(item)) return 0;
  let total = 0;
  for (const term of terms) {
    const score = termScore(item, term);
    if (!score) return 0;
    total += score;
  }
  return Math.round(total / terms.length);
}
function compareCommands(a, b) {
  return (
    b.score - a.score ||
    (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99) ||
    a.title.localeCompare(b.title, undefined, { numeric: true })
  );
}
/** Ranked matches for a query. An empty query returns nothing; callers show recents instead. */
export function searchCommands(index, query, limit = 12) {
  const items = Array.isArray(index) ? index : [];
  const text = stripCommandPrefix(query);
  if (!words(text).length) return [];
  const max = Number.isInteger(limit) && limit > 0 ? limit : 12;
  return items
    .map((item) => ({ ...item, score: scoreCommand(item, text) }))
    .filter((item) => item.score > 0)
    .sort(compareCommands)
    .slice(0, max);
}
/** Group ranked commands in the canonical group order, skipping empty groups. */
export function groupCommands(commands) {
  const items = Array.isArray(commands) ? commands : [];
  return commandGroups
    .map((group) => ({
      ...group,
      commands: items.filter((item) => item.group === group.id),
    }))
    .filter((group) => group.commands.length);
}
/** Only groups that make sense as a "Go to" list inside the library search. */
export function navigationCommands(index) {
  return (Array.isArray(index) ? index : []).filter((item) =>
    ["pages", "settings", "actions"].includes(item.group),
  );
}

export const isCommandQuery = (text) => /^\s*>/.test(String(text ?? ""));
export const stripCommandPrefix = (text) =>
  String(text ?? "")
    .replace(/^\s*>\s*/, "")
    .trim();

/** Recent command IDs persist as a bounded string list under COMMANDS_KEY. */
export function parseRecentCommands(raw) {
  let source = raw;
  if (typeof source === "string") {
    if (source.length > 20_000) return [];
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!record(source) || source.version !== 1 || !Array.isArray(source.recent))
    return [];
  const result = [];
  for (const id of source.recent.slice(0, RECENT_COMMAND_LIMIT * 2)) {
    if (typeof id !== "string" || !id || id.length > 200 || result.includes(id))
      continue;
    result.push(id);
    if (result.length >= RECENT_COMMAND_LIMIT) break;
  }
  return result;
}
export function rememberCommand(recent, id) {
  const current = Array.isArray(recent) ? recent : [];
  if (typeof id !== "string" || !id) return current;
  return [id, ...current.filter((item) => item !== id)].slice(
    0,
    RECENT_COMMAND_LIMIT,
  );
}
export function serializeRecentCommands(recent) {
  return JSON.stringify({ version: 1, recent: rememberCommand(recent, "").slice() });
}
export function loadRecentCommands(storage) {
  try {
    return parseRecentCommands(storage?.getItem(COMMANDS_KEY));
  } catch {
    return [];
  }
}
export function saveRecentCommands(storage, recent) {
  try {
    storage?.setItem(COMMANDS_KEY, serializeRecentCommands(recent));
    return true;
  } catch {
    return false;
  }
}
/** Resolve stored IDs against the live index, dropping commands that no longer exist. */
export function recentCommands(index, recent) {
  const items = Array.isArray(index) ? index : [];
  return (Array.isArray(recent) ? recent : [])
    .map((id) => items.find((item) => item.id === id))
    .filter(Boolean);
}

/** "mod+shift+p" → ["⌘", "⇧", "P"] on Apple platforms, ["Ctrl", "Shift", "P"] elsewhere. */
export function shortcutKeys(shortcut, apple = false) {
  const parts = string(shortcut).toLowerCase().split("+").filter(Boolean);
  const names = {
    mod: apple ? "⌘" : "Ctrl",
    cmd: apple ? "⌘" : "Ctrl",
    ctrl: apple ? "⌃" : "Ctrl",
    shift: apple ? "⇧" : "Shift",
    alt: apple ? "⌥" : "Alt",
    enter: "↩",
    escape: "Esc",
    esc: "Esc",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    space: "Space",
  };
  return parts.map((part) => names[part] || part.toUpperCase());
}
