import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const window = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
  document: window.document,
  location: window.location,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLDialogElement: window.HTMLDialogElement,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
};
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });

let vite;
let SelectionBar;
let TimelineLibrary;
let media;
let tags;
let mounted;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ SelectionBar } = await vite.ssrLoadModule("/src/SelectionBar.jsx"));
  ({ TimelineLibrary } = await vite.ssrLoadModule("/src/TimelineLibrary.jsx"));
  ({ media, tags } = await vite.ssrLoadModule("/src/media.js"));
});
beforeEach(() => {
  window.document.body.innerHTML = '<div id="root"></div>';
});
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
});
after(async () => {
  await vite?.close();
  window.close();
});

const render = async (element) => {
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(element);
  });
};
const rerender = async (element) => act(async () => mounted.render(element));
const byLabel = (label) => {
  const match = [...document.querySelectorAll("[aria-label]")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  assert.ok(match, `missing control labelled ${label}`);
  return match;
};
const byText = (selector, text) => {
  const match = [...document.querySelectorAll(selector)].find(
    (node) => node.textContent.trim() === text,
  );
  assert.ok(match, `missing ${selector} with text ${text}`);
  return match;
};
const click = (node) => act(async () => node.click());
const key = (init, target = window) =>
  act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
// happy-dom has no native input events, so React uses its focus-based value
// polyfill: focus the field, set the value on the prototype, then send a key.
const type = (input, value) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(
      new window.KeyboardEvent("keyup", { key: value.at(-1), bubbles: true }),
    );
  });
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
const dialog = () => document.querySelector("dialog[open]");

function harness(overrides = {}) {
  const calls = { actions: [], clear: 0, selectAll: 0 };
  const props = {
    count: 2,
    total: 5,
    assets: media.slice(0, 2),
    tagOptions: tags,
    onAction: (id, payload) => calls.actions.push([id, payload]),
    onClear: () => (calls.clear += 1),
    onSelectAll: () => (calls.selectAll += 1),
    ...overrides,
  };
  return { calls, props, element: React.createElement(SelectionBar, props) };
}

test("selection bar slides in with a count, primary actions and immediate delete", async () => {
  const { calls, element, props } = harness();
  await render(element);
  const bar = document.querySelector(".selection-bar");
  assert.ok(bar.classList.contains("is-open"));
  assert.equal(bar.getAttribute("aria-hidden"), "false");
  assert.match(bar.textContent, /2 selected/);
  assert.match(bar.textContent, /Select all 5/);
  const labels = [...bar.querySelectorAll(".sb-action")].map((node) =>
    node.getAttribute("aria-label"),
  );
  assert.deepEqual(labels, [
    "Favorite",
    "Add to album",
    "Share link",
    "Download",
    "Delete",
    "More actions",
  ]);
  await click(byLabel("Delete"));
  assert.deepEqual(calls.actions, [["delete", undefined]]);
  assert.equal(dialog(), null, "ordinary delete needs no confirmation");
  await click(byLabel("Deselect all"));
  assert.equal(calls.clear, 1);
  await click(byText("button", "Select all 5"));
  assert.equal(calls.selectAll, 1);

  await rerender(React.createElement(SelectionBar, { ...props, count: 0 }));
  assert.equal(bar.classList.contains("is-open"), false);
  assert.equal(bar.getAttribute("aria-hidden"), "true");
});

test("keyboard: Escape clears, Delete deletes, Cmd+A selects all, Cmd+D clears, typing is ignored", async () => {
  const { calls, element } = harness();
  await render(element);
  await key({ key: "Escape" });
  assert.equal(calls.clear, 1);
  await key({ key: "Delete" });
  assert.deepEqual(calls.actions.at(-1), ["delete", undefined]);
  await key({ key: "Backspace" });
  assert.equal(calls.actions.length, 2);
  await key({ key: "a", metaKey: true });
  assert.equal(calls.selectAll, 1);
  await key({ key: "a", ctrlKey: true });
  assert.equal(calls.selectAll, 2);
  await key({ key: "d", metaKey: true });
  assert.equal(calls.clear, 2);
  const field = document.createElement("input");
  document.body.append(field);
  await key({ key: "Escape" }, field);
  assert.equal(calls.clear, 2, "text fields keep their keys");
});

test("More menu groups actions, supports arrow keys and opens the Change date dialog", async () => {
  const { calls, element } = harness();
  await render(element);
  const more = byLabel("More actions");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  await click(more);
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  const groups = [...menu.querySelectorAll(".sb-menu-title")].map((node) =>
    node.textContent,
  );
  assert.deepEqual(groups, ["Organize", "Visibility", "Jobs"], "no album group without an album");
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.ok(items.map((node) => node.textContent).includes("Change date"));
  assert.ok(items.map((node) => node.textContent).includes("Refresh encoded video"));
  assert.equal(document.activeElement, items[0], "first item takes focus");
  await key({ key: "ArrowDown" }, items[0]);
  assert.equal(document.activeElement, items[1]);
  await key({ key: "End" }, items[1]);
  assert.equal(document.activeElement, items.at(-1));
  await key({ key: "Escape" }, items.at(-1));
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, more, "focus returns to the More button");
  assert.equal(calls.clear, 0, "Escape inside the menu does not clear the selection");

  await click(more);
  await click(byText('[role="menuitem"]', "Change date"));
  assert.ok(dialog(), "Change date dialog opened");
  assert.match(dialog().textContent, /2 items will be set to 2026-08-16 at 07:14/);
  await submit(dialog().querySelector("form"));
  assert.deepEqual(calls.actions, [
    ["change-date", { mode: "set", date: "2026-08-16", time: "07:14", timezone: null }],
  ]);
  assert.equal(dialog(), null, "dialog closes after applying");
});

test("Tag dialog is a multi-select combobox with keyboard picking and new tags", async () => {
  const { calls, element } = harness();
  await render(element);
  await click(byLabel("More actions"));
  await click(byText('[role="menuitem"]', "Tag"));
  const box = dialog().querySelector('[role="combobox"]');
  assert.ok(box);
  assert.equal(box.getAttribute("aria-expanded"), "true", "suggestions list existing tags");
  await type(box, "lak");
  const options = [...dialog().querySelectorAll('[role="option"]')].map(
    (node) => node.textContent,
  );
  assert.deepEqual(options, ["lake", "lakCreate tag"]);
  await key({ key: "Enter" }, box);
  assert.match(dialog().querySelector(".sb-chips").textContent, /lake/);
  await type(box, "Hiking trip");
  await key({ key: "Enter" }, box);
  const chips = [...dialog().querySelectorAll(".sb-chip")].map((node) =>
    node.firstChild.textContent,
  );
  assert.deepEqual(chips, ["lake", "Hiking trip"]);
  await click(byLabel("Remove lake"));
  await submit(dialog().querySelector("form"));
  assert.deepEqual(calls.actions, [
    ["tag", { tagIds: ["hiking-trip"], newTags: [{ id: "hiking-trip", label: "Hiking trip" }] }],
  ]);
});

test("trash context swaps primary actions and confirms permanent deletion", async () => {
  const { calls, element } = harness({ context: { trash: true } });
  await render(element);
  const labels = [...document.querySelectorAll(".sb-action")].map((node) =>
    node.getAttribute("aria-label"),
  );
  assert.deepEqual(labels, ["Restore", "Download", "Delete permanently", "More actions"]);
  await key({ key: "Delete" });
  assert.ok(dialog(), "Delete key asks for confirmation in trash");
  assert.match(dialog().textContent, /Permanently delete 2 items/);
  assert.equal(calls.actions.length, 0);
  const confirm = [...dialog().querySelectorAll("button")].find(
    (node) => node.textContent.trim() === "Delete permanently",
  );
  assert.ok(confirm, "dialog has its own confirm button");
  await click(confirm);
  assert.deepEqual(calls.actions, [["delete-permanently", undefined]]);
  assert.equal(dialog(), null);
  await click(byLabel("Restore"));
  assert.deepEqual(calls.actions.at(-1), ["restore", undefined]);
});

test("timeline renders justified rows, sticky group headers with select-all and a scrubber", async () => {
  const calls = { groups: [], grouping: [], select: [], open: [] };
  await render(
    React.createElement(TimelineLibrary, {
      assets: media,
      selected: new Set(),
      grouping: "days",
      onGroupingChange: (value) => calls.grouping.push(value),
      onSelectGroup: (ids, checked) => calls.groups.push([ids, checked]),
      onSelect: (id) => calls.select.push(id),
      onOpen: (id) => calls.open.push(id),
    }),
  );
  const toolbar = document.querySelector(".tl-toolbar");
  assert.doesNotMatch(toolbar.textContent, /\d+ items/, "toolbar no longer repeats the count");
  const headers = [...document.querySelectorAll(".tl-group-header h2")].map(
    (node) => node.textContent,
  );
  assert.ok(headers.length >= 5);
  assert.match(headers[0], /August \d+, 2026/);
  const tiles = document.querySelectorAll('.asset-tile[data-layout="timeline"]');
  assert.equal(tiles.length, media.length);
  const rows = document.querySelectorAll(".tl-row");
  assert.ok(rows.length >= headers.length, "each group has at least one justified row");
  for (const tile of tiles) assert.match(tile.getAttribute("style"), /width/);
  const firstGroupIds = [...document.querySelector(".tl-group").querySelectorAll("[data-asset-id]")].map(
    (node) => node.dataset.assetId,
  );
  const checkbox = document.querySelector(".tl-group-select input");
  assert.match(checkbox.getAttribute("aria-label"), /^Select all in /);
  await act(async () => {
    checkbox.click();
  });
  assert.deepEqual(calls.groups, [[firstGroupIds, true]]);
  const slider = document.querySelector('[role="slider"]');
  assert.ok(slider, "scrubber present");
  assert.equal(slider.getAttribute("aria-orientation"), "vertical");
  assert.match(slider.getAttribute("aria-valuetext"), /August 2026/);
  assert.ok(document.querySelectorAll(".tl-scrub-tick").length >= 1);
  await click(byText(".tl-segmented button", "Years"));
  assert.deepEqual(calls.grouping, ["years"]);
  await click(tiles[0].querySelector(".at-open"));
  assert.deepEqual(calls.open, [tiles[0].dataset.assetId]);
  await click(tiles[0].querySelector(".at-select input"));
  assert.deepEqual(calls.select, [tiles[0].dataset.assetId]);
  const badges = document.querySelector(".at-duration");
  assert.ok(badges, "video tiles show a duration badge");
  assert.match(badges.textContent, /0:24/);
});

test("timeline Years and Months are curated cards that open the next level", async () => {
  const assets = [
    ...media,
    { ...media[0], id: "old-a", takenAt: "2019-03-02T09:00:00", date: "2019-03-02", bestPhotosScore: 40 },
    { ...media[1], id: "old-b", takenAt: "2019-03-04T09:00:00", date: "2019-03-04", bestPhotosScore: 88 },
  ];
  const calls = [];
  const props = {
    assets,
    selected: new Set(),
    onGroupingChange: (value) => calls.push(value),
  };
  await render(React.createElement(TimelineLibrary, { ...props, grouping: "years" }));
  const years = [...document.querySelectorAll(".tl-card-year")];
  assert.deepEqual(
    years.map((card) => card.dataset.groupId),
    ["2026", "2019"],
  );
  assert.equal(document.querySelectorAll('.asset-tile[data-layout="timeline"]').length, 0);
  assert.equal(document.querySelectorAll(".tl-card [data-asset-id]").length, 0);
  const best = media.reduce((a, b) => (b.bestPhotosScore > a.bestPhotosScore ? b : a));
  assert.equal(years[0].querySelector(".tl-card-media img").getAttribute("src"), best.image);
  assert.equal(years[0].querySelector(".tl-card-title").textContent, "2026");
  assert.match(years[0].querySelector(".tl-card-meta").textContent, /\d+ items · .*(Banff|Jasper|Lake Louise)/);
  assert.equal(years[1].querySelector(".tl-card-media img").getAttribute("src"), media[1].image);
  const open = years[1].querySelector(".tl-card-open");
  assert.match(open.getAttribute("aria-label"), /^2019, 2 items.*Show months$/);
  await click(open);
  assert.deepEqual(calls, ["months"]);
  await rerender(React.createElement(TimelineLibrary, { ...props, grouping: "months" }));
  const months = [...document.querySelectorAll(".tl-card-month")];
  assert.deepEqual(
    months.map((card) => card.querySelector(".tl-card-title").textContent),
    ["August 2026", "March 2019"],
  );
  assert.equal(months[0].querySelectorAll(".tl-card-strip img").length, 4);
  assert.equal(months[1].querySelectorAll(".tl-card-strip img").length, 1);
  await click(months[0].querySelector(".tl-card-open"));
  assert.deepEqual(calls, ["months", "days"]);
  await rerender(React.createElement(TimelineLibrary, { ...props, grouping: "days" }));
  assert.equal(document.querySelectorAll(".tl-card").length, 0);
  assert.equal(
    document.querySelectorAll('.asset-tile[data-layout="timeline"]').length,
    assets.length,
  );
});
