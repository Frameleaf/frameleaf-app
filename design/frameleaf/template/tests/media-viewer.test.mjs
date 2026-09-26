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
  viewerHeadline,
  exposureParts,
  formatFileSize,
  megapixels,
  formatDuration,
  folderOf,
  osmLink,
  validCoordinate,
  splitDateTime,
  joinDateTime,
  formatCaptureDate,
  timezoneOffsetLabel,
  timezoneOptions,
  ageAtCapture,
  personChipLabel,
  peopleChips,
  stackMembers,
  stackNeighbor,
  ownerLine,
  sensitivityReview,
  descriptionReview,
  ocrRegions,
  ratingValue,
  albumsForAsset,
  parseViewerPreferences,
  VIEWER_DEFAULTS,
  normalizeAvailableActions,
  viewerActionGroups,
  VIEWER_ACTIONS,
  videoSources,
  livePhotoSource,
  panoramaLayout,
  clampPanorama,
  panoramaWindow,
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
  assert.deepEqual(
    viewerAssets(
      [
        ...assets,
        { id: "binned", visibility: "trash" },
        { id: "wasTrashed", status: "Trashed" },
      ],
      { allowTrashed: true },
    ).map((row) => row.id),
    ["normal", "trash", "binned", "wasTrashed"],
    "a trash-screen viewer opts into trashed rows but still never shows deleted ones",
  );
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

test("encoded and live photo sources fall back safely and reject non-video sources", () => {
  assert.deepEqual(videoSources({ type: "video", mediaSrc: "/trip.mp4" }), {
    original: "/trip.mp4",
    encoded: "/trip.mp4",
    hasEncoded: false,
  });
  assert.deepEqual(
    videoSources({
      type: "video",
      mediaSrc: "/trip.mov",
      encodedVideoSrc: "/trip-encoded.mp4",
    }),
    { original: "/trip.mov", encoded: "/trip-encoded.mp4", hasEncoded: true },
  );
  assert.equal(
    videoSources({ type: "photo", mediaSrc: "/x.mp4" }).original,
    null,
  );
  assert.equal(
    livePhotoSource({ isLivePhoto: true, livePhotoVideo: "/live.mp4" }),
    "/live.mp4",
  );
  assert.equal(livePhotoSource({ livePhotoVideo: "/live.mp4" }), null);
  assert.equal(
    livePhotoSource({ isLivePhoto: true, livePhotoVideo: "javascript:x" }),
    null,
  );
  assert.equal(
    livePhotoSource({ isLivePhoto: true, livePhotoVideo: "/still.png" }),
    null,
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

test("slideshow order supports ascending, descending and shuffle by name", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(slideshowOrder(ids, "b", "ascending"), ["a", "b", "c"]);
  assert.deepEqual(slideshowOrder(ids, "b", "descending"), ["c", "b", "a"]);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(slideshowOrder(ids, "b", "shuffle", () => 0)[0], "b");
  assert.deepEqual(slideshowOrder(ids, "b", "unknown"), ["a", "b", "c"]);
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

test("panorama strip fills the stage height and its offset and mini-map window stay in range", () => {
  const layout = panoramaLayout(
    { width: 12000, height: 3000 },
    { width: 1000, height: 500 },
  );
  assert.deepEqual(layout, { width: 2000, height: 500, maxOffset: 1000 });
  assert.equal(clampPanorama(-40, layout), 0);
  assert.equal(clampPanorama(5000, layout), 1000);
  assert.equal(clampPanorama(NaN, layout), 0);
  assert.deepEqual(panoramaWindow(500, layout, { width: 1000 }), {
    left: 0.25,
    width: 0.5,
  });
  assert.deepEqual(panoramaWindow(0, null, { width: 1000 }), {
    left: 0,
    width: 1,
  });
  assert.equal(
    panoramaLayout({ width: 0, height: 1 }, { width: 1, height: 1 }),
    null,
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

test("headline lists camera, lens, exposure, size and file size only from present fields", () => {
  assert.deepEqual(viewerHeadline(null), []);
  assert.deepEqual(viewerHeadline({ name: "Photo" }), []);
  assert.deepEqual(
    viewerHeadline({
      make: "Sony",
      model: "α7 IV",
      lensModel: "FE 24–70mm",
      fNumber: 2.8,
      exposureTime: "1/500",
      iso: 100,
      focalLength: 35,
      width: 6000,
      height: 4000,
      fileSizeInBytes: 8_400_000,
    }),
    [
      "Sony α7 IV",
      "FE 24–70mm",
      "ƒ/2.8",
      "1/500 s",
      "ISO 100",
      "35 mm",
      "6,000 × 4,000",
      "8.4 MB",
    ],
  );
  assert.deepEqual(
    viewerHeadline({
      type: "video",
      make: "Apple",
      model: "iPhone",
      width: 3840,
      height: 2160,
      frameRate: 29.97,
      duration: 84,
      fileSizeInBytes: 1_250_000_000,
    }),
    ["Apple iPhone", "3,840 × 2,160", "29.97 fps", "1:24", "1.25 GB"],
  );
  assert.deepEqual(exposureParts({ exposureTime: 0.004, fNumber: 4 }), [
    "ƒ/4",
    "1/250 s",
  ]);
  assert.deepEqual(exposureParts({ exposureTime: 2 }), ["2 s"]);
});

test("size, megapixel, duration and folder formatting handle edge values", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(48_300_000), "48.3 MB");
  assert.equal(formatFileSize(2_000), "2 KB");
  assert.equal(formatFileSize(-1), null);
  assert.equal(formatFileSize("big"), null);
  assert.equal(megapixels(6000, 4000), "24 MP");
  assert.equal(megapixels(4032, 3024), "12 MP");
  assert.equal(megapixels(1920, 1080), "2.1 MP");
  assert.equal(megapixels(0, 10), null);
  assert.equal(formatDuration(24), "0:24");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(-3), null);
  assert.equal(
    folderOf("/photos/2026/Rockies/Lake.jpg"),
    "/photos/2026/Rockies",
  );
  assert.equal(folderOf("/Lake.jpg"), "/");
  assert.equal(folderOf("Lake.jpg"), null);
});

test("OpenStreetMap links only form from valid WGS84 coordinates", () => {
  assert.equal(
    osmLink(51.1784, -115.5708),
    "https://www.openstreetmap.org/?mlat=51.1784&mlon=-115.5708#map=14/51.1784/-115.5708",
  );
  assert.equal(osmLink(91, 0), null);
  assert.equal(osmLink("51.1", "-115.5"), osmLink(51.1, -115.5));
  assert.equal(osmLink("", ""), null);
  assert.equal(validCoordinate(" 12.5 ", 90), 12.5);
  assert.equal(validCoordinate("abc", 90), null);
  assert.equal(validCoordinate(-181, 180), null);
});

test("capture date splits, joins and formats as wall-clock time without timezone drift", () => {
  assert.deepEqual(splitDateTime("2026-08-16T07:14:00"), {
    date: "2026-08-16",
    time: "07:14",
  });
  assert.deepEqual(splitDateTime("2026-08-16"), {
    date: "2026-08-16",
    time: "00:00",
  });
  assert.deepEqual(splitDateTime("nope"), { date: "", time: "" });
  assert.equal(joinDateTime("2026-08-16", "07:14"), "2026-08-16T07:14:00");
  assert.equal(joinDateTime("2026-08-16", "7:14"), null);
  const formatted = formatCaptureDate("2026-08-16T07:14:00", "en-CA");
  assert.match(formatted.date, /2026/);
  assert.match(formatted.date, /Aug/);
  assert.match(formatted.time, /7:14/);
  assert.deepEqual(formatCaptureDate("bad"), { date: null, time: null });
  assert.equal(timezoneOffsetLabel("UTC"), "UTC+00:00");
  assert.match(timezoneOffsetLabel("Asia/Kolkata"), /^UTC\+05:30$/);
  assert.equal(timezoneOffsetLabel("Not/AZone"), null);
  const options = timezoneOptions(
    "Europe/Kyiv",
    new Date("2026-08-16T12:00:00Z"),
  );
  assert.equal(options[0].value, "Europe/Kyiv");
  assert.ok(
    options.every((option) => /^UTC[+-]\d{2}:\d{2} · /.test(option.label)),
  );
  assert.equal(
    new Set(options.map((option) => option.value)).size,
    options.length,
  );
});

test("age at capture counts completed years and stays empty before birth or without data", () => {
  assert.equal(ageAtCapture("2012-08-20", "2026-08-16T07:14:00"), 13);
  assert.equal(ageAtCapture("2012-08-16", "2026-08-16T07:14:00"), 14);
  assert.equal(ageAtCapture("2030-01-01", "2026-08-16"), null);
  assert.equal(ageAtCapture("", "2026-08-16"), null);
  assert.equal(ageAtCapture("2012-01-01", null), null);
  assert.equal(
    personChipLabel({ name: "Emma", birthday: "2012-03-02" }, "2026-08-16"),
    "Emma · 14",
  );
  assert.equal(personChipLabel({ name: "Emma" }, "2026-08-16"), "Emma");
  assert.equal(personChipLabel({}, "2026-08-16"), "Unnamed person");
});

test("people chips merge faces with assigned people, hide hidden people until asked and keep unnamed faces", () => {
  const people = [
    { id: "p1", name: "Emma" },
    { id: "p2", name: "Jamie", hidden: true },
    {
      id: "p3",
      name: "Taylor",
      faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    },
  ];
  const faces = [
    {
      id: "f1",
      personId: "p1",
      box: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
    },
    {
      id: "f2",
      personId: null,
      box: { x: 0.5, y: 0.2, width: 0.1, height: 0.1 },
    },
    { id: "f3", personId: "p2", box: { x: 0, y: 0, width: 0, height: 0.1 } },
  ];
  const result = peopleChips({
    faces,
    people,
    personIds: ["p1", "Taylor", "Ghost"],
  });
  assert.deepEqual(
    result.chips.map((chip) => [chip.key, chip.name, chip.faceId, !!chip.box]),
    [
      ["face:f1", "Emma", "f1", true],
      ["face:f2", "Unnamed person", "f2", true],
      ["person:p3", "Taylor", null, true],
      ["person:Ghost", "Ghost", null, false],
    ],
  );
  assert.equal(result.hiddenCount, 1);
  const shown = peopleChips({ faces, people, personIds: [], showHidden: true });
  assert.equal(shown.chips.length, 3);
  assert.equal(shown.chips[2].box, null);
  assert.deepEqual(peopleChips(), { chips: [], hiddenCount: 0 });
});

test("stack members put the primary first and step without wrapping", () => {
  const assets = [
    { id: "b", stackId: "s", takenAt: "2026-08-16T08:00:00" },
    { id: "c", stackId: "other" },
    { id: "a", stackId: "s", takenAt: "2026-08-16T07:00:00" },
    {
      id: "p",
      stackId: "s",
      stackPrimary: true,
      takenAt: "2026-08-16T09:00:00",
    },
  ];
  const members = stackMembers(assets, { id: "a", stackId: "s" });
  assert.deepEqual(
    members.map((item) => item.id),
    ["p", "a", "b"],
  );
  assert.equal(stackNeighbor(members, "p", 1), "a");
  assert.equal(stackNeighbor(members, "p", -1), null);
  assert.equal(stackNeighbor(members, "b", 1), null);
  assert.equal(stackNeighbor(members, "zzz", 1), null);
  assert.deepEqual(stackMembers(assets, { id: "c" }), []);
});

test("owner and sharing lines only appear for other people's or shared items", () => {
  assert.equal(ownerLine({ ownerId: "taylor" }), null);
  assert.equal(ownerLine({ ownerId: "jamie" }), "Owned by Jamie");
  assert.equal(
    ownerLine({ ownerId: "u2" }, "taylor", [{ id: "u2", name: "Emma R." }]),
    "Owned by Emma R.",
  );
  assert.equal(
    ownerLine({ ownerId: "taylor", sharedBy: "jamie" }),
    "Shared by Jamie",
  );
  assert.equal(
    ownerLine({ ownerId: "taylor", sharedBy: { id: "x", name: "Sam" } }),
    "Shared by Sam",
  );
  assert.equal(ownerLine(null), null);
});

test("enrichment cards report generated versus manual descriptions and reviewed, pending or overridden sensitivity", () => {
  assert.deepEqual(
    descriptionReview({
      enrichment: {
        description: { status: "generated", model: "Local", confidence: 0.874 },
      },
    }),
    { status: "Generated", generated: true, model: "Local", confidence: 87 },
  );
  assert.equal(
    descriptionReview({ enrichment: { description: { status: "manual" } } })
      .status,
    "Manual",
  );
  assert.equal(descriptionReview({}), null);
  assert.deepEqual(
    sensitivityReview({
      enrichment: { sensitive: { status: "reviewed", score: 0.02 } },
    }),
    { score: 0.02, status: "Reviewed", marked: false },
  );
  assert.equal(
    sensitivityReview({
      enrichment: { sensitive: { status: "needs-review", score: 0.61 } },
    }).status,
    "Needs review",
  );
  assert.equal(
    sensitivityReview({
      isSensitive: true,
      enrichment: { sensitive: { status: "reviewed", score: 0.02 } },
    }).status,
    "Overridden",
  );
  assert.equal(
    sensitivityReview({
      isSensitive: false,
      enrichment: { sensitive: { status: "reviewed", score: 0.9 } },
    }).status,
    "Overridden",
  );
  assert.equal(sensitivityReview({}), null);
});

test("sample OCR regions are deterministic, one per line and inside the image", () => {
  const regions = ocrRegions("LAKE AGNES 3.4 km\n\nTRAILHEAD  ");
  assert.equal(regions.length, 2);
  assert.deepEqual(regions, ocrRegions("LAKE AGNES 3.4 km\n\nTRAILHEAD  "));
  assert.deepEqual(
    regions.map((region) => region.text),
    ["LAKE AGNES 3.4 km", "TRAILHEAD"],
  );
  for (const region of regions) {
    assert.ok(region.x >= 0 && region.x + region.width <= 1);
    assert.ok(region.y >= 0 && region.y + region.height <= 1);
  }
  assert.deepEqual(ocrRegions(""), []);
  assert.equal(
    ocrRegions(Array.from({ length: 30 }, () => "x").join("\n")).length,
    12,
  );
});

test("ratings clamp to whole stars and album membership follows albumIds", () => {
  assert.equal(ratingValue(4), 4);
  assert.equal(ratingValue("3"), 3);
  assert.equal(ratingValue(7), 0);
  assert.equal(ratingValue(2.5), 0);
  assert.equal(ratingValue(undefined), 0);
  const albums = [
    { id: "family", name: "Family" },
    { id: "trips", name: "Trips" },
  ];
  assert.deepEqual(
    albumsForAsset(albums, { albumIds: ["trips", "missing"] }).map((a) => a.id),
    ["trips"],
  );
  assert.deepEqual(albumsForAsset(albums, {}), []);
  assert.deepEqual(albumsForAsset(null, { albumIds: ["trips"] }), []);
});

test("viewer preferences parse defensively and never trust stored shapes", () => {
  assert.deepEqual(parseViewerPreferences(null), VIEWER_DEFAULTS);
  assert.deepEqual(parseViewerPreferences("{bad json"), VIEWER_DEFAULTS);
  assert.deepEqual(parseViewerPreferences("[1,2]"), VIEWER_DEFAULTS);
  assert.deepEqual(
    parseViewerPreferences(
      JSON.stringify({
        interval: 10,
        look: "blur",
        caption: "details",
        order: "descending",
        repeat: true,
        transition: "slide",
        progress: false,
        filmstrip: true,
      }),
    ),
    {
      interval: 10,
      look: "blur",
      caption: "details",
      order: "descending",
      repeat: true,
      transition: "slide",
      progress: false,
      filmstrip: true,
    },
  );
  assert.deepEqual(
    parseViewerPreferences({
      interval: "10",
      look: "stretch",
      caption: 3,
      order: "random",
      repeat: "yes",
      transition: null,
      progress: "no",
      filmstrip: 1,
    }),
    VIEWER_DEFAULTS,
  );
});

test("available actions accept the legacy stack alias and drop unknown ids", () => {
  assert.deepEqual(
    normalizeAvailableActions(["download", "stack", "bogus", "download"]),
    ["download", "add-to-stack"],
  );
  assert.deepEqual(normalizeAvailableActions(undefined), [...VIEWER_ACTIONS]);
});

test("more-menu groups follow trash, stack, album, sensitivity and media type context", () => {
  const photo = {
    id: "1",
    type: "photo",
    albumIds: ["family"],
    city: "Banff",
    originalPath: "/photos/a.jpg",
    stackId: "s",
  };
  const groups = viewerActionGroups(photo, {
    albumId: "family",
    peopleCount: 2,
  });
  const ids = groups.flatMap((group) => group.items.map((item) => item.id));
  assert.ok(ids.includes("remove-from-album"));
  assert.deepEqual(
    groups
      .find((group) => group.id === "organize")
      .items.find((item) => item.id === "remove-from-album").payload,
    { albumId: "family" },
  );
  assert.ok(
    ids.includes("unstack") &&
      ids.includes("stack-keep-this") &&
      ids.includes("stack-set-primary"),
  );
  assert.ok(!ids.includes("add-to-stack"));
  assert.ok(
    ids.includes("set-album-cover") && ids.includes("set-person-featured"),
  );
  assert.ok(ids.includes("copy-image") && ids.includes("refresh-faces"));
  assert.ok(!ids.includes("refresh-encoded") && !ids.includes("transcode"));
  assert.ok(
    ids.includes("lock") &&
      ids.includes("archive") &&
      ids.includes("open-folder"),
  );

  const primary = viewerActionGroups(
    { ...photo, stackPrimary: true, albumIds: [] },
    {},
  );
  const primaryIds = primary.flatMap((group) =>
    group.items.map((item) => item.id),
  );
  assert.ok(
    !primaryIds.includes("stack-set-primary") &&
      !primaryIds.includes("set-album-cover"),
  );

  const video = viewerActionGroups(
    { id: "2", type: "video", visibility: "archive", isSensitive: true },
    {
      available: [
        "unarchive",
        "unlock",
        "transcode",
        "refresh-encoded",
        "copy-image",
        "refresh-faces",
      ],
    },
  );
  const videoIds = video.flatMap((group) => group.items.map((item) => item.id));
  assert.deepEqual(
    videoIds,
    ["unlock", "transcode", "refresh-encoded"].sort(
      (a, b) => videoIds.indexOf(a) - videoIds.indexOf(b),
    ),
  );
  assert.ok(
    !videoIds.includes("unarchive"),
    "sensitive items cannot be archived from the viewer",
  );

  const trash = viewerActionGroups(photo, { trash: true });
  const trashIds = trash.flatMap((group) => group.items.map((item) => item.id));
  assert.ok(
    trashIds.includes("restore") && trashIds.includes("delete-permanently"),
  );
  assert.ok(
    !trashIds.includes("archive") &&
      !trashIds.includes("add-to-stack") &&
      !trashIds.includes("refresh-metadata"),
  );

  const readOnly = viewerActionGroups(photo, { readOnly: true, trash: true });
  assert.deepEqual(
    readOnly.flatMap((group) => group.items.map((item) => item.id)),
    ["download", "copy-image"],
  );
  assert.deepEqual(viewerActionGroups(null), []);
  assert.ok(
    !viewerActionGroups({ id: "3", canDownload: false, type: "video" }, {})
      .flatMap((group) => group.items.map((item) => item.id))
      .includes("download"),
  );
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

test("slideshow transitions keep fade as the default and respect reduced motion", async () => {
  const {
    effectiveTransition,
    kenBurnsMove,
    SLIDESHOW_TRANSITIONS,
    parseViewerPreferences,
    VIEWER_DEFAULTS,
  } = await import("../src/media-viewer.mjs");
  assert.equal(VIEWER_DEFAULTS.transition, "fade");
  assert.deepEqual(
    SLIDESHOW_TRANSITIONS.map(([id]) => id),
    ["none", "fade", "slide", "ken-burns", "memories"],
  );
  assert.equal(
    parseViewerPreferences({ transition: "memories" }).transition,
    "memories",
  );
  assert.equal(
    parseViewerPreferences({ transition: "bogus" }).transition,
    "fade",
  );
  assert.equal(effectiveTransition("unknown"), "fade");
  assert.equal(effectiveTransition("ken-burns"), "ken-burns");
  assert.equal(effectiveTransition("memories", true), "fade");
  assert.equal(effectiveTransition("none", true), "none");
  assert.deepEqual(kenBurnsMove("7"), kenBurnsMove("7"));
  assert.ok(kenBurnsMove("x").from && kenBurnsMove("x").to);
});
