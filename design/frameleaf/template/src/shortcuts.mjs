// Declarative library keyboard shortcuts. `key` is compared against
// KeyboardEvent.key (case-insensitive for single letters). `mod` means Cmd on Mac or
// Ctrl elsewhere; unlisted modifiers must NOT be pressed, except shift: "any".
export const shortcuts = [
  { id: "select", key: "x", keys: ["X"], label: "Select or deselect the focused item", group: "general" },
  { id: "focus-previous", key: "ArrowLeft", keys: ["←"], label: "Move focus left", group: "general" },
  { id: "focus-next", key: "ArrowRight", keys: ["→"], label: "Move focus right", group: "general" },
  { id: "focus-up", key: "ArrowUp", keys: ["↑"], label: "Move focus up a row", group: "general" },
  { id: "focus-down", key: "ArrowDown", keys: ["↓"], label: "Move focus down a row", group: "general" },
  { id: "select-range", mouse: true, keys: ["⇧", "Click"], label: "Select a range", group: "general" },
  { id: "select-all", key: "a", mod: true, keys: ["Mod", "A"], label: "Select all", group: "general" },
  { id: "clear-selection", key: "d", mod: true, keys: ["Mod", "D"], label: "Clear selection", group: "general" },
  { id: "jump-day", key: "d", keys: ["D"], label: "Group by day", group: "general" },
  { id: "jump-month", key: "m", keys: ["M"], label: "Group by month", group: "general" },
  { id: "jump-year", key: "y", keys: ["Y"], label: "Group by year", group: "general" },
  { id: "go-to-date", key: "g", keys: ["G"], label: "Go to a date", group: "general" },
  { id: "focus-search", key: "/", keys: ["/"], label: "Search", group: "general" },
  { id: "help", key: "?", shift: "any", keys: ["?"], label: "Keyboard shortcuts", group: "general" },
  { id: "rate-1", key: "1", keys: ["1"], label: "Rate 1 star", group: "actions", value: 1 },
  { id: "rate-2", key: "2", keys: ["2"], label: "Rate 2 stars", group: "actions", value: 2 },
  { id: "rate-3", key: "3", keys: ["3"], label: "Rate 3 stars", group: "actions", value: 3 },
  { id: "rate-4", key: "4", keys: ["4"], label: "Rate 4 stars", group: "actions", value: 4 },
  { id: "rate-5", key: "5", keys: ["5"], label: "Rate 5 stars", group: "actions", value: 5 },
  { id: "rate-clear", key: "0", keys: ["0"], label: "Clear rating", group: "actions", value: 0 },
  { id: "favorite", key: "f", keys: ["F"], label: "Favorite", group: "actions" },
  { id: "info", key: "i", keys: ["I"], label: "Show info", group: "actions" },
  { id: "edit", key: "e", keys: ["E"], label: "Edit", group: "actions" },
  { id: "stack", key: "s", keys: ["S"], label: "Stack selected", group: "actions" },
  { id: "add-to-album", key: "l", keys: ["L"], label: "Add to album", group: "actions" },
  { id: "tag", key: "t", keys: ["T"], label: "Tag", group: "actions" },
  { id: "tag-people", key: "p", keys: ["P"], label: "Tag people", group: "actions" },
  { id: "archive", key: "a", shift: true, keys: ["⇧", "A"], label: "Archive", group: "actions" },
  { id: "download", key: "d", shift: true, keys: ["⇧", "D"], label: "Download", group: "actions" },
  { id: "delete", key: ["Delete", "Backspace"], keys: ["Delete"], label: "Delete", group: "actions" },
];

export const shortcutGroupTitles = { general: "General", actions: "Actions" };

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** True when key presses belong to a text field, so shortcuts must stay quiet. */
export function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (TYPING_TAGS.has(tag)) {
    const type = String(target.type || "").toLowerCase();
    return !(
      tag === "INPUT" &&
      ["checkbox", "radio", "button", "submit", "range"].includes(type)
    );
  }
  return Boolean(target.isContentEditable) || target.contentEditable === "true";
}

const keyMatches = (entryKey, eventKey) => {
  if (typeof eventKey !== "string") return false;
  const wanted = Array.isArray(entryKey) ? entryKey : [entryKey];
  return wanted.some((key) =>
    key.length === 1 ? key.toLowerCase() === eventKey.toLowerCase() : key === eventKey,
  );
};

/** The shortcut entry an event triggers, or null. Typing contexts never match. */
export function matchShortcut(event, table = shortcuts, options = {}) {
  if (!event || typeof event.key !== "string" || event.isComposing) return null;
  if (event.repeat && !options.allowRepeat) return null;
  const typing =
    typeof options.typing === "boolean"
      ? options.typing
      : isTypingTarget(event.target);
  if (typing) return null;
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  for (const entry of table) {
    if (entry.mouse || !entry.key) continue;
    if (!keyMatches(entry.key, event.key)) continue;
    if (Boolean(entry.mod) !== mod) continue;
    if (Boolean(entry.alt) !== alt) continue;
    if (entry.shift !== "any" && Boolean(entry.shift) !== shift) continue;
    return entry;
  }
  return null;
}

/** True on Apple platforms, where Mod renders as ⌘. */
export function isMacPlatform(nav = typeof navigator === "undefined" ? null : navigator) {
  const text = `${nav?.platform || ""} ${nav?.userAgent || ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(text);
}

/** Display keys for an entry, substituting the platform modifier. */
export const formatKeys = (entry, { mac = isMacPlatform() } = {}) =>
  (entry.keys || []).map((key) => (key === "Mod" ? (mac ? "⌘" : "Ctrl") : key));

/** Grouped entries for the help dialog. */
export function shortcutGroups(table = shortcuts, options = {}) {
  const groups = new Map();
  for (const entry of table) {
    if (!groups.has(entry.group))
      groups.set(entry.group, {
        id: entry.group,
        title: shortcutGroupTitles[entry.group] || entry.group,
        items: [],
      });
    groups.get(entry.group).items.push({
      id: entry.id,
      label: entry.label,
      keys: formatKeys(entry, options),
    });
  }
  return [...groups.values()];
}
