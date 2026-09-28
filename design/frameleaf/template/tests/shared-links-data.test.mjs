import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPIRY_PRESETS,
  SHARED_LINKS_KEY,
  absoluteLinkUrl,
  addUploads,
  checkPassword,
  createLink,
  deleteLink,
  expiryFromPreset,
  expiryLabel,
  isExpired,
  linkAssets,
  linkBadges,
  linkTitle,
  linkUrl,
  loadSharedLinks,
  normalizeSlug,
  parseSharedLinks,
  recordView,
  resolveLink,
  saveSharedLinks,
  seedSharedLinks,
  serializeSharedLinks,
  slugAvailability,
  updateLink,
  validateLinkInput,
} from "../src/shared-links-data.mjs";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const DAY = 86_400_000;
const assets = [
  { id: "1", name: "Lake morning.mov", type: "video", albumIds: ["summer-rockies"], visibility: "timeline" },
  { id: "2", name: "Hiking.jpg", type: "photo", albumIds: ["summer-rockies", "family"], visibility: "timeline" },
  { id: "3", name: "Locked.jpg", type: "photo", albumIds: ["summer-rockies"], isLocked: true },
  { id: "4", name: "Sensitive.jpg", type: "photo", albumIds: ["family"], isSensitive: true },
  { id: "5", name: "Cabin.jpg", type: "photo", albumIds: ["family"], visibility: "archive" },
];
const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};

test("seeds three links covering expiry, password and upload states", () => {
  const state = seedSharedLinks(NOW);
  assert.equal(state.version, 1);
  assert.equal(state.links.length, 3);
  const [rockies, grandma, family] = state.links;
  assert.equal(rockies.type, "album");
  assert.equal(rockies.slug, "rockies-2026");
  assert.ok(rockies.allowUpload && rockies.allowDownload && rockies.showMetadata);
  assert.equal(isExpired(rockies, NOW), false);
  assert.equal(grandma.type, "individual");
  assert.ok(grandma.hasPassword);
  assert.equal(grandma.password, "lakeside");
  assert.equal(grandma.expiresAt, null);
  assert.equal(isExpired(family, NOW), true);
  assert.equal(expiryLabel(family, NOW), "Expired 2 days ago");
  assert.equal(expiryLabel(rockies, NOW), "Expires in 18 days");
  assert.equal(expiryLabel(grandma, NOW), "Never expires");
});

test("createLink validates input, applies defaults and prepends the link", () => {
  const base = seedSharedLinks(NOW);
  const { state, link } = createLink(
    base,
    { type: "individual", assetIds: ["2", "2", "5"], description: "  Cabin week  ", slug: "cabin-week", allowUpload: true },
    NOW,
    "sl-test",
  );
  assert.equal(state.links[0].id, "sl-test");
  assert.equal(state.links.length, 4);
  assert.deepEqual(link.assetIds, ["2", "5"]);
  assert.equal(link.description, "Cabin week");
  assert.equal(link.allowDownload, true, "downloads default on");
  assert.equal(link.allowUpload, true);
  assert.equal(link.showMetadata, false);
  assert.equal(link.hasPassword, false);
  assert.equal(link.password, null);
  assert.equal(link.views, 0);
  assert.equal(link.createdAt, new Date(NOW).toISOString());
  assert.throws(() => createLink(base, { type: "album" }), /Choose an album/);
  assert.throws(() => createLink(base, { type: "individual", assetIds: [] }), /at least one item/);
  assert.throws(
    () => createLink(base, { type: "album", albumId: "family", slug: "rockies-2026" }),
    /Already used/,
  );
  assert.throws(
    () => createLink(base, { type: "album", albumId: "family", slug: "Bad Slug" }),
    /lowercase letters/,
  );
  assert.throws(
    () => createLink(base, { type: "album", albumId: "family", expiresAt: "soon" }),
    /valid expiry/,
  );
  assert.throws(() => createLink(base, { type: "album", albumId: "family" }, NOW, "sl-rockies"), /Duplicate/);
  assert.deepEqual(validateLinkInput({ type: "album", albumId: "family" }, base.links), []);
});

test("updateLink merges patches, handles passwords and rejects slug collisions", () => {
  const base = seedSharedLinks(NOW);
  const { state, link } = updateLink(
    base,
    "sl-grandma",
    { description: "For Grandma", password: "", allowUpload: true, expiresAt: new Date(NOW + DAY).toISOString() },
    NOW + 1000,
  );
  assert.equal(link.description, "For Grandma");
  assert.equal(link.hasPassword, false);
  assert.equal(link.password, null);
  assert.equal(link.allowUpload, true);
  assert.equal(link.expiresAt, new Date(NOW + DAY).toISOString());
  assert.equal(link.updatedAt, new Date(NOW + 1000).toISOString());
  assert.equal(link.createdAt, base.links[1].createdAt);
  assert.equal(state.links.find((entry) => entry.id === "sl-grandma"), link);
  const kept = updateLink(state, "sl-grandma", { description: "Same" }).link;
  assert.equal(kept.hasPassword, false, "undefined password leaves the flag alone");
  const secured = updateLink(state, "sl-grandma", { password: "new-pass" }).link;
  assert.equal(secured.hasPassword, true);
  assert.equal(secured.password, "new-pass");
  assert.throws(() => updateLink(base, "sl-grandma", { slug: "rockies-2026" }), /Already used/);
  assert.equal(updateLink(base, "sl-rockies", { slug: "rockies-2026" }).link.slug, "rockies-2026", "own slug stays available");
  assert.equal(updateLink(base, "sl-rockies", { slug: "" }).link.slug, null);
  assert.throws(() => updateLink(base, "missing", {}), /not found/);
  assert.equal(base.links[1].hasPassword, true, "input state is untouched");
});

test("deleteLink, recordView and addUploads are immutable and bounded", () => {
  const base = seedSharedLinks(NOW);
  const smaller = deleteLink(base, "sl-family");
  assert.equal(smaller.links.length, 2);
  assert.equal(base.links.length, 3);
  const viewed = recordView(base, "sl-rockies", NOW);
  assert.equal(viewed.links[0].views, 25);
  assert.equal(viewed.links[0].lastViewedAt, new Date(NOW).toISOString());
  assert.equal(base.links[0].views, 24);
  const { state, uploads } = addUploads(
    base,
    "sl-rockies",
    [
      { name: "IMG_0042.HEIC", type: "image/heic", size: 4_200_000 },
      { name: "clip.mov", type: "", size: 12_000_000 },
      { name: "bad\u0000name", type: "image/png", size: -4 },
    ],
    NOW,
  );
  assert.equal(uploads.length, 3);
  assert.deepEqual(
    uploads.map((upload) => upload.kind),
    ["photo", "video", "photo"],
  );
  assert.equal(uploads[2].name, "Upload");
  assert.equal(uploads[2].size, 0);
  assert.deepEqual(
    state.links[0].uploadedAssetIds,
    uploads.map((upload) => upload.id),
  );
  assert.equal(base.links[0].uploads.length, 0);
  assert.throws(() => addUploads(base, "sl-family", [{ name: "x.jpg" }]), /not allowed/);
});

test("resolveLink matches ids and slugs and isExpired respects the clock", () => {
  const state = seedSharedLinks(NOW);
  assert.equal(resolveLink(state, "sl-grandma").id, "sl-grandma");
  assert.equal(resolveLink(state, "rockies-2026").id, "sl-rockies");
  assert.equal(resolveLink(state, " Rockies-2026 ").id, "sl-rockies");
  assert.equal(resolveLink(state.links, "family-reunion").id, "sl-family");
  assert.equal(resolveLink(state, "nope"), null);
  assert.equal(resolveLink(state, ""), null);
  assert.equal(resolveLink(state, undefined), null);
  const [rockies] = state.links;
  assert.equal(isExpired(rockies, NOW + 17 * DAY), false);
  assert.equal(isExpired(rockies, NOW + 19 * DAY), true);
  assert.equal(isExpired({ expiresAt: null }, NOW), false);
});

test("expiry presets and slug helpers behave as specified", () => {
  assert.deepEqual(
    EXPIRY_PRESETS.map((preset) => preset.label),
    ["30 minutes", "1 hour", "6 hours", "1 day", "7 days", "30 days", "3 months", "1 year", "Never"],
  );
  assert.equal(expiryFromPreset("30m", NOW), new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(expiryFromPreset("1y", NOW), new Date(NOW + 365 * DAY).toISOString());
  assert.equal(expiryFromPreset("never", NOW), null);
  assert.equal(expiryFromPreset("bogus", NOW), null);
  assert.equal(normalizeSlug(" Summer Trip_2026! "), "summer-trip-2026");
  assert.equal(normalizeSlug("--a--b--"), "a-b");
  assert.equal(normalizeSlug("x".repeat(60)).length, 48);
  const links = seedSharedLinks(NOW).links;
  assert.equal(slugAvailability("", links).status, "empty");
  assert.equal(slugAvailability("ab", links).status, "invalid");
  assert.equal(slugAvailability("Rockies", links).status, "invalid");
  assert.equal(slugAvailability("rockies-2026", links).status, "taken");
  assert.equal(slugAvailability("sl-grandma", links).status, "taken", "ids are reserved");
  assert.equal(slugAvailability("rockies-2026", links, "sl-rockies").status, "available");
  assert.equal(slugAvailability("fresh-slug", links).status, "available");
});

test("urls, passwords, titles, badges and viewer assets derive from the link", () => {
  const state = seedSharedLinks(NOW);
  const [rockies, grandma] = state.links;
  assert.equal(linkUrl(rockies), "?screen=public&link=rockies-2026");
  assert.equal(linkUrl(grandma), "?screen=public&link=sl-grandma");
  assert.equal(
    absoluteLinkUrl(rockies, "https://photos.example/"),
    "https://photos.example/?screen=public&link=rockies-2026",
  );
  assert.equal(checkPassword(rockies, ""), true);
  assert.equal(checkPassword(grandma, "lakeside"), true);
  assert.equal(checkPassword(grandma, "Lakeside"), false);
  assert.equal(checkPassword({ hasPassword: true, password: null }, "anything"), false);
  const collections = [{ id: "summer-rockies", name: "Summer in the Rockies" }];
  assert.equal(linkTitle(rockies, { collections }), "Summer in the Rockies");
  assert.equal(linkTitle(rockies, { collections: { "summer-rockies": "Rockies" } }), "Rockies");
  assert.equal(linkTitle(grandma, { assets }), "4 items");
  assert.equal(
    linkTitle({ type: "individual", assetIds: ["2"] }, { assets }),
    "Hiking.jpg",
  );
  assert.deepEqual(
    linkBadges(rockies, NOW).map((badge) => badge.id),
    ["download", "upload", "metadata", "expiry", "views"],
  );
  assert.deepEqual(
    linkBadges(state.links[2], NOW).map((badge) => badge.id),
    ["expired", "views"],
  );
  assert.equal(linkBadges(grandma, NOW)[0].id, "password");
  assert.equal(linkBadges(grandma, NOW).at(-1).label, "6 views");
  assert.deepEqual(
    linkAssets(rockies, assets).map((asset) => asset.id),
    ["1", "2"],
    "locked items never appear in an album share",
  );
  const shared = createLink(state, { type: "individual", assetIds: ["2", "4", "5", "99"] }, NOW, "sl-x").link;
  assert.deepEqual(linkAssets(shared, assets).map((asset) => asset.id), ["2", "5"]);
  const withUploads = addUploads(state, "sl-rockies", [{ name: "new.jpg", type: "image/jpeg", size: 10 }], NOW).state;
  const viewerItems = linkAssets(withUploads.links[0], assets);
  assert.equal(viewerItems.length, 3);
  assert.equal(viewerItems[2].placeholder, true);
  assert.equal(viewerItems[2].name, "new.jpg");
  assert.equal(linkAssets(null, assets).length, 0);
});

test("persistence keeps passwords out of storage and parses defensively", () => {
  const storage = memoryStorage();
  const state = seedSharedLinks(NOW);
  assert.ok(saveSharedLinks(state, storage));
  const raw = storage.getItem(SHARED_LINKS_KEY);
  assert.ok(!raw.includes("lakeside"), "password is never persisted");
  assert.ok(raw.includes('"hasPassword":true'));
  const loaded = loadSharedLinks(storage, { now: NOW });
  assert.equal(loaded.links.length, 3);
  assert.equal(loaded.links[1].password, "lakeside", "seed password re-attached in memory");
  assert.equal(loaded.links[1].hasPassword, true);
  assert.deepEqual(
    JSON.parse(serializeSharedLinks(loaded)),
    JSON.parse(raw),
    "round trip is stable",
  );
  assert.equal(loadSharedLinks(null, { now: NOW }).links.length, 3, "missing storage seeds");
  assert.equal(parseSharedLinks("{not json", { now: NOW }).links.length, 3);
  assert.equal(parseSharedLinks({ version: 2, links: [] }, { now: NOW }).links.length, 3);
  assert.equal(parseSharedLinks({ version: 1, links: [] }).links.length, 0, "an empty list is a valid choice");
  const parsed = parseSharedLinks(
    {
      version: 1,
      links: [
        { id: "ok", type: "album", albumId: "family", createdAt: "2026-01-01T00:00:00.000Z", slug: "Family", views: -3, expiresAt: "never", uploads: [{ name: "a.jpg", addedAt: "2026-01-02T00:00:00.000Z" }, { name: "" }] },
        { id: "ok", type: "album", albumId: "family", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "dup-slug", type: "album", albumId: "family", createdAt: "2026-01-01T00:00:00.000Z", slug: "shared" },
        { id: "dup-slug-2", type: "album", albumId: "family", createdAt: "2026-01-01T00:00:00.000Z", slug: "shared" },
        { id: "unknown-album", type: "album", albumId: "ghost", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "items", type: "individual", assetIds: ["2", "nope", "2"], createdAt: "2026-01-01T00:00:00.000Z", hasPassword: true, description: "bad\u0007" },
        { id: "no-items", type: "individual", assetIds: ["nope"], createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "bad id!", type: "album", albumId: "family", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "no-date", type: "album", albumId: "family" },
        "junk",
        null,
      ],
    },
    { albumIds: ["family", "summer-rockies"], assetIds: ["1", "2"], now: NOW },
  );
  assert.deepEqual(
    parsed.links.map((link) => link.id),
    ["ok", "dup-slug", "dup-slug-2", "items"],
  );
  const [ok, first, second, items] = parsed.links;
  assert.equal(ok.slug, null, "invalid slug dropped");
  assert.equal(ok.views, 0);
  assert.equal(ok.expiresAt, null);
  assert.equal(ok.uploads.length, 1);
  assert.deepEqual(ok.uploadedAssetIds, ["up-ok-1"]);
  assert.equal(first.slug, "shared");
  assert.equal(second.slug, null, "duplicate slug dropped");
  assert.deepEqual(items.assetIds, ["2"]);
  assert.equal(items.hasPassword, true);
  assert.equal(items.password, null, "unknown passwords stay unknown");
  assert.equal(items.description, "");
});
