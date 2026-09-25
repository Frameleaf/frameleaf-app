import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPreset,
  changeDraft,
  createSimulatedJob,
  initialEdit,
  normalizeDraft,
  normalizeEdit,
  parseSavedPrototype,
  travelDraft,
  restoredViewContext,
} from "../src/state.mjs";

const assets = [
  { id: "1", name: "Lake.mov", duration: 24 },
  { id: "2", name: "Forest.mov", duration: 15 },
];
const view = {
  version: 1,
  scope: { kind: "album", id: "album" },
  query: { version: 1, text: "", filter: {} },
  sort: "rating",
  view: "grid",
};
const readView = (value) =>
  value?.version === 1 &&
  value?.scope?.kind &&
  value?.query?.filter &&
  !Array.isArray(value.query.filter)
    ? structuredClone(value)
    : null;
const read = (value) =>
  parseSavedPrototype(JSON.stringify(value), assets, readView);

test("corrupted JSON/root/container shapes recover without crashing or rendering arbitrary values", () => {
  for (const value of [
    null,
    [],
    1,
    "invalid",
    {
      drafts: [],
      presets: {},
      versions: true,
      ratings: ["bad"],
      selection: {},
      snapshotIds: "bad",
    },
  ]) {
    const saved = read(value);
    assert.equal(saved.openAssetId, "1");
    assert.equal(saved.drafts["2"].edit.end, 15);
    assert.deepEqual(saved.presets, []);
    assert.deepEqual(saved.versions, []);
  }
  assert.equal(
    parseSavedPrototype("{broken", assets, readView).drafts["1"].edit.end,
    24,
  );
});

test("source duration bounds apply to recovered active draft, playhead, history and versions", () => {
  const saved = read({
    openAssetId: "2",
    playbackPosition: 24,
    drafts: {
      2: {
        edit: { start: 21, end: 99, exposure: "bad" },
        undo: [{ start: -3, end: 24 }],
        redo: [{ end: 99 }],
      },
    },
    versions: [
      { id: 1, name: "Old version", assetId: "2", edit: { start: 1, end: 24 } },
    ],
  });
  assert.equal(saved.playbackPosition, 15);
  for (const edit of [
    saved.drafts["2"].edit,
    ...saved.drafts["2"].undo,
    ...saved.drafts["2"].redo,
    saved.versions[0].edit,
  ]) {
    assert.ok(edit.start >= 0);
    assert.ok(edit.end <= 15);
    assert.ok(edit.end > edit.start);
    assert.equal(typeof edit.exposure, "number");
  }
  assert.equal(normalizeEdit(initialEdit, assets[1]).end, 15);
});

test("per-asset caption/title/comment/restoration settings and undo/redo survive serialization", () => {
  let draft = normalizeDraft({}, assets[1]);
  draft = changeDraft(
    draft,
    {
      title: "Forest",
      caption: "Wind in the trees",
      captionLanguage: "English",
      comment: "Keep this",
      commentTime: 12,
      restorationMode: "Creative",
    },
    assets[1],
  );
  draft = changeDraft(draft, { caption: "New caption" }, assets[1]);
  const saved = read({ openAssetId: "2", drafts: { 2: draft } });
  const undone = travelDraft(saved.drafts["2"], "undo", assets[1]);
  assert.equal(undone.edit.caption, "Wind in the trees");
  assert.equal(undone.edit.title, "Forest");
  assert.equal(undone.edit.commentTime, 12);
  assert.equal(undone.edit.restorationMode, "Creative");
  assert.equal(saved.drafts["1"].edit.caption, "");
  const reopened = read({ drafts: { 2: undone } });
  assert.equal(
    travelDraft(reopened.drafts["2"], "redo", assets[1]).edit.caption,
    "New caption",
  );
});

test("loading another version is undoable and clamps that version to the active asset", () => {
  const previous = changeDraft(
    normalizeDraft({}, assets[1]),
    { rotation: 90, caption: "Current draft" },
    assets[1],
  );
  const loaded = changeDraft(
    previous,
    normalizeEdit({ end: 24, rotation: 180 }, assets[1]),
    assets[1],
  );
  assert.equal(loaded.edit.end, 15);
  assert.equal(
    travelDraft(loaded, "undo", assets[1]).edit.caption,
    "Current draft",
  );
  assert.equal(travelDraft(loaded, "undo", assets[1]).edit.rotation, 90);
});

test("filter presets preserve collection membership, query text, sort, view and scope", () => {
  const context = {
    collection: "Two-item snapshot",
    snapshotIds: ["1", "2"],
    state: { ...view, query: { ...view.query, text: "Forest" } },
  };
  const preset = {
    name: "Five stars",
    kind: "Filter preset",
    state: {
      ...view,
      scope: { kind: "space", id: "another-space" },
      query: {
        ...view.query,
        text: "old search",
        filter: { rating: { eq: 5 } },
      },
    },
  };
  const next = applyPreset(context, preset);
  assert.equal(next.collection, context.collection);
  assert.deepEqual(next.snapshotIds, ["1", "2"]);
  assert.deepEqual(next.state.scope, context.state.scope);
  assert.equal(next.state.query.text, "Forest");
  assert.equal(next.state.sort, "rating");
  assert.equal(next.state.query.filter.rating.eq, 5);
  preset.state.query.filter.rating.eq = 1;
  assert.equal(next.state.query.filter.rating.eq, 5);
});

test("empty snapshots stay empty after save/reload and filter preset application", () => {
  const saved = read({
    snapshotIds: [],
    presets: [
      { id: 1, kind: "Album snapshot", name: "Empty", ids: [], state: view },
    ],
  });
  assert.deepEqual(saved.snapshotIds, []);
  assert.deepEqual(saved.presets[0].ids, []);
  assert.deepEqual(
    applyPreset(
      { collection: "Empty", snapshotIds: [], state: view },
      { kind: "Filter preset", state: view },
    ).snapshotIds,
    [],
  );
});

test("malformed presets are rejected through the supplied shared-view parser", () => {
  const saved = read({
    presets: [
      null,
      { id: 1, kind: "Smart album", name: "Bad", state: null },
      { id: 2, kind: "Album snapshot", name: "Missing IDs", state: view },
    ],
  });
  assert.deepEqual(saved.presets, []);
});

test("queued simulation freezes source/recipe/mode/export options and destination across later edits", () => {
  const edit = normalizeEdit(
    {
      title: "First title",
      restorationMode: "Creative",
      exportFormat: "WebM · AV1",
      exportColor: "HDR10",
    },
    assets[1],
  );
  const job = createSimulatedJob("AI restoration", assets[1], edit, "cloud");
  edit.title = "Changed later";
  edit.restorationMode = "Faithful";
  assert.equal(job.snapshot.edit.title, "First title");
  assert.equal(job.snapshot.edit.restorationMode, "Creative");
  assert.equal(job.destination, "cloud");
  const restored = read({ jobs: [job] }).jobs[0];
  assert.equal(restored.snapshot.assetId, "2");
  assert.equal(restored.snapshot.edit.exportFormat, "WebM · AV1");
  assert.equal(restored.snapshot.edit.exportColor, "HDR10");
  assert.equal(restored.simulated, true);
});

test("a saved legacy runpod destination recovers as Frameleaf Cloud", () => {
  const job = { ...createSimulatedJob("Export", assets[0], initialEdit, "runpod") };
  const saved = read({ destination: "runpod", jobs: [job] });
  assert.equal(saved.destination, "cloud");
  assert.equal(saved.jobs[0].destination, "cloud");
  assert.equal(read({ destination: "cloud" }).destination, "cloud");
  assert.equal(read({ destination: "elsewhere" }).destination, "local");
});

test("cloud job cost facts survive recovery and hostile values are bounded", () => {
  const job = {
    ...createSimulatedJob("AI restoration", assets[0], initialEdit, "cloud"),
    status: "completed",
    settings: { destination: "runpod", mode: "Faithful" },
    cloud: {
      modelId: "realbasicvsr@1",
      modelName: "RealBasicVSR",
      quantity: 4,
      quantityLabel: "4 min",
      p50: 1.9044,
      p90: 1.9564,
      hold: 1.96,
      gpuClass: "gpu48pro",
      gpuClassLabel: "48 GB GPU (L40S class)",
      rate: 0.00130035,
      startFee: 0.1,
      workers: 5,
      workSeconds: 1080,
      disclosureVersion: "2026-09",
      consentedAt: "2026-09-25T08:00:00.000Z",
      settled: true,
      chargedUsd: 1.09,
    },
  };
  const restored = read({ jobs: [job] }).jobs[0];
  assert.deepEqual(restored.cloud, job.cloud);
  assert.equal(restored.settings.destination, "cloud");
  const hostile = read({ jobs: [{ ...job, cloud: { p50: -4, hold: "lots", settled: "yes", chargedUsd: "1" } }] }).jobs[0];
  assert.equal(hostile.cloud.p50, 0);
  assert.equal(hostile.cloud.settled, false);
  assert.equal(hostile.cloud.chargedUsd, null);
});

test("asset notes remain separate from pixel recipe reverts and from other assets", () => {
  const saved = read({ openAssetId: "2", note: "Legacy forest note" });
  assert.equal(saved.notes["2"], "Legacy forest note");
  assert.equal(saved.notes["1"], "");
  assert.equal(normalizeEdit(initialEdit, assets[1]).note, undefined);
});

test("rail preference and search history preserve search modes and criteria across recovery", () => {
  const query = {
    version: 1,
    text: "LAKE AGNES",
    mode: "text",
    filter: { city: { eq: "Lake Louise" } },
  };
  const result = read({
    railCollapsed: true,
    searchBy: "ocr",
    recentSearches: [
      { text: "LAKE AGNES", mode: "ocr", query },
      "legacy query",
      null,
      { text: "", mode: "filename" },
    ],
  });
  assert.equal(result.railCollapsed, true);
  assert.equal(result.searchBy, "ocr");
  assert.deepEqual(result.recentSearches, [
    { text: "LAKE AGNES", mode: "ocr", query },
    { text: "legacy query", mode: "semantic" },
  ]);
  assert.equal(
    read({ railCollapsed: "true", searchBy: "unknown" }).railCollapsed,
    false,
  );
  assert.equal(read({ searchBy: "unknown" }).searchBy, "semantic");
});

test("library layout defaults to Browse and only accepts known layouts", () => {
  assert.equal(read({}).layout, "browse");
  assert.equal(read({ layout: "sideways" }).layout, "browse");
  assert.equal(read({ layout: "work" }).layout, "work");
  assert.equal(read({ layout: "timeline" }).layout, "timeline");
});

test("photos have no timeline while videos keep their real duration", () => {
  const photo = { id: "p", name: "Photo.jpg", type: "photo", duration: 0 };
  const clip = { id: "v", name: "Clip.mov", type: "video" };
  assert.equal(normalizeEdit(initialEdit, photo).end, 0);
  assert.equal(normalizeEdit({ start: 5, end: 9 }, photo).start, 0);
  assert.equal(normalizeEdit(initialEdit, clip).end, 24);
  assert.equal(normalizeEdit(initialEdit, assets[1]).end, 15);
  const saved = parseSavedPrototype(
    JSON.stringify({ openAssetId: "p", playbackPosition: 12 }),
    [photo, assets[0]],
    readView,
  );
  assert.equal(saved.playbackPosition, 0);
});

test("authoritative search URLs cannot inherit unrelated snapshot membership or names", () => {
  const saved = { view, collection: "Saved selection", snapshotIds: ["1"] };
  assert.deepEqual(
    restoredViewContext(saved, structuredClone(view)).snapshotIds,
    ["1"],
  );
  const incoming = {
    ...view,
    scope: { kind: "library" },
    query: { ...view.query, text: "forest" },
  };
  const restored = restoredViewContext(saved, incoming);
  assert.equal(restored.collection, "Library");
  assert.equal(restored.snapshotIds, null);
  assert.deepEqual(restored.view, incoming);
  assert.deepEqual(restoredViewContext(saved, null), {
    view,
    snapshotIds: ["1"],
    collection: "Saved selection",
  });
});

test("a job keeps when its current stage began across a reload", () => {
  const job = { ...createSimulatedJob("Export", assets[0], initialEdit, "local"), status: "preparing", stageStartedAt: 1790000000000 };
  assert.equal(read({ jobs: [job] }).jobs[0].stageStartedAt, 1790000000000);
  assert.equal("stageStartedAt" in read({ jobs: [{ ...job, stageStartedAt: "soon" }] }).jobs[0], false);
});
