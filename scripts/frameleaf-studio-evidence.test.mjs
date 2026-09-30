import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyFamilyCoverage,
  blockedAxisEntry,
  buildPassedEntry,
  missingCases,
} from "./frameleaf-studio-evidence.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = (id) => ({ id, actions: ["apply"] });
const overlayRow = (id, axes = {}) => ({
  id,
  axes: {
    chromium: { status: "not-tested" },
    safari: { status: "not-tested" },
    ...axes,
  },
});
const feature = (id, category = "Blend mode") => ({
  id,
  category,
  source: [{ path: "vendor/freecut/src/types/blend-modes.ts" }],
});
const manifest = () => ({ features: [], familySourceInventory: {} });
const build = () => ({
  sourceSha256: "s".repeat(64),
  patches: [{ path: "patches/0001.patch" }],
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

test("blockedAxisEntry names the axis and the exact missing cases", () => {
  assert.deepEqual(blockedAxisEntry("safari", ["invalid"]), {
    status: "blocked",
    reason: "Missing safari-axis case(s): invalid (FL-112).",
  });
});

test("blockedAxisEntry returns null once nothing is missing", () => {
  assert.equal(blockedAxisEntry("chromium", []), null);
});

test("applyFamilyCoverage blocks every row of the family with partial coverage, and only that family", async () => {
  const overlay = {
    engineRevision: "e",
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
  const summary = await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "blend",
    "chromium",
    new Set(["normal", "extreme"]),
  );
  assert.deepEqual(summary, {
    family: "blend",
    axis: "chromium",
    rows: 2,
    blocked: 2,
    alreadyPassed: 0,
    fullyCovered: 0,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, {
    status: "blocked",
    reason:
      "Missing chromium-axis case(s): animated, composed, invalid (FL-112).",
  });
  assert.deepEqual(overlay.rows[2].axes.chromium, { status: "not-tested" });
});

test("applyFamilyCoverage never touches a different axis on the same row", async () => {
  const passedSafari = { status: "passed", run: { path: "x", sha256: "y" } };
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("blend.normal", { safari: passedSafari })],
  };
  const catalog = { rows: [fixture("blend.normal")] };
  await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "blend",
    "chromium",
    new Set(["normal", "extreme"]),
  );
  assert.deepEqual(overlay.rows[0].axes.safari, passedSafari);
  assert.equal(overlay.rows[0].axes.chromium.status, "blocked");
});

test("applyFamilyCoverage counts, but does not touch, a fully-covered row when no meta is given", async () => {
  const overlay = { engineRevision: "e", rows: [overlayRow("blend.normal")] };
  const catalog = { rows: [fixture("blend.normal")] };
  const all = new Set(["normal", "invalid", "animated", "extreme", "composed"]);
  const summary = await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "blend",
    "chromium",
    all,
  );
  assert.deepEqual(summary, {
    family: "blend",
    axis: "chromium",
    rows: 1,
    blocked: 0,
    alreadyPassed: 0,
    fullyCovered: 1,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, { status: "not-tested" });
});

test("applyFamilyCoverage never downgrades an already-passed row", async () => {
  const passed = { status: "passed", run: { path: "x", sha256: "y" } };
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("blend.normal", { chromium: passed })],
  };
  const catalog = { rows: [fixture("blend.normal")] };
  const summary = await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "blend",
    "chromium",
    new Set(["normal"]),
  );
  assert.deepEqual(summary, {
    family: "blend",
    axis: "chromium",
    rows: 1,
    blocked: 0,
    alreadyPassed: 1,
    fullyCovered: 0,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, passed);
});

test("applyFamilyCoverage throws on a row missing from the fixture catalog", async () => {
  const overlay = { engineRevision: "e", rows: [overlayRow("blend.ghost")] };
  const catalog = { rows: [] };
  await assert.rejects(
    () =>
      applyFamilyCoverage(
        overlay,
        catalog,
        manifest(),
        build(),
        "blend",
        "chromium",
        new Set(),
      ),
    /no matching row/,
  );
});

test("buildPassedEntry throws naming the missing meta field", async () => {
  await assert.rejects(
    () =>
      buildPassedEntry({
        row: { id: "blend.normal" },
        feature: feature("blend.normal"),
        fixture: fixture("blend.normal"),
        axis: "safari",
        engineRevision: "e",
        build: build(),
        manifest: manifest(),
        meta: {},
        artifactPath: "x",
      }),
    /meta\.version is required/,
  );
});

test("applyFamilyCoverage writes a real schema-shaped artifact and marks the row passed, given meta and full coverage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "studio-evidence-"));
  try {
    const reportPath = path.join(dir, "safari-report.json");
    await writeFile(reportPath, JSON.stringify({ ok: true }));
    const artifactDirAbs = path.join(dir, "artifacts");
    await mkdir(artifactDirAbs, { recursive: true });
    const overlay = { engineRevision: "e", rows: [overlayRow("blend.normal")] };
    const catalog = { rows: [fixture("blend.normal")] };
    const manifestObject = {
      features: [feature("blend.normal")],
      familySourceInventory: {},
    };
    const all = new Set([
      "normal",
      "invalid",
      "animated",
      "extreme",
      "composed",
    ]);
    const meta = {
      version: "18.2",
      hardware: "macOS 15.2 (Sequoia), MacBook Pro M3",
      tool: "safaridriver + WebDriver",
      commit: "c".repeat(40),
      command: ["safaridriver", "--port", "4444"],
      controlPaths: ["studio/tools/blend-matrix.browser.mjs"],
      parameterDomain: "same declared params and extremes as the chromium run",
      tolerances: "same pixel/float tolerances as blend-matrix.browser.mjs",
      reviewer: "library-qa",
      artifacts: [path.relative(ROOT, reportPath)],
    };
    const summary = await applyFamilyCoverage(
      overlay,
      catalog,
      manifestObject,
      build(),
      "blend",
      "safari",
      all,
      {
        meta,
        artifactDir: path.relative(ROOT, artifactDirAbs),
      },
    );
    assert.deepEqual(summary, {
      family: "blend",
      axis: "safari",
      rows: 1,
      blocked: 0,
      alreadyPassed: 0,
      fullyCovered: 1,
      passed: 1,
    });
    const entry = overlay.rows[0].axes.safari;
    assert.equal(entry.status, "passed");
    assert.equal(typeof entry.run.sha256, "string");
    const artifact = JSON.parse(
      await readFile(path.join(ROOT, entry.run.path), "utf8"),
    );
    assert.equal(artifact.kind, "measured-conformance");
    assert.equal(artifact.axis, "safari");
    assert.equal(artifact.featureId, "blend.normal");
    assert.equal(artifact.target, "safari/18.2");
    assert.equal(artifact.hardware, meta.hardware);
    assert.deepEqual(artifact.fixtureIds, [
      "blend.normal/apply/normal",
      "blend.normal/apply/invalid",
      "blend.normal/apply/animated",
      "blend.normal/apply/extreme",
      "blend.normal/apply/composed",
    ]);
    assert.equal(artifact.sourceReview.reviewer, "library-qa");
    assert.equal(artifact.artifacts.length, 1);
    assert.notEqual(artifact.artifacts[0].path, entry.run.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
