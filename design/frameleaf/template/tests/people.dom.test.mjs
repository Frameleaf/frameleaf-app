import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const window = new Window({ url: "http://localhost/?screen=people" });
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

let vite;
let PeopleLibrary, PersonHeader, ManagePeople, media, people, data;
let mounted;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ PeopleLibrary } = await vite.ssrLoadModule("/src/People.jsx"));
  ({ PersonHeader } = await vite.ssrLoadModule("/src/PersonDetail.jsx"));
  ({ ManagePeople } = await vite.ssrLoadModule("/src/ManagePeople.jsx"));
  ({ media, people } = await vite.ssrLoadModule("/src/media.js"));
  data = await vite.ssrLoadModule("/src/people-data.mjs");
});

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
});

after(async () => {
  await vite?.close();
  window.close();
});

const mount = async (component, props) => {
  window.document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(React.createElement(component, props));
  });
};
const buttons = () => [...document.querySelectorAll("button")];
const button = (name) => {
  const match = buttons().find(
    (candidate) =>
      candidate.textContent.trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  assert.ok(match, `missing button ${name}`);
  return match;
};
const click = async (name) => act(async () => button(name).click());
// react-dom/client is imported before the happy-dom globals exist, so React
// uses its focus/keyup value polyfill instead of native input events: focus the
// field, set the value behind React's tracker, then send both events.
const type = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(
      new window.KeyboardEvent("keyup", { key: value.at(-1) || "", bubbles: true }),
    );
  });
};
// Compare DOM nodes by identity/presence only: a failed assert.equal on a
// happy-dom node makes node:assert inspect the whole window graph, which
// exhausts memory instead of reporting the failure.
const absent = (selector, message) =>
  assert.ok(!document.querySelector(selector), message || `${selector} should be absent`);
const text = () => document.body.textContent;

test("People grid shows unnamed clusters, a merge suggestion and names inline", async () => {
  const changes = [];
  await mount(PeopleLibrary, {
    people,
    assets: media,
    overrides: {},
    onChange: (next) => changes.push(next),
    onOpenPerson() {},
    onManage() {},
  });
  assert.equal(document.querySelectorAll(".pl-card").length, 5);
  assert.equal(
    buttons().filter((b) => b.textContent.trim() === "Add a name").length,
    2,
  );
  assert.match(text(), /Are these the same person\?/);
  await click("Yes, merge");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]["cluster-unnamed-1"]?.mergedInto, "Jamie");

  // Inline naming of an unnamed person with the suggestion combobox.
  await click("Add a name");
  const input = document.querySelector('input[role="combobox"]');
  assert.ok(input, "name editor opened");
  await type(input, "Em");
  assert.ok(document.querySelector('[role="listbox"]'), "suggestions listed");
  assert.match(document.querySelector('[role="listbox"]').textContent, /Emma/);
  await type(input, "Sam");
  absent('[role="listbox"]', "no suggestions for a new name");
  await click("Save name");
  assert.equal(changes.length, 2);
  const named = Object.entries(changes[1]).find(
    ([, entry]) => entry.name === "Sam",
  );
  assert.ok(named, "name saved through onChange");
  assert.match(named[0], /^cluster-unnamed-/);
  absent('input[role="combobox"]', "name editor closed");

  // Picking a suggestion commits that name for the other cluster.
  await click("Add a name");
  await type(document.querySelector('input[role="combobox"]'), "em");
  await act(async () =>
    [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.trim() === "Emma")
      .click(),
  );
  assert.equal(changes.length, 3);
  assert.ok(Object.values(changes[2]).some((entry) => entry.name === "Emma"));
  absent('input[role="combobox"]', "name editor closed");
  // Cancel renaming leaves overrides untouched.
  await click("Rename Jamie");
  await click("Cancel renaming");
  assert.equal(changes.length, 3);
});

test("Card menu hides a person and the hidden toggle brings them back", async () => {
  let overrides = {};
  const rerender = () =>
    act(async () =>
      mounted.render(
        React.createElement(PeopleLibrary, {
          people,
          assets: media,
          overrides,
          onChange: (next) => {
            overrides = next;
          },
          onOpenPerson() {},
        }),
      ),
    );
  await mount(PeopleLibrary, {
    people,
    assets: media,
    overrides,
    onChange: (next) => {
      overrides = next;
    },
    onOpenPerson() {},
  });
  await click("More actions for Jamie");
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu, "menu opened");
  assert.equal(document.activeElement.getAttribute("role"), "menuitem");
  await act(async () =>
    [...menu.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent.trim() === "Hide")
      .click(),
  );
  assert.equal(overrides.Jamie?.hidden, true);
  absent('[role="menu"]', "menu closed after choosing Hide");
  await rerender();
  assert.equal(document.querySelectorAll(".pl-card").length, 4);
  assert.match(text(), /1 hidden person/);
  await click("Show hidden");
  assert.equal(document.querySelectorAll(".pl-card").length, 5);
  assert.equal(document.querySelectorAll(".pl-card.is-hidden").length, 1);
});

test("Show and hide people batches visibility and saves once", async () => {
  const saves = [];
  let backs = 0;
  await mount(ManagePeople, {
    people,
    overrides: {},
    onSave: (next) => saves.push(next),
    onBack: () => (backs += 1),
  });
  assert.equal(document.querySelectorAll(".pm-card").length, 5);
  assert.match(text(), /No pending changes/);
  assert.equal(button("Save changes").disabled, true);
  await click("Hide unnamed");
  assert.equal(document.querySelectorAll(".pm-card.is-hidden").length, 2);
  await click("Hide all");
  assert.equal(document.querySelectorAll(".pm-card.is-hidden").length, 5);
  assert.match(text(), /Save changes \(5\)/);
  await click("Reset");
  assert.equal(document.querySelectorAll(".pm-card.is-hidden").length, 0);
  await click("Hide all");
  await click("Jamie, hidden, unsaved change");
  assert.match(text(), /Save changes \(4\)/);
  await click("Save changes (4)");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].Jamie, undefined);
  assert.equal(saves[0].Emma?.hidden, true);
  // Leaving with unsaved changes asks first (the saved prop is still empty here).
  await click("Hide all");
  await click("Cancel");
  assert.match(text(), /Discard changes\?/);
  await click("Keep editing");
  assert.equal(backs, 0);
  await click("Cancel");
  await click("Discard");
  assert.equal(backs, 1);
});

test("Person header renders facts and the fix-match panel routes face actions", async () => {
  const applied = data.applyPeopleOverrides(people, {});
  const jamie = applied.find((person) => person.id === "Jamie");
  const assets = data.personAssets(jamie, media);
  const actions = [];
  const changes = [];
  await mount(PersonHeader, {
    person: jamie,
    assets,
    overrides: data.setBirthday({}, "Jamie", "2012-03-04"),
    onChange: (next) => changes.push(next),
    allPeople: applied,
    onOpenSettings() {},
    onOpenAsset() {},
    onSelectFeatured() {},
    faces: [
      {
        assetId: assets[0].id,
        faceId: "f1",
        box: { x: 0.2, y: 0.2, width: 0.2, height: 0.3 },
        personId: "Jamie",
      },
    ],
    onFaceAction: (assetId, action) => actions.push([assetId, action]),
  });
  assert.equal(document.querySelector("h1").textContent, "Jamie");
  assert.match(text(), /Born March 4, 2012/);
  assert.match(text(), /years old/);
  assert.match(
    text(),
    new RegExp(`${assets.filter((a) => a.type !== "video").length} photos`),
  );
  await click("Favorite");
  assert.equal(changes.at(-1).Jamie.favorite, true);
  await click("Fix incorrect match");
  const panel = document.querySelector(".pd-fix");
  assert.ok(panel, "fix panel opened");
  assert.ok(
    document.activeElement === panel.querySelector("h2"),
    "fix panel heading has focus",
  );
  assert.equal(panel.querySelectorAll(".pd-fix-row").length, assets.length);
  assert.ok(panel.querySelector(".pp-face-crop"), "tagged face uses a crop");
  await act(async () => panel.querySelector(".pd-fix-menu-button").click());
  await act(async () =>
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent.trim() === "This is Emma")
      .click(),
  );
  assert.deepEqual(actions, [
    [assets[0].id, { faceId: "f1", type: "reassign", personId: "Emma" }],
  ]);
  assert.match(panel.textContent, /Moved to Emma/);
  await act(async () =>
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  absent(".pd-fix", "Escape closes the fix panel");
});
