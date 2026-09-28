import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { media } from "../src/media.js";
import { createCollectionsState } from "../src/collections-data.mjs";

const root = resolve(import.meta.dirname, "..");
const window = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
  document: window.document,
  location: window.location,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLDialogElement: window.HTMLDialogElement,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

const users = [
  { id: "taylor", name: "Taylor", email: "taylor@example.test", image: "/media/avatar-taylor.png" },
  { id: "jamie", name: "Jamie", email: "jamie@example.test", image: "/media/avatar-jamie.png" },
  { id: "emma", name: "Emma", email: "emma@example.test", image: "/media/avatar-emma.png" },
];
const people = [
  { id: "Jamie", name: "Jamie", image: "/media/avatar-jamie.png" },
  { id: "Emma", name: "Emma", image: "/media/avatar-emma.png" },
  { id: "Taylor", name: "Taylor", image: "/media/avatar-taylor.png" },
];

let vite;
let Collections;
let mounted;
let opened;
let latest;

function Harness() {
  const [state, setState] = React.useState(createCollectionsState);
  latest = state;
  return React.createElement(Collections, {
    assets: media,
    people,
    users,
    currentUserId: "taylor",
    state,
    onChange: setState,
    onOpen: (id) => opened.push(id),
  });
}

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ Collections } = await vite.ssrLoadModule("/src/Collections.jsx"));
});

beforeEach(async () => {
  opened = [];
  latest = null;
  window.document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(React.createElement(Harness));
  });
});

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
});

after(async () => {
  await vite?.close();
  window.close();
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const buttonNamed = (name) => {
  const match = $$("button").find(
    (candidate) =>
      (candidate.getAttribute("aria-label") || candidate.textContent).trim() === name,
  );
  assert.ok(match, `missing button ${name}`);
  return match;
};
const click = (element) => act(async () => element.click());
// happy-dom does not satisfy React's `input`-event feature check, so React
// falls back to watching the focused element on key events. Focus first, set
// the value behind React's tracker, then send a bubbling keyup.
const type = (element, value) =>
  act(async () => {
    element.focus();
    const prototype =
      element.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(
      new window.KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }),
    );
  });
const cardNames = () => $$("article.al-card").map((card) => card.getAttribute("aria-label"));
const card = (name) => $$("article.al-card").find((item) => item.getAttribute("aria-label") === name);
const shelf = (id) => $(`section.al-shelf[data-drop-id="${id}"]`);
const menuItems = () =>
  [...($("[role=menu]")?.querySelectorAll("[role^=menuitem]") || [])].map((item) =>
    item.textContent.trim(),
  );
const menuItem = (label) =>
  [...$("[role=menu]").querySelectorAll("[role^=menuitem]")].find(
    (item) => item.textContent.trim() === label,
  );

test("renders albums on shelves under their collections", () => {
  assert.equal($("h1").textContent.trim(), "Albums");
  assert.match($(".al-heading p").textContent, /5 albums · 1 collection · 5 shared/);
  const family = shelf("family");
  assert.ok(family, "Family renders as a collection shelf");
  assert.equal(family.querySelector("h2").textContent.trim(), "Family");
  assert.match(family.querySelector(".al-shelf-text small").textContent, /3 albums/);
  assert.equal(family.querySelectorAll("article.al-card").length, 3);
  assert.ok(!cardNames().includes("Family"), "collections are shelves, not album tiles");
  assert.ok(cardNames().includes("Summer in the Rockies"));
  const trail = card("Trail camera");
  assert.ok(trail.querySelector(".al-smart"), "smart albums carry a mark on the cover");
  assert.match(trail.querySelector(".al-avatars").getAttribute("aria-label"), /Jamie/);
  assert.ok(card("Trail camera").closest("section.al-shelf.loose"));
  assert.match($("section.al-shelf.loose h2").textContent, /Other albums/);
  assert.ok(card("Family Space").closest("section.al-shelf.spaces"));
  assert.ok(card("Family Space").querySelector(".al-space-mark"));
});

test("filters, search and shelf collapsing narrow what is shown", async () => {
  await click(buttonNamed("Shared"));
  assert.ok(!cardNames().includes("Winter 2026"));
  assert.ok(cardNames().includes("Trail camera"));
  await click(buttonNamed("My albums"));
  assert.ok(!cardNames().includes("Trail camera"));
  await click(buttonNamed("Smart"));
  assert.deepEqual(cardNames().sort(), ["Lake days", "Trail camera"]);
  assert.equal(shelf("family"), null, "a collection without smart albums is hidden");
  await click(buttonNamed("All"));
  await type($("input[type=search]"), "trail");
  assert.deepEqual(cardNames(), ["Trail camera"]);
  await type($("input[type=search]"), "family");
  assert.ok(shelf("family"), "a matching collection shows all its albums");
  assert.ok(cardNames().includes("Winter 2026"));
  await type($("input[type=search]"), "");
  await click(buttonNamed("Collapse Family"));
  assert.ok(shelf("family"));
  assert.ok(!cardNames().includes("Summer in the Rockies"));
  assert.equal(buttonNamed("Expand Family").getAttribute("aria-expanded"), "false");
  await click(buttonNamed("Expand Family"));
  assert.ok(cardNames().includes("Summer in the Rockies"));
});

test("creating an album goes through onChange and appears on its own", async () => {
  await click(buttonNamed("New"));
  await click(menuItem("Album"));
  const dialog = $("dialog");
  assert.ok(dialog, "create dialog opens");
  assert.match(dialog.textContent, /New album/);
  await type(dialog.querySelector("input[required]"), "Road trips");
  await act(async () =>
    dialog
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  const created = latest.collections.find((item) => item.id === "road-trips");
  assert.ok(created);
  assert.equal(created.kind, "album");
  assert.equal(created.ownerId, "taylor");
  assert.equal(created.parentId, null);
  assert.ok(cardNames().includes("Road trips"));
  assert.equal($("dialog"), null);
  assert.match($(".cl-status").textContent, /Created/);
});

test("a collection shelf can start a new album inside it", async () => {
  await click(buttonNamed("New album in Family"));
  const dialog = $("dialog");
  assert.ok(dialog);
  assert.equal(dialog.querySelector("select").value, "family");
  await type(dialog.querySelector("input[required]"), "Autumn");
  await act(async () =>
    dialog
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(latest.collections.find((item) => item.id === "autumn").parentId, "family");
  assert.ok(shelf("family").querySelector('article.al-card[aria-label="Autumn"]'));
});

test("creating a collection adds a shelf without an Inside field or smart switch", async () => {
  await click(buttonNamed("New"));
  await click(menuItem("Collection"));
  const dialog = $("dialog");
  assert.match(dialog.textContent, /New collection/);
  assert.equal(dialog.querySelector("select"), null);
  assert.equal(dialog.querySelector("input[type=checkbox]"), null);
  await type(dialog.querySelector("input[required]"), "Travel");
  await act(async () =>
    dialog
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(latest.collections.find((item) => item.id === "travel").kind, "collection");
  assert.ok(shelf("travel"));
  assert.match(shelf("travel").textContent, /No albums yet/);
});

test("list view keeps the shelves, sorts by title and opens an album by name", async () => {
  await click(buttonNamed("List view"));
  assert.equal($$("ul.al-list").length, 3, "one list per shelf");
  assert.equal($$("li.al-row").length, 6);
  await click(buttonNamed("Sort albums"));
  await click(menuItem("Title"));
  const familyRows = [...shelf("family").querySelectorAll("li.al-row")].map((row) =>
    row.getAttribute("aria-label"),
  );
  assert.deepEqual(familyRows, ["Everyday", "Summer in the Rockies", "Winter 2026"]);
  const openButton = $$("li.al-row .al-row-open").find((button) =>
    button.textContent.includes("Lake days"),
  );
  await click(openButton);
  assert.deepEqual(opened, ["lake-days"]);
});

test("menus are role-aware and delete keeps library items", async () => {
  await click(buttonNamed("Actions for Trail camera"));
  const shared = menuItems();
  assert.ok(shared.includes("Leave"));
  assert.ok(shared.includes("Re-evaluate"));
  assert.ok(!shared.includes("Delete"));
  assert.ok(!shared.includes("Edit"));
  await act(async () =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal($("[role=menu]"), null, "Escape closes the menu");

  await click(buttonNamed("Actions for Family"));
  const collectionMenu = menuItems();
  assert.ok(collectionMenu.includes("New album"));
  assert.ok(!collectionMenu.includes("Move to…"), "collections stay at the top level");
  await act(async () =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

  await click(buttonNamed("Actions for Winter 2026"));
  const own = menuItems();
  assert.ok(own.includes("Delete"));
  assert.ok(own.includes("Move to…"));
  assert.ok(own.includes("Create link"));
  await click(menuItem("Delete"));
  assert.match($("dialog").textContent, /no items|stay in your library/);
  await click(buttonNamed("Delete album"));
  assert.ok(!latest.collections.some((item) => item.id === "winter-2026"));
  assert.ok(!cardNames().includes("Winter 2026"));
  assert.match($(".cl-status").textContent, /stay in your library/);
});

test("moving through the dialog only offers collections", async () => {
  await click(buttonNamed("Actions for Everyday"));
  await click(menuItem("Move to…"));
  const select = $("dialog select");
  assert.ok(select);
  const options = [...select.options].map((option) => option.value);
  assert.ok(options.includes(""), "an album can live on its own");
  assert.ok(options.includes("family"));
  assert.ok(!options.includes("summer-rockies"), "albums are never offered as parents");
  assert.ok(!options.includes("family-space"), "spaces are never offered as parents");
  assert.ok(!options.includes("trail-camera"), "smart albums are never offered as parents");
  await click(buttonNamed("Move"));
  assert.equal(latest.collections.find((item) => item.id === "everyday").parentId, "family");
});
