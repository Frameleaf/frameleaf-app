import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { media, people } from "../src/media.js";
import { seedSharedLinks } from "../src/shared-links-data.mjs";

const root = resolve(import.meta.dirname, "..");
const window = new Window({ url: "http://localhost/?screen=public&link=rockies-2026" });
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
  File: window.File,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
};
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });

const collections = {
  "summer-rockies": "Summer in the Rockies",
  family: "Family",
  everyday: "Everyday",
  "winter-2026": "Winter 2026",
};
const owner = { name: "Taylor", image: "/media/avatar-taylor.png" };

let vite;
let SharedLinks;
let ShareSheet;
let PublicViewer;
let PartnerHeader;
let mounted;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ SharedLinks, ShareSheet } = await vite.ssrLoadModule("/src/SharedLinks.jsx"));
  ({ PublicViewer } = await vite.ssrLoadModule("/src/PublicViewer.jsx"));
  ({ PartnerHeader } = await vite.ssrLoadModule("/src/PartnerLibrary.jsx"));
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
  await act(async () => mounted?.unmount());
  window.document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(element);
  });
};
const buttons = (scope = document) => [...scope.querySelectorAll("button")];
const button = (name, scope = document) => {
  const match = buttons(scope).find(
    (candidate) =>
      candidate.textContent.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  assert.ok(match, `missing button ${name}`);
  return match;
};
const click = (name, scope) => act(async () => button(name, scope).click());
const tab = (id) => act(async () => document.getElementById(`sl-tab-${id}`).click());
// React may use either native input events or its focus/keyup polyfill
// depending on load order, so emit the sequence both paths understand.
const type = (input, text) =>
  act(async () => {
    input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
      input,
      text,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
const text = () => document.body.textContent.replace(/\s+/g, " ");
const cards = () => [...document.querySelectorAll(".sl-card")];
const dialog = () => document.querySelector("dialog[open]");

test("shared links screen lists seeded cards with badges, tabs and search", async () => {
  const { links } = seedSharedLinks();
  await render(
    React.createElement(SharedLinks, { links, assets: media, collections, onChange() {} }),
  );
  assert.equal(cards().length, 3);
  const headings = cards().map((card) => card.querySelector("h2").textContent);
  assert.deepEqual(headings, ["Summer in the Rockies", "4 items", "Family"]);
  const badgeText = cards().map((card) => card.querySelector(".sl-badges").textContent);
  assert.match(badgeText[0], /Downloads.*Uploads.*Metadata.*Expires in 18 days.*24 views/);
  assert.match(badgeText[1], /Password.*Downloads.*6 views/);
  assert.match(badgeText[2], /Expired.*41 views/);
  assert.equal(cards()[2].dataset.expired, "true");
  assert.equal(
    cards()[0].querySelectorAll(".sl-collage img").length,
    4,
    "collage shows up to four covers",
  );
  await tab("album");
  assert.equal(cards().length, 2);
  await tab("individual");
  assert.equal(cards().length, 1);
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), "Individual shares1");
  await tab("all");
  await type(document.querySelector('input[type="search"]'), "grandma");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].textContent, /Lake photos for Grandma/);
  await type(document.querySelector('input[type="search"]'), "zzz");
  assert.equal(cards().length, 0);
  assert.match(text(), /No links match/);
});

test("arrow keys move between tabs", async () => {
  const { links } = seedSharedLinks();
  await render(
    React.createElement(SharedLinks, { links, assets: media, collections, onChange() {} }),
  );
  const tablist = document.querySelector('[role="tablist"]');
  await act(async () =>
    tablist.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, "sl-tab-album");
  await act(async () =>
    tablist.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, "sl-tab-individual");
});

test("delete asks for confirmation and edit saves changes through onChange", async () => {
  const { links } = seedSharedLinks();
  let next = null;
  await render(
    React.createElement(SharedLinks, {
      links,
      assets: media,
      collections,
      onChange(value) {
        next = value;
      },
    }),
  );
  await click("Delete", cards()[2]);
  assert.match(dialog().textContent, /Delete shared link/);
  await click("Cancel");
  assert.equal(dialog(), null);
  assert.equal(next, null);
  await click("Delete", cards()[2]);
  await click("Delete link");
  assert.equal(next.length, 2);
  assert.ok(!next.some((link) => link.id === "sl-family"));

  await click("Edit", cards()[0]);
  assert.match(dialog().textContent, /Edit shared link/);
  const description = dialog().querySelector('input[placeholder="Add a title viewers will see"]');
  assert.equal(description.value, "Our week in the Rockies");
  await type(description, "Rockies trip");
  const slug = dialog().querySelector('input[placeholder="summer-trip"]');
  await type(slug, "rockies-trip");
  assert.match(dialog().textContent, /Changing the address breaks the previous link/);
  await type(slug, "family-reunion");
  assert.match(dialog().textContent, /Already used by another link/);
  await type(slug, "rockies-2026");
  assert.doesNotMatch(dialog().textContent, /Already used/);
  await click("Save");
  assert.equal(dialog(), null);
  assert.equal(next[0].description, "Rockies trip");
  assert.equal(next[0].slug, "rockies-2026");
  assert.equal(next[0].id, "sl-rockies");
});

test("creating a link validates the slug, saves and shows the ready state", async () => {
  const { links } = seedSharedLinks();
  let next = null;
  const opened = [];
  await render(
    React.createElement(SharedLinks, {
      links,
      assets: media,
      collections,
      onChange(value) {
        next = value;
      },
      onOpenPublic(link) {
        opened.push(link.id);
      },
    }),
  );
  await click("New link");
  assert.match(dialog().textContent, /Share an album/);
  await click("Continue");
  assert.match(dialog().textContent, /Create shared link/);
  assert.match(dialog().textContent, /Address is generated when you create the link/);
  const slug = dialog().querySelector('input[placeholder="summer-trip"]');
  await type(slug, "Rockies 2026");
  assert.equal(slug.value, "rockies-2026", "typing normalizes the address");
  assert.match(dialog().textContent, /Already used by another link/);
  await type(slug, "cabin-week");
  assert.match(dialog().textContent, /Available\./);
  assert.match(dialog().textContent, /\?screen=public&link=cabin-week/);
  // The create form's password field keeps the "Optional" placeholder in
  // both hidden and shown states; placeholder selectors are reliable here.
  const passwordField = () => dialog().querySelector('input[placeholder="Optional"]');
  assert.ok(passwordField(), "password field present");
  assert.equal(passwordField().type, "password");
  await type(passwordField(), "secret");
  await click("Show password");
  assert.equal(passwordField().type, "text");
  assert.equal(passwordField().value, "secret");
  await act(async () => {
    const form = dialog().querySelector("form");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.match(dialog().textContent, /Link ready/);
  assert.equal(next.length, 4);
  assert.equal(next[0].slug, "cabin-week");
  assert.equal(next[0].hasPassword, true);
  assert.equal(next[0].password, "secret");
  assert.equal(next[0].type, "album");
  assert.equal(next[0].albumId, "summer-rockies");
  assert.match(dialog().querySelector("input[readonly]").value, /\?screen=public&link=cabin-week$/);
  await click("QR code");
  assert.ok(dialog().querySelector("svg.qr-svg"), "QR code renders inline");
  await click("Open");
  assert.deepEqual(opened, [next[0].id]);
  await click("Done");
  assert.equal(dialog(), null);
});

test("public viewer handles invalid, expired, protected and open links", async () => {
  const { links } = seedSharedLinks();
  const [rockies, grandma, family] = links;
  await render(React.createElement(PublicViewer, { link: null, assets: media, owner }));
  assert.match(text(), /This link is not available/);
  assert.equal(document.querySelector(".pv-actions"), null, "no toolbar without a link");

  await render(React.createElement(PublicViewer, { link: family, assets: media, owner }));
  assert.match(text(), /This link has expired/);
  assert.doesNotMatch(text(), /Family album for the reunion/, "title stays hidden");

  const views = [];
  await render(
    React.createElement(PublicViewer, {
      link: grandma,
      assets: media,
      owner,
      onView(link) {
        views.push(link.id);
      },
    }),
  );
  assert.match(text(), /This share is protected/);
  assert.match(text(), /use “lakeside” to open this sample link/);
  assert.doesNotMatch(text(), /Lake photos for Grandma/);
  assert.deepEqual(views, []);
  const password = document.querySelector('input[type="password"]');
  await type(password, "wrong");
  await act(async () =>
    document
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.match(text(), /That password does not match/);
  await type(document.querySelector('input[type="password"]'), "lakeside");
  await act(async () =>
    document
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.match(text(), /Lake photos for Grandma/);
  assert.equal(document.querySelectorAll(".pv-tile").length, 4);
  assert.deepEqual(views, ["sl-grandma"]);
  assert.equal(button("Download all").disabled, false);
  assert.equal(buttons().some((b) => b.textContent.trim() === "Add photos"), false);

  await render(React.createElement(PublicViewer, { link: rockies, assets: media, owner }));
  const tiles = document.querySelectorAll(".pv-tile");
  assert.equal(tiles.length, 19, "locked and hidden items never appear");
  assert.match(text(), /Shared by Taylor · 19 items · expires in 18 days/);
  await act(async () => tiles[0].click());
  const lightbox = document.querySelector(".pv-lightbox");
  assert.match(lightbox.textContent, /1 of 19/);
  await click("Next item");
  assert.match(lightbox.textContent, /2 of 19/);
  await click("Toggle details");
  assert.match(lightbox.textContent, /Camera.*Exposure.*Location/);
  assert.ok(lightbox.querySelector('a[download][aria-label^="Download"]'), "download allowed");
  await click("Close");
  await click("Select");
  await act(async () => document.querySelectorAll(".pv-tile")[0].click());
  await act(async () => document.querySelectorAll(".pv-tile")[1].click());
  assert.match(text(), /2 of 19 selected/);
  await click("Download selected (2)");
  assert.match(text(), /Preparing archive · 0 of 2/);
  await click("Cancel");
  assert.doesNotMatch(text(), /Preparing archive/);
});

test("public viewer uploads hand files back through onUpload", async () => {
  const [rockies] = seedSharedLinks().links;
  const uploads = [];
  await render(
    React.createElement(PublicViewer, {
      link: rockies,
      assets: media,
      owner,
      onUpload(link, files) {
        uploads.push([link.id, files.map((file) => file.name)]);
      },
    }),
  );
  const input = document.querySelector('input[type="file"]');
  assert.ok(input);
  assert.equal(input.getAttribute("accept"), "image/*,video/*");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new window.File(["x"], "porch.jpg", { type: "image/jpeg" })],
  });
  await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  assert.deepEqual(uploads, [["sl-rockies", ["porch.jpg"]]]);
  assert.match(text(), /1 item added to this share/);
});

test("share sheet switches between people and public link modes", async () => {
  const calls = [];
  await render(
    React.createElement(ShareSheet, {
      assets: [media[1]],
      people,
      recipients: ["Jamie"],
      onRecipients(ids) {
        calls.push(["recipients", ids]);
      },
      onCreateLink(target) {
        calls.push(["link", target]);
      },
      onAction(kind, payload) {
        calls.push([kind, payload]);
      },
      onClose() {},
    }),
  );
  assert.match(dialog().textContent, /Share Hiking with Jamie.jpg/);
  const tiles = [...dialog().querySelectorAll(".ss-people button.ss-person")];
  assert.deepEqual(
    tiles.map((tile) => tile.querySelector(".ss-person-name").textContent),
    ["Jamie", "Emma"],
    "owner is excluded from recipients",
  );
  assert.equal(tiles[0].getAttribute("aria-pressed"), "true");
  assert.equal(tiles[1].getAttribute("aria-pressed"), "false");
  await act(async () => tiles[1].click());
  assert.deepEqual(calls.at(-1), ["recipients", ["Jamie", "Emma"]]);
  await click("Share with Jamie");
  assert.deepEqual(calls.at(-1), ["save", ["Jamie"]]);
  await act(async () => dialog().querySelector('[data-mode="link"]').click());
  assert.equal(dialog().querySelector('[data-mode="link"]').getAttribute("aria-checked"), "true");
  await click("Create public link");
  assert.deepEqual(calls.at(-1), [
    "link",
    { type: "individual", assetIds: ["2"], name: "Hiking with Jamie.jpg" },
  ]);
  await click("Download");
  assert.equal(calls.at(-1)[0], "download");
  assert.equal(button("Copy image").disabled, false);
});

test("partner header toggles settings and confirms stop sharing", async () => {
  const patches = [];
  let settingsOpened = 0;
  await render(
    React.createElement(PartnerHeader, {
      partner: { id: "jamie", name: "Jamie", image: "/media/avatar-jamie.png" },
      count: 128,
      settings: { inTimeline: true, shareLocation: false },
      onChange(patch) {
        patches.push(patch);
      },
      onOpenSettings() {
        settingsOpened += 1;
      },
    }),
  );
  assert.match(text(), /Jamie’s library/);
  assert.match(text(), /128 items/);
  const switches = [...document.querySelectorAll('[role="switch"]')];
  assert.equal(switches.length, 2);
  assert.equal(switches[0].checked, true);
  await act(async () => switches[1].click());
  assert.deepEqual(patches, [{ shareLocation: true }]);
  await click("Sharing settings");
  assert.equal(settingsOpened, 1);
  await click("Stop sharing");
  assert.match(dialog().textContent, /Stop sharing with this partner/);
  await click("Cancel");
  assert.equal(patches.length, 1);
  await click("Stop sharing");
  await click("Stop sharing", dialog());
  assert.deepEqual(patches.at(-1), { sharing: false });
  assert.equal(dialog(), null);
});
