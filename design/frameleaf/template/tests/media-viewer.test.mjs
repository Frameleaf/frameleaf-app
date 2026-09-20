import test from "node:test";
import assert from "node:assert/strict";
import {
  viewerAssets,
  viewerMedia,
  safeMediaSource,
  slideshowOrder,
  slideshowNeighbor,
  fitDimensions,
  clampPan,
  viewerMetadata,
} from "../src/media-viewer.mjs";

test("viewer collection honors explicit access removal and requires opt-in for authorized locked viewing", () => {
  const assets = [
    { id: "normal" },
    { id: "locked", visibility: "locked" },
    { id: "hidden", hidden: true },
    { id: "revoked", canView: false },
    { id: "trash", isTrashed: true },
    { id: "gone", status: "Deleted" },
    { id: "duplicate" },
    { id: "duplicate" },
    { id: "suppressed", accessible: false },
  ];
  assert.deepEqual(
    viewerAssets(assets).map((row) => row.id),
    ["normal"],
  );
  assert.deepEqual(
    viewerAssets(assets, { allowLocked: true }).map((row) => row.id),
    ["normal", "locked"],
  );
  assert.deepEqual(viewerAssets(null), []);
});

test("media source selection never treats a photo or preview as a playable video", () => {
  assert.deepEqual(
    viewerMedia({ type: "video", image: "/preview.png", name: "Trip.mov" }),
    { isVideo: true, image: "/preview.png", video: null },
  );
  assert.equal(
    viewerMedia({
      type: "video",
      image: "/preview.png",
      mediaSrc: "/preview.png?cache=1",
    }).video,
    null,
  );
  assert.equal(
    viewerMedia({ type: "video", image: "/preview.png", mediaSrc: "/trip.mp4" })
      .video,
    "/trip.mp4",
  );
  assert.equal(
    viewerMedia({ type: "photo", src: "/photo.jpg", mediaSrc: "/trip.mp4" })
      .video,
    null,
  );
  assert.equal(
    viewerMedia({
      fullSrc: "/original.jpg",
      src: "/display.jpg",
      image: "/thumb.png",
    }).image,
    "/original.jpg",
  );
  assert.equal(
    viewerMedia({ fullSrc: "javascript:alert(1)", image: "/thumb.png" }).image,
    "/thumb.png",
  );
});

test("unsafe media URL schemes and embedded credentials are rejected", () => {
  for (const source of [
    "javascript:alert(1)",
    "file:///private/photo.jpg",
    "https://user:password@example.com/photo.jpg",
    "//remote.example.com/photo.jpg",
    "\n/media/a.jpg",
    "data:text/html,script",
  ])
    assert.equal(safeMediaSource(source), null, source);
  assert.equal(
    safeMediaSource("https://example.com/api/image?id=123"),
    "https://example.com/api/image?id=123",
  );
  assert.equal(
    safeMediaSource("blob:https://example.com/uuid"),
    "blob:https://example.com/uuid",
  );
  assert.equal(safeMediaSource("/media/photo.jpg"), "/media/photo.jpg");
});

test("shuffle retains the current photo and visits every other photo exactly once", () => {
  const ids = ["a", "b", "c", "d", "a"];
  const shuffled = slideshowOrder(ids, "c", true, () => 0);
  assert.equal(shuffled[0], "c");
  assert.equal(shuffled.length, 4);
  assert.deepEqual([...shuffled].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(ids, ["a", "b", "c", "d", "a"]);
  assert.deepEqual(slideshowOrder(ids, "c"), ["a", "b", "c", "d"]);
});

test("automatic non-repeating slideshow stops at the end and repeat wraps explicitly", () => {
  const ids = ["a", "b", "c"];
  assert.equal(slideshowNeighbor(ids, "c", 1, false), null);
  assert.equal(slideshowNeighbor(ids, "c", 1, true), "a");
  assert.equal(slideshowNeighbor(ids, "a", -1, true), "c");
  assert.equal(slideshowNeighbor(ids, "absent", 1, true), null);
  assert.equal(slideshowNeighbor(["a"], "a", 1, true), null);
});

test("fit preserves aspect ratio without enlarging small originals and pan stays within image bounds", () => {
  const fit = fitDimensions(4000, 3000, 1200, 800);
  assert.equal(fit.height, 800);
  assert.ok(Math.abs(fit.width - 1066.666666) < 0.001);
  assert.deepEqual(fitDimensions(300, 200, 1200, 800), {
    width: 300,
    height: 200,
    scale: 1,
  });
  assert.equal(fitDimensions(0, 3000, 1200, 800), null);
  assert.deepEqual(
    clampPan(
      { x: 9999, y: -9999 },
      { width: 1000, height: 700 },
      { width: 1200, height: 800 },
      2,
    ),
    { x: 400, y: -300 },
  );
  assert.deepEqual(
    clampPan({ x: 4, y: 5 }, fit, { width: 1200, height: 800 }, 1),
    { x: 0, y: 0 },
  );
});

test("information is based on the asset rather than invented camera or dimensions metadata", () => {
  assert.deepEqual(viewerMetadata({ name: "Photo" }), [
    { label: "File", value: "Photo" },
  ]);
  const result = viewerMetadata({
    name: "Photo",
    make: "Sony",
    model: "A7",
    lensModel: "24 mm",
    originalPath: "/photos/trip/photo.jpg",
    iso: 200,
    width: 4000,
    height: 3000,
    city: "Banff",
    country: "Canada",
  });
  assert.equal(result.find((row) => row.label === "Camera").value, "Sony · A7");
  assert.equal(
    result.find((row) => row.label === "Folder").value,
    "/photos/trip",
  );
  assert.equal(
    result.find((row) => row.label === "Location").value,
    "Banff, Canada",
  );
  assert.equal(result.find((row) => row.label === "Exposure").value, "ISO 200");
});

test("sharing affordance follows the same Sensitive and rule privacy classification as the library", async () => {
  const { viewerCanShare } = await import("../src/media-viewer.mjs");
  assert.equal(viewerCanShare({ id: "one" }), true);
  for (const privacy of [
    { isSensitive: true },
    { isSuppressed: true },
    { isNsfw: true },
    { lockedByRule: true },
    { isLocked: true },
    { visibility: "locked" },
    { canShare: false },
  ])
    assert.equal(viewerCanShare({ id: "one", ...privacy }), false);
});
