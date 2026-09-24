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

const people = [
  {
    id: "emma",
    name: "Emma",
    birthday: "2012-03-02",
    image: "/media/avatar-emma.png",
  },
  { id: "jamie", name: "Jamie", image: "/media/avatar-jamie.png" },
  { id: "ghost", name: "Ghost", hidden: true },
];
const base = {
  type: "photo",
  ownerId: "taylor",
  make: "Sony",
  model: "α7 IV",
  lensModel: "FE 24–70mm F2.8 GM",
  fNumber: 2.8,
  exposureTime: "1/500",
  iso: 100,
  focalLength: 35,
  width: 6000,
  height: 4000,
  fileSizeInBytes: 8_400_000,
  city: "Banff",
  state: "Alberta",
  country: "Canada",
  latitude: 51.1784,
  longitude: -115.5708,
  takenAt: "2026-08-16T07:14:00",
  date: "2026-08-16",
  originalPath: "/photos/2026/Rockies/a.jpg",
  originalFileName: "a.jpg",
  checksum: "sha1-abc",
  albumIds: ["family"],
  tagIds: ["lake"],
  rating: 3,
  visibility: "timeline",
  enrichment: {
    description: { status: "generated", model: "Local model", confidence: 0.9 },
    sensitive: { status: "reviewed", score: 0.02 },
  },
};
const assets = [
  {
    ...base,
    id: "a",
    name: "Lake.jpg",
    image: "/media/lake.png",
    description: "A quiet lake",
    personIds: ["emma", "ghost"],
    stackId: "s",
    stackPrimary: true,
    ocr: "LAKE AGNES 3.4 km",
  },
  {
    ...base,
    id: "b",
    name: "Lake 2.jpg",
    image: "/media/lake2.png",
    stackId: "s",
    description: "",
  },
  {
    ...base,
    id: "c",
    name: "Live.jpg",
    image: "/media/live.png",
    isLivePhoto: true,
    livePhotoVideo: "/media/live.mp4",
    isOffline: true,
  },
  {
    ...base,
    id: "v",
    name: "Clip.mov",
    type: "video",
    image: "/media/clip.png",
    mediaSrc: "/media/clip.mp4",
    duration: 24,
    frameRate: 29.97,
  },
];
const faces = [
  {
    id: "f1",
    personId: "emma",
    box: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
  },
  {
    id: "f2",
    personId: null,
    box: { x: 0.6, y: 0.2, width: 0.1, height: 0.1 },
  },
  {
    id: "f3",
    personId: "ghost",
    box: { x: 0.8, y: 0.2, width: 0.1, height: 0.1 },
  },
];

let vite;
let MediaViewer;
let mounted;
let calls;
let props;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ MediaViewer } = await vite.ssrLoadModule("/src/MediaViewer.jsx"));
});

const render = (overrides = {}) =>
  act(async () => {
    props = { ...props, ...overrides };
    mounted.render(React.createElement(MediaViewer, props));
  });

beforeEach(async () => {
  calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
      return true;
    };
  props = {
    assets,
    assetId: "a",
    people,
    faces,
    albums: [{ id: "family", name: "Family", cover: "/media/family.png" }],
    tagOptions: [
      { id: "lake", label: "lake" },
      { id: "mountains", label: "mountains" },
    ],
    castDevices: [{ id: "tv", name: "Living room TV", type: "tv" }],
    onClose: record("close"),
    onNavigateAsset: record("navigate"),
    onFavorite: record("favorite"),
    onEdit: record("edit"),
    onTrash: record("trash"),
    onShare: record("share"),
    onAction: record("action"),
    onUpdate: record("update"),
    onFaceAction: record("face"),
    onTagPeople: record("tagPeople"),
  };
  window.document.body.innerHTML = '<div id="root"></div>';
  mounted = createRoot(window.document.querySelector("#root"));
  await render();
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
const byLabel = (label) =>
  $$("button").find((el) => el.getAttribute("aria-label") === label) ||
  $$("button").find((el) => el.textContent.trim() === label);
const click = (element) => act(async () => element.click());
const key = (init, target = document.activeElement) =>
  act(async () => {
    (target || document.body).dispatchEvent(
      new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
/** Bypass React's value tracker, then nudge React's key-based change polyfill
 * (happy-dom does not advertise oninput, so React watches keyup instead). */
const type = (element, value) =>
  act(async () => {
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(
      new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }),
    );
  });
const actions = () =>
  calls.filter(([name]) => name === "action").map((call) => call.slice(1));
const updates = () =>
  calls.filter(([name]) => name === "update").map((call) => call.slice(1));

test("header shows the file name, EXIF headline and position; the viewer opens as a modal", async () => {
  const dialog = $("dialog.media-viewer");
  assert.ok(dialog?.hasAttribute("open"));
  assert.equal(dialog.getAttribute("aria-label"), "Media viewer: Lake.jpg");
  assert.match($(".mv-title strong").textContent, /Lake\.jpg/);
  assert.match($(".mv-title strong small").textContent, /1 of 4/);
  assert.equal(
    $(".mv-title > span").textContent,
    "Sony α7 IV · FE 24–70mm F2.8 GM · ƒ/2.8 · 1/500 s · ISO 100 · 35 mm · 6,000 × 4,000 · 8.4 MB",
  );
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "Close viewer",
  );
});

test("keyboard parity: arrows browse, up and down move through the stack, letters trigger actions", async () => {
  await key({ key: "ArrowRight" });
  assert.deepEqual(calls.at(-1), ["navigate", "b"]);
  await key({ key: "ArrowDown" });
  assert.deepEqual(
    calls.at(-1),
    ["navigate", "b"],
    "down moves to the next stack member",
  );
  await key({ key: "f" });
  assert.deepEqual(calls.at(-1), ["favorite", "a"]);
  await key({ key: "e" });
  assert.equal(calls.at(-1)[0], "edit");
  await key({ key: "p" });
  assert.deepEqual(calls.at(-1), ["tagPeople", "a"]);
  await key({ key: "l" });
  assert.deepEqual(actions().at(-1), ["add-to-album", "a", undefined]);
  await key({ key: "A", shiftKey: true });
  assert.deepEqual(actions().at(-1), ["archive", "a", undefined]);
  await key({ key: "D", shiftKey: true });
  assert.deepEqual(actions().at(-1), ["download", "a", undefined]);
  await key({ key: "4" });
  assert.deepEqual(updates().at(-1), ["a", { rating: 4 }]);
  await key({ key: "0" });
  assert.deepEqual(updates().at(-1), ["a", { rating: 0 }]);
  await key({ key: "Delete" });
  assert.deepEqual(calls.at(-1), ["trash", "a"]);
  await key({ key: "F", shiftKey: true });
  assert.ok($(".mv-filmstrip"), "Shift+F shows the filmstrip");
  assert.equal(
    $('.mv-filmstrip [aria-current="true"]').getAttribute("aria-label"),
    "Lake.jpg",
  );
  assert.equal($$(".mv-filmstrip button").length, 4);
  await key({ key: "F", shiftKey: true });
  assert.equal($(".mv-filmstrip"), null);
  await key({ key: "Escape" });
  assert.equal(calls.at(-1)[0], "close");
});

test("the stack strip lists members with the primary marked and the more menu is grouped", async () => {
  const strip = $(".mv-stack");
  assert.ok(strip);
  assert.equal($$(".mv-stack-items button").length, 2);
  assert.match(
    $('.mv-stack-items button[aria-current="true"]').textContent,
    /Primary/,
  );
  await click($(".mv-stack-items li:nth-child(2) button"));
  assert.deepEqual(calls.at(-1), ["navigate", "b"]);

  await click(byLabel("More actions"));
  const menu = $('[role="menu"][aria-label="More actions"]');
  assert.ok(menu);
  const groups = $$('[role="menu"] [role="group"]').map((group) =>
    group.getAttribute("aria-label"),
  );
  assert.deepEqual(groups, [
    "Download",
    "Organize",
    "Stack",
    "Set as",
    "Go to",
    "Jobs",
    "Viewer",
  ]);
  const labels = $$('[role="menuitem"]').map((item) => item.textContent.trim());
  assert.ok(
    labels.includes("Unstack") && labels.includes("Keep this, remove the rest"),
  );
  assert.ok(
    !labels.includes("Set as stack primary"),
    "the primary cannot be re-set as primary",
  );
  assert.ok(
    labels.includes("Refresh faces") &&
      labels.includes("Album cover") &&
      labels.includes("Show in folder"),
  );
  assert.equal(document.activeElement.getAttribute("role"), "menuitem");
  await key({ key: "End" });
  assert.equal(document.activeElement.textContent.trim(), "Slideshow settings");
  await key({ key: "Home" });
  assert.equal(document.activeElement.textContent.trim(), "Download");
  await click(
    $$('[role="menuitem"]').find(
      (item) => item.textContent.trim() === "Unstack",
    ),
  );
  assert.deepEqual(actions().at(-1), ["unstack", "a", undefined]);
  assert.equal($('[role="menu"]'), null);
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "More actions",
  );
});

test("information panel edits description, tags, and people faces through the callbacks", async () => {
  await key({ key: "i" });
  const panel = $(".mv-info");
  assert.ok(panel);
  assert.equal(
    $(".mv-badge").textContent,
    "AI",
    "AI-written descriptions carry an AI badge",
  );
  assert.match(
    $(".mv-enrichment").textContent,
    /Written by AI · Local model · 90% confident/,
  );
  assert.ok(
    $$(".mv-enrich-actions button").some((b) => b.textContent === "Accept"),
  );
  const area = $(".mv-description-input");
  assert.equal(area.value, "A quiet lake");
  await act(async () => area.focus());
  await type(area, "A quiet lake at dawn");
  await key({ key: "Enter" }, area);
  await act(async () => area.blur());
  assert.deepEqual(updates().at(-1), [
    "a",
    { description: "A quiet lake at dawn" },
  ]);
  await flush();
  assert.equal($(".mv-badge").textContent, "Yours");

  // A manual description replaces the generated one, so its model evidence and Accept go away.
  assert.match($(".mv-enrichment").textContent, /DescriptionWritten by you/);
  assert.doesNotMatch(
    $(".mv-enrichment").textContent,
    /Local model|confident|Written by AI/,
  );
  assert.ok(
    !$$(".mv-enrich-actions button").some((b) => b.textContent === "Accept"),
  );
  assert.match($(".mv-enrichment").textContent, /Reviewed/);
  await click(
    $$(".mv-enrich-actions button").find(
      (b) => b.textContent === "Mark sensitive",
    ),
  );
  assert.deepEqual(actions().at(-1), ["lock", "a", undefined]);

  const chips = $$(".mv-chip");
  assert.equal(
    chips.length,
    2,
    "one assigned face plus one unnamed face; hidden people stay hidden",
  );
  assert.equal(chips[0].getAttribute("title"), "Emma · 14");
  await act(async () => chips[0].focus());
  assert.ok(
    $(".mv-face-box"),
    "focusing a chip highlights its face on the image",
  );
  assert.equal($(".mv-face-box span").textContent, "Emma");
  await click(byLabel("Options for Emma"));
  const items = $$('.mv-chip-menu [role="menuitem"]').map((item) =>
    item.textContent.trim(),
  );
  assert.deepEqual(items, [
    "Open person",
    "Reassign face…",
    "Create new person…",
    "Remove face",
    "Hide face",
  ]);
  await click(
    $$('.mv-chip-menu [role="menuitem"]').find(
      (item) => item.textContent.trim() === "Reassign face…",
    ),
  );
  const search = $('.mv-picker input[type="search"]');
  assert.ok(search);
  await type(search, "jam");
  await click(
    $$(".mv-picker-list button").find((b) => b.textContent.trim() === "Jamie"),
  );
  assert.deepEqual(calls.at(-1), [
    "face",
    "a",
    { type: "reassign", personId: "jamie", faceId: "f1" },
  ]);
  await click(byLabel("Options for Unnamed person"));
  await click(
    $$('.mv-chip-menu [role="menuitem"]').find(
      (item) => item.textContent.trim() === "Remove face",
    ),
  );
  assert.deepEqual(calls.at(-1), [
    "face",
    "a",
    { type: "remove", faceId: "f2" },
  ]);
  await click(
    $$(".mv-text-button").find((b) => /Show hidden/.test(b.textContent)),
  );
  assert.equal($$(".mv-chip").length, 3);

  const tagInput = $('[data-mv-focus="tags"]');
  await act(async () => tagInput.focus());
  await type(tagInput, "moun");
  assert.deepEqual(
    $$('[role="option"]').map((o) => o.textContent.trim()),
    ["mountains", "Create “moun”"],
  );
  await key({ key: "Enter" }, tagInput);
  assert.deepEqual(updates().at(-1), ["a", { tagIds: ["lake", "mountains"] }]);
  await click(byLabel("Remove tag lake"));
  assert.deepEqual(updates().at(-1), ["a", { tagIds: [] }]);

  assert.match($(".mv-details").textContent, /6,000 × 4,000 · 24 MP · 8.4 MB/);
  await click(
    $$(".mv-link-button").find((b) => b.textContent === "Sony α7 IV"),
  );
  assert.deepEqual(actions().at(-1), [
    "search-camera",
    "a",
    { make: "Sony", model: "α7 IV" },
  ]);
  await click(
    $$(".mv-text-button").find((b) => /Show in folder/.test(b.textContent)),
  );
  assert.deepEqual(actions().at(-1), ["open-folder", "a", undefined]);
  await click($$(".mv-albums button")[0]);
  assert.deepEqual(actions().at(-1), [
    "open-album",
    "a",
    { albumId: "family" },
  ]);
  const link = $("a.mv-link");
  assert.equal(
    link.getAttribute("href"),
    "https://www.openstreetmap.org/?mlat=51.1784&mlon=-115.5708#map=14/51.1784/-115.5708",
  );
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
  await click(
    $$(".mv-text-button").find((b) => /Show text regions/.test(b.textContent)),
  );
  assert.equal($$(".mv-ocr-box").length, 1);
});

test("date and location dialogs save through onUpdate and the panel closes with its own button", async () => {
  await key({ key: "i" });
  await click(byLabel("Edit date and time"));
  const dateDialog = $$("dialog.dialog").at(-1);
  assert.match(dateDialog.textContent, /Edit date and time/);
  const dateInput = dateDialog.querySelector('input[type="date"]');
  const timeInput = dateDialog.querySelector('input[type="time"]');
  await type(dateInput, "2026-08-17");
  await type(timeInput, "09:30");
  await click(
    [...dateDialog.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Save",
    ),
  );
  assert.deepEqual(updates().at(-1), [
    "a",
    { takenAt: "2026-08-17T09:30:00", date: "2026-08-17" },
  ]);
  await flush();
  assert.equal($$("dialog.dialog").length, 0);

  await click(byLabel("Edit location"));
  const locationDialog = $$("dialog.dialog").at(-1);
  const city = [...locationDialog.querySelectorAll("input")][0];
  await type(city, "Canmore");
  const map = locationDialog.querySelector(".mv-map");
  await key({ key: "ArrowUp", shiftKey: true }, map);
  await click(
    [...locationDialog.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Save",
    ),
  );
  const [, patch] = updates().at(-1);
  assert.equal(patch.city, "Canmore");
  assert.equal(patch.country, "Canada");
  assert.ok(
    Math.abs(patch.latitude - 51.2284) < 1e-6,
    "the pin nudged north by 0.05°",
  );
  assert.equal(patch.longitude, -115.5708);
  await click(byLabel("Close information"));
  assert.equal($(".mv-info"), null);
});

test("rating popover, cast dialog and copy image are exposed from the toolbar", async () => {
  await click(byLabel("Rating · 3 stars"));
  const popover = $(".mv-rating-popover");
  assert.ok(popover);
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "Rate 1 star",
  );
  await key({ key: "ArrowRight" });
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "Rate 2 stars",
  );
  await click(byLabel("Rate 5 stars"));
  assert.deepEqual(updates().at(-1), ["a", { rating: 5 }]);
  assert.equal($(".mv-rating-popover"), null);

  await click(byLabel("Cast"));
  const cast = $$("dialog.dialog").at(-1);
  assert.match(cast.textContent, /Living room TV/);
  await click(
    [...cast.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Connect",
    ),
  );
  assert.deepEqual(actions().at(-1), ["cast", "a", { deviceId: "tv" }]);
  await flush();
  assert.match(cast.textContent, /Connected/);
  await click(
    [...cast.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Disconnect",
    ),
  );
  assert.deepEqual(actions().at(-1), ["cast", "a", { deviceId: null }]);
  await click(byLabel("Close dialog"));
  assert.ok(byLabel("Copy image"));
});

test("live photos, offline originals and videos get their dedicated canvas controls", async () => {
  await render({ assetId: "c" });
  assert.ok($(".mv-live-badge"), "live badge present");
  assert.equal($(".mv-live-badge").getAttribute("aria-pressed"), "false");
  await click($(".mv-live-badge"));
  assert.ok(
    $(".mv-live-video"),
    "pressing the badge plays the paired clip inline",
  );
  const offline = $('.mv-offline[role="alert"]');
  assert.match(offline.textContent, /Original file unavailable/);
  assert.match(offline.textContent, /\/photos\/2026\/Rockies\/a\.jpg/);
  await click(
    [...offline.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Relink",
    ),
  );
  assert.deepEqual(actions().at(-1), ["open-folder", "c", undefined]);

  await render({ assetId: "v" });
  assert.ok($("video[controls]"));
  const segment = $('.mv-segment[aria-label="Video source"]');
  assert.deepEqual(
    [...segment.querySelectorAll("button")].map((b) => b.textContent),
    ["Play original", "Play encoded"],
  );
  assert.equal(
    segment.querySelector('[aria-pressed="true"]').textContent,
    "Play original",
  );
  await click(segment.querySelectorAll("button")[1]);
  assert.equal(
    segment.querySelector('[aria-pressed="true"]').textContent,
    "Play encoded",
  );
  assert.equal(byLabel("Copy image"), undefined, "no copy image for videos");
  assert.match($(".mv-title > span").textContent, /29\.97 fps · 0:24/);
});

test("trash context swaps toolbar actions for restore and permanent delete with confirmation", async () => {
  await render({
    trash: true,
    assets: assets.map((asset) => ({ ...asset, isTrashed: true })),
  });
  assert.ok(byLabel("Restore"));
  assert.equal(byLabel("Move to trash"), undefined);
  assert.equal(byLabel("Add to favorites"), undefined);
  await click(byLabel("Restore"));
  assert.deepEqual(actions().at(-1), ["restore", "a", undefined]);
  await click(byLabel("Delete permanently"));
  const confirm = $$("dialog.dialog").at(-1);
  assert.match(confirm.textContent, /Delete permanently\?/);
  assert.equal(document.activeElement.textContent.trim(), "Delete permanently");
  await click(document.activeElement);
  assert.deepEqual(actions().at(-1), ["delete-permanently", "a", undefined]);
  await click(byLabel("More actions"));
  const labels = $$('[role="menuitem"]').map((item) => item.textContent.trim());
  assert.ok(
    labels.includes("Restore") && labels.includes("Delete permanently"),
  );
  assert.ok(
    !labels.includes("Archive") && !labels.includes("Refresh metadata"),
  );
});

test("availableActions hides unsupported entries and legacy ids keep working", async () => {
  await render({ availableActions: ["download", "stack", "view-in-timeline"] });
  await click(byLabel("More actions"));
  const labels = $$('[role="menuitem"]').map((item) => item.textContent.trim());
  assert.ok(labels.includes("Download") && labels.includes("View in timeline"));
  assert.ok(
    !labels.includes("Archive") &&
      !labels.includes("Add to album") &&
      !labels.includes("Copy image"),
  );
  assert.equal(byLabel("Cast"), undefined, "cast is hidden when not available");
  await key({ key: "Escape" });
  assert.equal($('[role="menu"]'), null);
  assert.equal(
    calls.some(([name]) => name === "close"),
    false,
    "Escape closes the menu first, not the viewer",
  );
});
