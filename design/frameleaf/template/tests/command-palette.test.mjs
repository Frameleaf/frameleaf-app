import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMANDS_KEY,
  RECENT_COMMAND_LIMIT,
  buildCommandIndex,
  commandGroups,
  groupCommands,
  isCommandQuery,
  loadRecentCommands,
  navigationCommands,
  parseRecentCommands,
  recentCommands,
  rememberCommand,
  saveRecentCommands,
  scoreCommand,
  searchCommands,
  shortcutKeys,
  stripCommandPrefix,
} from "../src/command-palette.mjs";
import { settingsAreas, settingsSections } from "../src/settings-catalog.mjs";

const index = buildCommandIndex({
  pages: [
    { id: "library", title: "Library", shortcut: "g l" },
    { id: "trash-page", title: "Open trash", subtitle: "Library page" },
    { id: "storage-page", title: "Storage", keywords: ["disk", "space"] },
  ],
  settingsAreas: [
    { id: "trash", title: "Trash", group: "Your library", icon: "mdiDeleteOutline", description: "Restore deleted photos" },
    { id: "storage", title: "Storage & originals", group: "Your library", description: "Know where everything lives." },
  ],
  settingsSections: {
    trash: [{ id: "contents", title: "Trash contents", description: "Review deleted items" }],
    unknown: [{ id: "x", title: "Ignored" }],
  },
  actions: [
    { id: "empty-trash", title: "Empty trash", subtitle: "Removes everything", icon: "mdiDeleteForeverOutline", shortcut: "mod+shift+backspace" },
    { id: "toggle-theme", title: "Toggle theme", keywords: ["dark", "light", "appearance"] },
    { id: "", title: "Ignored" },
  ],
  people: [
    { id: "jamie", name: "Jamie", count: 12 },
    { id: "emma", name: "Emma", count: 1 },
  ],
  collections: [
    { id: "trip", title: "Trip to Banff", kind: "album", count: 40 },
    { id: "family", name: "Family", kind: "space" },
  ],
  places: [
    { value: "Banff", field: "city", count: 5 },
    { name: "Alberta", field: "state" },
    { value: "" },
  ],
});
const titles = (items) => items.map((item) => item.title);

test("index normalizes every input kind with stable IDs, icons and payloads", () => {
  assert.deepEqual(
    commandGroups.map((group) => group.id),
    ["actions", "pages", "settings", "people", "collections", "places"],
  );
  const ids = index.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("settings:trash/contents"));
  assert.ok(!ids.includes("settings:unknown/x"));
  assert.ok(!ids.includes("action:"));
  const person = index.find((item) => item.id === "person:jamie");
  assert.deepEqual(person.payload, { kind: "person", id: "jamie" });
  assert.equal(person.subtitle, "12 photos");
  assert.equal(index.find((item) => item.id === "person:emma").subtitle, "1 photo");
  const place = index.find((item) => item.id === "place:city:banff");
  assert.deepEqual(place.payload, { kind: "place", field: "city", value: "Banff" });
  assert.equal(place.subtitle, "City · 5 photos");
  assert.equal(index.find((item) => item.id === "place:state:alberta").subtitle, "State / province");
  const space = index.find((item) => item.id === "collection:space:family");
  assert.equal(space.subtitle, "Space");
  assert.equal(space.icon, "mdiAccountGroupOutline");
  const area = index.find((item) => item.id === "settings:trash");
  assert.deepEqual(area.payload, { kind: "settings", area: "trash", section: "" });
  assert.equal(area.icon, "mdiDeleteOutline");
  assert.equal(area.subtitle, "Settings · Your library");
  assert.equal(index.find((item) => item.id === "page:library").icon, "mdiViewGridOutline");
  assert.deepEqual(buildCommandIndex(null), []);
  assert.deepEqual(buildCommandIndex({ pages: "nope", people: [null, 4] }), []);
});

test("ranking prefers exact titles, then prefixes, then word starts, then fuzzy and keyword matches", () => {
  const ranked = titles(searchCommands(index, "trash"));
  assert.equal(ranked[0], "Trash");
  assert.ok(ranked.indexOf("Trash contents") < ranked.indexOf("Open trash"));
  assert.ok(ranked.indexOf("Open trash") < ranked.indexOf("Empty trash") || ranked.indexOf("Empty trash") < ranked.indexOf("Open trash"));
  const partial = titles(searchCommands(index, "sto"));
  assert.equal(partial[0], "Storage");
  assert.equal(partial[1], "Storage & originals");
  const fuzzy = searchCommands(index, "tgt");
  assert.deepEqual(titles(fuzzy), ["Toggle theme"]);
  assert.ok(scoreCommand(index.find((item) => item.title === "Toggle theme"), "dark") > 0);
  // One query, four tiers: prefix > word start > title fuzzy > keyword word start.
  const score = (title, query) =>
    scoreCommand(index.find((item) => item.title === title), query);
  assert.ok(score("Trash", "tra") > score("Open trash", "tra"));
  assert.ok(score("Open trash", "tra") > score("Storage", "tra"));
  assert.ok(score("Storage", "tra") > 0);
  assert.ok(score("Toggle theme", "dark") > 0);
  assert.ok(score("Storage", "tra") > score("Toggle theme", "dar"));
  assert.deepEqual(titles(searchCommands(index, "tra")).slice(0, 2), ["Trash", "Trash contents"]);
  assert.ok(titles(searchCommands(index, "tra")).indexOf("Storage") > titles(searchCommands(index, "tra")).indexOf("Open trash"));
  assert.deepEqual(titles(searchCommands(index, "trip banff")), ["Trip to Banff"]);
  assert.deepEqual(searchCommands(index, "   "), []);
  assert.deepEqual(searchCommands(index, "zzzzzz"), []);
  assert.equal(searchCommands(index, "a", 2).length, 2);
  assert.equal(searchCommands(null, "trash").length, 0);
  assert.equal(scoreCommand(null, "trash"), 0);
});

test("accents and case fold; groups keep their canonical order and > prefixes strip", () => {
  const accented = buildCommandIndex({ places: [{ value: "Montréal", field: "city" }] });
  assert.equal(searchCommands(accented, "MONTREAL")[0].title, "Montréal");
  const grouped = groupCommands(searchCommands(index, "a", 50));
  assert.deepEqual(
    grouped.map((group) => group.id),
    commandGroups
      .map((group) => group.id)
      .filter((id) => grouped.some((group) => group.id === id)),
  );
  assert.ok(grouped.every((group) => group.commands.length > 0));
  assert.ok(grouped.every((group) => group.commands.every((item) => item.group === group.id)));
  assert.ok(isCommandQuery("  > trash"));
  assert.ok(!isCommandQuery("trash >"));
  assert.equal(stripCommandPrefix(">  toggle "), "toggle");
  assert.equal(searchCommands(index, "> toggle")[0].title, "Toggle theme");
  assert.deepEqual(
    new Set(navigationCommands(index).map((item) => item.group)),
    new Set(["pages", "settings", "actions"]),
  );
});

test("recent commands persist as bounded unique IDs and resolve against the live index", () => {
  let recent = [];
  for (const id of ["action:empty-trash", "page:library", "action:empty-trash", "settings:trash"])
    recent = rememberCommand(recent, id);
  assert.deepEqual(recent, ["settings:trash", "action:empty-trash", "page:library"]);
  for (let index = 0; index < 20; index += 1) recent = rememberCommand(recent, `page:${index}`);
  assert.equal(recent.length, RECENT_COMMAND_LIMIT);
  assert.equal(rememberCommand(recent, 42), recent);
  assert.deepEqual(parseRecentCommands("{not json"), []);
  assert.deepEqual(parseRecentCommands({ version: 2, recent: ["x"] }), []);
  assert.deepEqual(parseRecentCommands({ version: 1, recent: ["a", "", 7, "a", "b"] }), ["a", "b"]);
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(saveRecentCommands(storage, ["page:library", "person:jamie", "missing"]), true);
  assert.ok(store.has(COMMANDS_KEY));
  assert.deepEqual(loadRecentCommands(storage), ["page:library", "person:jamie", "missing"]);
  assert.deepEqual(titles(recentCommands(index, loadRecentCommands(storage))), ["Library", "Jamie"]);
  assert.deepEqual(loadRecentCommands({ getItem: () => { throw new Error("blocked"); } }), []);
  assert.equal(saveRecentCommands({ setItem: () => { throw new Error("blocked"); } }, []), false);
  assert.deepEqual(loadRecentCommands(undefined), []);
});

test("shortcut hints render platform keys", () => {
  assert.deepEqual(shortcutKeys("mod+shift+p", true), ["⌘", "⇧", "P"]);
  assert.deepEqual(shortcutKeys("mod+shift+p", false), ["Ctrl", "Shift", "P"]);
  assert.deepEqual(shortcutKeys("g l"), ["G L"]);
  assert.deepEqual(shortcutKeys(""), []);
});

test("the real settings catalog indexes every area and section, including maintenance", () => {
  const catalog = buildCommandIndex({ settingsAreas, settingsSections });
  for (const area of settingsAreas)
    assert.ok(catalog.some((item) => item.id === `settings:${area.id}`), area.id);
  assert.ok(catalog.some((item) => item.id === "settings:maintenance/backups"));
  const maintenance = searchCommands(catalog, "backup restore");
  assert.ok(maintenance.some((item) => item.payload.area === "maintenance"));
  assert.equal(searchCommands(catalog, "trash")[0].payload.area, "trash");
});

test("Frameleaf Cloud sections are reachable from the palette by their plain-language keywords", () => {
  const catalog = buildCommandIndex({ settingsAreas, settingsSections });
  for (const section of settingsSections.cloud)
    assert.ok(
      catalog.some((item) => item.id === `settings:cloud/${section.id}`),
      section.id,
    );
  for (const [query, section] of [
    ["device code", "cloud-account"],
    ["upnp", "cloud-remote"],
    ["recovery kit", "cloud-backup"],
  ])
    assert.ok(
      searchCommands(catalog, query).some(
        (item) => item.payload.area === "cloud" && item.payload.section === section,
      ),
      query,
    );
});
