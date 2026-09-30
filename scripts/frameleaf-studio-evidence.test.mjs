import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFamilyCoverage,
  blockedAxisEntry,
  missingCases,
} from "./frameleaf-studio-evidence.mjs";

const fixture = (id) => ({ id, actions: ["apply"] });
const overlayRow = (id, axisStatus = { status: "not-tested" }) => ({
  id,
  axes: { chromium: axisStatus },
});

test("missingCases lists every required case not in the covered set", () => {
  assert.deepEqual(
    missingCases(
      fixture("blend.normal"),
      "chromium",
      new Set(["normal", "extreme"]),
    ),
    ["animated", "composed", "invalid"],
  );
});

test("missingCases is empty once every required case is covered", () => {
  const all = new Set(["normal", "invalid", "animated", "extreme", "composed"]);
  assert.deepEqual(missingCases(fixture("blend.normal"), "chromium", all), []);
});

test("blockedAxisEntry names the exact missing cases", () => {
  assert.deepEqual(blockedAxisEntry(["invalid"]), {
    status: "blocked",
    reason: "Missing chromium-axis case(s): invalid (FL-112).",
  });
});

test("blockedAxisEntry returns null once nothing is missing", () => {
  assert.equal(blockedAxisEntry([]), null);
});

test("applyFamilyCoverage blocks every row of the family with partial coverage, and only that family", () => {
  const overlay = {
    rows: [
      overlayRow("blend.normal"),
      overlayRow("blend.dissolve"),
      overlayRow("effect.brightness"),
    ],
  };
  const catalog = {
    rows: [
      fixture("blend.normal"),
      fixture("blend.dissolve"),
      fixture("effect.brightness"),
    ],
  };
  const summary = applyFamilyCoverage(
    overlay,
    catalog,
    "blend",
    new Set(["normal", "extreme"]),
  );
  assert.deepEqual(summary, {
    family: "blend",
    rows: 2,
    blocked: 2,
    alreadyPassed: 0,
    fullyCovered: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, {
    status: "blocked",
    reason:
      "Missing chromium-axis case(s): animated, composed, invalid (FL-112).",
  });
  assert.deepEqual(overlay.rows[2].axes.chromium, { status: "not-tested" });
});

test("applyFamilyCoverage counts, but does not touch, a row with full coverage", () => {
  const overlay = { rows: [overlayRow("blend.normal")] };
  const catalog = { rows: [fixture("blend.normal")] };
  const all = new Set(["normal", "invalid", "animated", "extreme", "composed"]);
  const summary = applyFamilyCoverage(overlay, catalog, "blend", all);
  assert.deepEqual(summary, {
    family: "blend",
    rows: 1,
    blocked: 0,
    alreadyPassed: 0,
    fullyCovered: 1,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, { status: "not-tested" });
});

test("applyFamilyCoverage never downgrades an already-passed row", () => {
  const passed = { status: "passed", run: { path: "x", sha256: "y" } };
  const overlay = { rows: [overlayRow("blend.normal", passed)] };
  const catalog = { rows: [fixture("blend.normal")] };
  const summary = applyFamilyCoverage(
    overlay,
    catalog,
    "blend",
    new Set(["normal"]),
  );
  assert.deepEqual(summary, {
    family: "blend",
    rows: 1,
    blocked: 0,
    alreadyPassed: 1,
    fullyCovered: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, passed);
});

test("applyFamilyCoverage is a no-op the second time (same reason already recorded)", () => {
  const overlay = { rows: [overlayRow("blend.normal")] };
  const catalog = { rows: [fixture("blend.normal")] };
  const coverage = new Set(["normal", "extreme"]);
  applyFamilyCoverage(overlay, catalog, "blend", coverage);
  const summary = applyFamilyCoverage(overlay, catalog, "blend", coverage);
  assert.equal(summary.blocked, 0);
});

test("applyFamilyCoverage throws on a row missing from the fixture catalog", () => {
  const overlay = { rows: [overlayRow("blend.ghost")] };
  const catalog = { rows: [] };
  assert.throws(
    () => applyFamilyCoverage(overlay, catalog, "blend", new Set()),
    /no matching row/,
  );
});
