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
  localStorage: window.localStorage,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLDialogElement: window.HTMLDialogElement,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
};
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });

let vite;
let SharingAccess;
let AlbumCard;
let PartnerLockedNotice;
let mounted;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ SharingAccess } = await vite.ssrLoadModule("/src/SharingAccess.jsx"));
  ({ AlbumCard } = await vite.ssrLoadModule("/src/AlbumCard.jsx"));
  ({ PartnerLockedNotice } = await vite.ssrLoadModule("/src/PartnerLockedNotice.jsx"));
});

beforeEach(() => window.localStorage.clear());

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
});

after(async () => {
  await vite?.close();
  window.close();
});

const render = async (element) => {
  window.document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(element);
  });
};
const text = () => document.body.textContent.replace(/\s+/g, " ");
const button = (name, scope = document) => {
  const match = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  assert.ok(match, `missing button ${name}`);
  return match;
};
const click = (name, scope) => act(async () => button(name, scope).click());
const dialog = () => document.querySelector("dialog[open]");

test("partner card lists what is shared and the copy progress, with no toggles", async () => {
  await render(React.createElement(SharingAccess, { section: "partner", onNavigate() {} }));
  const card = document.querySelector(".cc-sharing-list article");
  assert.ok(card, "partner card rendered");
  assert.match(card.textContent, /Jamie/);
  assert.equal(card.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.doesNotMatch(text(), /Show shared photos in my timeline/);
  const shared = [...card.querySelectorAll(".cc-partner-shared li")].map((item) =>
    item.textContent.trim(),
  );
  assert.deepEqual(shared, [
    "Photos and videos",
    "Albums you own",
    "Tags",
    "People",
    "Descriptions and locations",
    "Locked items",
  ]);
  const progress = card.querySelector('[role="progressbar"]');
  assert.ok(progress, "backfill progress bar");
  assert.equal(progress.getAttribute("aria-valuenow"), "38");
  assert.match(card.textContent, /Copying 1,240 of 3,200 items/);
  assert.match(text(), /their own copies/);
});

test("adding a partner queues a copy and stopping keeps their copies", async () => {
  await render(React.createElement(SharingAccess, { section: "partner", onNavigate() {} }));
  await click("Add partner");
  assert.match(dialog().textContent, /own copies/);
  await click("Confirm", dialog());
  const cards = [...document.querySelectorAll(".cc-sharing-list article")];
  assert.equal(cards.length, 2);
  assert.match(cards[1].textContent, /Waiting to start/);
  await click("Stop sharing", cards[0]);
  assert.match(dialog().textContent, /keeps everything already copied/);
  await click("Confirm", dialog());
  const stopped = document.querySelector(".cc-sharing-list article");
  assert.match(stopped.textContent, /Stopped · 1,240 items already copied stay in their library/);
  const saved = JSON.parse(window.localStorage.getItem("frameleaf:sharing-access:v1"));
  assert.equal("inTimeline" in saved.partners[0], false);
});

test("album card marks albums copied from a partner", async () => {
  const collection = {
    id: "jamie-hikes",
    name: "Jamie’s hikes",
    icon: "mdiImageAlbum",
    kind: "album",
    members: [{ userId: "taylor", role: "owner" }],
    origin: { rootOwnerId: "jamie" },
  };
  await render(
    React.createElement(AlbumCard, {
      collection,
      users: [{ id: "jamie", name: "Jamie" }],
      currentUserId: "taylor",
    }),
  );
  const mark = document.querySelector(".al-origin-mark");
  assert.ok(mark, "origin mark rendered");
  assert.equal(mark.getAttribute("title"), "From Jamie’s library");
  assert.equal(mark.getAttribute("aria-label"), "From Jamie’s library");

  await act(async () => mounted.unmount());
  await render(
    React.createElement(AlbumCard, {
      collection: { ...collection, origin: null },
      currentUserId: "taylor",
    }),
  );
  assert.equal(document.querySelector(".al-origin-mark"), null);
});

test("locked partner items notice offers a PIN once and never with a PIN", async () => {
  let opened = 0;
  const props = { partnerName: "Jamie", hasPin: false, onSetPin: () => (opened += 1) };
  await render(React.createElement(PartnerLockedNotice, props));
  assert.match(text(), /Jamie shared Locked items with you/);
  assert.match(text(), /hidden until you set a PIN/);
  await click("Set a PIN");
  assert.equal(opened, 1);
  await click("Not now");
  assert.equal(document.querySelector(".pl-notice"), null);

  // dismissed for good
  await act(async () => mounted.unmount());
  await render(React.createElement(PartnerLockedNotice, props));
  assert.equal(document.querySelector(".pl-notice"), null);

  window.localStorage.clear();
  await act(async () => mounted.unmount());
  await render(React.createElement(PartnerLockedNotice, { ...props, hasPin: true }));
  assert.equal(document.querySelector(".pl-notice"), null);
});
