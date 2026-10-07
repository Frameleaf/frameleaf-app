import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AXES,
  loadConformance,
  validateConformance,
} from "../studio/tools/conformance.mjs";
import {
  FAMILY_CASE_COVERAGE,
  applyCommandMatrixCoverage,
  applyFamilyCoverage,
  blockedAxisEntry,
  buildPassedEntry,
  commandMatrixCoverage,
  mergeMatrixCoverage,
  missingCases,
  pendingArtifactEntry,
  rowCommandsFromCatalogue,
} from "./frameleaf-studio-evidence.mjs";

// A rowCommands map used in tests instead of the catalogue's real row/command links, so these
// tests don't depend on - or break when someone edits - the real reviewed entries.
const rowCommands = (map) => map;

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

test("generated passed records satisfy the independent validator without inventing measurements", async () => {
  const dir = await mkdtemp(path.join(ROOT, "studio", ".evidence-test-"));
  try {
    const reportPath = path.relative(ROOT, path.join(dir, "output.txt"));
    await writeFile(
      path.join(ROOT, reportPath),
      "Synthetic schema test; not browser qualification.",
    );
    const original = await loadConformance(ROOT);
    const meta = {
      version: "synthetic-test",
      hardware: "synthetic schema-test environment",
      tool: "node test",
      commit: "a".repeat(40),
      command: ["node", "synthetic-schema-test.mjs"],
      controlPaths: ["synthetic schema test only"],
      parameterDomain: "synthetic inputs",
      tolerances: "exact",
      reviewer: "synthetic schema test",
      artifacts: [reportPath],
      startedAt: "2026-09-29T00:00:00Z",
      finishedAt: "2026-09-29T00:00:01Z",
      operation: "timeline.trim",
      frameTimeIdentity: "synthetic frame 0 at 0/1",
      inputProfiles: "synthetic SDR",
      outputProfiles: "synthetic SDR",
      alpha: "synthetic opaque",
      audio: "synthetic silence",
      temporalRecovery: "synthetic recovery case",
    };
    for (const axis of AXES.filter((axis) => axis !== "native")) {
      const data = structuredClone(original);
      const row = data.overlay.rows[0];
      const args = {
        row,
        feature: data.manifest.features[0],
        fixture: data.catalog.rows[0],
        axis,
        engineRevision: data.overlay.engineRevision,
        build: data.build,
        manifest: data.manifest,
        meta,
        artifactPath: path.relative(ROOT, path.join(dir, `${axis}.json`)),
      };
      row.axes[axis] = await buildPassedEntry(args);
      const summary = await validateConformance(data, ROOT);
      assert.equal(summary.passedAxes, 1);
      assert.equal(summary.qualifiedRows, 0);
      assert.equal(summary.releaseQualified, false);
      const record = JSON.parse(
        await readFile(path.join(ROOT, args.artifactPath), "utf8"),
      );
      assert.equal(record.startedAt, meta.startedAt);
      assert.equal(record.finishedAt, meta.finishedAt);
      const missing = { ...meta };
      delete missing[
        axis === "command"
          ? "operation"
          : ["preview", "export", "timingColor"].includes(axis)
            ? "frameTimeIdentity"
            : "startedAt"
      ];
      await assert.rejects(
        buildPassedEntry({ ...args, meta: missing }),
        /meta\./,
      );
      await assert.rejects(
        buildPassedEntry({
          ...args,
          meta: { ...meta, finishedAt: "2026-09-28T00:00:00Z" },
        }),
        /run times/,
      );
      await assert.rejects(
        buildPassedEntry({
          ...args,
          meta: { ...meta, startedAt: "not-a-date" },
        }),
        /run times/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("the transition family claims all five chromium cases its matrix measures, and the overlay says so", async () => {
  // transition-matrix.browser.mjs measures animated, composed and invalid for every transition
  // through the production renderer; engine patch 0048 gives the invalid inputs their meaning.
  assert.deepEqual([...FAMILY_CASE_COVERAGE.chromium.transition].sort(), [
    "animated",
    "composed",
    "extreme",
    "invalid",
    "normal",
  ]);
  const overlay = JSON.parse(
    await readFile(path.join(ROOT, "studio/conformance.json"), "utf8"),
  );
  const rows = overlay.rows.filter((row) => row.id.startsWith("transition."));
  assert.equal(rows.length, 21);
  for (const row of rows) {
    assert.deepEqual(row.axes.chromium, pendingArtifactEntry("chromium"));
  }
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

test("commandMatrixCoverage counts only passed cases, merged across commands sharing a row", () => {
  const report = {
    commands: [
      {
        id: "timeline.trim",
        manifestIds: ["command.timeline-trim"],
        cases: [
          { case: "access", result: "passed" },
          { case: "lease", result: "passed" },
          { case: "revision", result: "failed", reason: "x" },
          { case: "idempotence", result: "passed" },
          { case: "undo", result: "not-applicable", reason: "no graph edit" },
        ],
      },
      {
        // A second command that happens to implement the same manifest row: its passed cases
        // merge in rather than overwrite.
        id: "timeline.trim.alias",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "undo", result: "passed" }],
      },
    ],
  };
  const coverage = commandMatrixCoverage(report);
  assert.deepEqual(
    coverage.get("command.timeline-trim"),
    new Set(["access", "lease", "idempotence", "undo"]),
  );
  assert.equal(coverage.size, 1);
});

test("applyCommandMatrixCoverage blocks a covered row on the cases the report didn't pass", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [
      overlayRow("command.timeline-trim", {
        command: { status: "not-tested" },
      }),
    ],
  };
  const catalog = { rows: [fixture("command.timeline-trim")] };
  const report = {
    commands: [
      {
        id: "timeline.trim",
        manifestIds: ["command.timeline-trim"],
        cases: [
          { case: "access", result: "passed" },
          { case: "lease", result: "passed" },
          { case: "revision", result: "passed" },
          { case: "idempotence", result: "passed" },
          { case: "undo", result: "passed" },
        ],
      },
    ],
  };
  const summary = await applyCommandMatrixCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    report,
  );
  assert.deepEqual(summary, {
    axis: "command",
    rows: 1,
    untested: 0,
    blocked: 1,
    alreadyPassed: 0,
    fullyCovered: 0,
    pendingArtifact: 0,
    passed: 0,
  });
  // The report proves the 5 command-axis cases, but fixtureIds still requires the row's own base
  // cases (normal/invalid) too - genuinely unmeasured by this report, so honestly still missing.
  assert.deepEqual(overlay.rows[0].axes.command, {
    status: "blocked",
    reason: "Missing command-axis case(s): invalid, normal (FL-112).",
  });
});

test("commandMatrixCoverage merges a row's manifestIds coverage with its explicit rowCommands mapping", () => {
  const report = {
    commands: [
      {
        id: "effect.add",
        manifestIds: [],
        cases: [{ case: "access", result: "passed" }],
      },
      {
        id: "effect.update",
        manifestIds: ["command.effect-update"],
        cases: [
          { case: "access", result: "passed" },
          { case: "lease", result: "passed" },
        ],
      },
    ],
  };
  const coverage = commandMatrixCoverage(
    report,
    rowCommands({ "module.effects": ["effect.add", "effect.update"] }),
  );
  // module.effects has no manifestIds of its own, but gets the union of the passed cases from
  // both mapped commands.
  assert.deepEqual(
    coverage.get("module.effects"),
    new Set(["access", "lease"]),
  );
  // The command's own manifestIds-based row is untouched by the mapping.
  assert.deepEqual(
    coverage.get("command.effect-update"),
    new Set(["access", "lease"]),
  );
});

test("rowCommandsFromCatalogue reads each non-command row's own commands and skips rows with none", () => {
  assert.deepEqual(
    rowCommandsFromCatalogue({
      commands: [{ id: "effect.add", manifestIds: ["command.effect-add"] }],
      nonCommandRows: [
        { id: "module.effects", reason: "r", commands: ["effect.add"] },
        { id: "module.docs", reason: "r", commands: [], withoutCommand: "w" },
      ],
    }),
    { "module.effects": ["effect.add"] },
  );
});

test("the command axis takes its row/command links from the published catalogue by default", async () => {
  const report = {
    commands: [
      {
        id: "effect.reorder",
        manifestIds: [],
        cases: [{ case: "undo", result: "passed" }],
      },
      {
        id: "clip.update",
        manifestIds: [],
        cases: [{ case: "lease", result: "passed" }],
      },
    ],
  };
  const coverage = commandMatrixCoverage(report);
  assert.deepEqual(coverage.get("module.effects"), new Set(["undo"]));
  assert.deepEqual(
    coverage.get("readme.effects-masks-compositing.8"),
    new Set(["lease"]),
  );
  // A row the catalogue links to no command gets nothing from a report that doesn't name it.
  assert.equal(coverage.has("module.docs"), false);
  const catalogue = JSON.parse(
    await readFile(
      path.join(ROOT, "studio/frameleaf-studio-commands.json"),
      "utf8",
    ),
  );
  assert.equal(Object.keys(rowCommandsFromCatalogue(catalogue)).length, 16);
});

test("applyCommandMatrixCoverage covers a mapped row using the union of its commands' passed cases", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("module.effects", { command: { status: "not-tested" } })],
  };
  const catalog = { rows: [fixture("module.effects")] };
  const report = {
    commands: [
      {
        id: "effect.add",
        manifestIds: [],
        cases: [
          { case: "access", result: "passed" },
          { case: "idempotence", result: "passed" },
        ],
      },
      {
        id: "effect.remove",
        manifestIds: [],
        cases: [{ case: "lease", result: "passed" }],
      },
    ],
  };
  const summary = await applyCommandMatrixCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    report,
    {
      rowCommands: rowCommands({
        "module.effects": ["effect.add", "effect.remove"],
      }),
    },
  );
  assert.equal(summary.untested, 0);
  assert.deepEqual(overlay.rows[0].axes.command, {
    status: "blocked",
    reason:
      "Missing command-axis case(s): invalid, normal, revision, undo (FL-112).",
  });
});

test("applyCommandMatrixCoverage treats a row absent from the report as fully untested, not as an empty pass", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [
      overlayRow("command.untouched", { command: { status: "not-tested" } }),
    ],
  };
  const catalog = { rows: [fixture("command.untouched")] };
  const report = { commands: [] };
  const summary = await applyCommandMatrixCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    report,
  );
  assert.equal(summary.untested, 1);
  assert.deepEqual(overlay.rows[0].axes.command, {
    status: "blocked",
    reason:
      "Missing command-axis case(s): access, idempotence, invalid, lease, normal, revision, undo (FL-112).",
  });
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
    pendingArtifact: 0,
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

test("applyFamilyCoverage marks a fully-covered row's axis pending-artifact when no meta is given", async () => {
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
    pendingArtifact: 1,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, {
    status: "blocked",
    reason:
      "All chromium-axis cases covered; awaiting the CI measured-conformance artifact (FL-112).",
  });
});

test("applyFamilyCoverage replaces a now-false 'missing case(s)' reason once coverage becomes complete", async () => {
  const stale = {
    status: "blocked",
    reason: "Missing chromium-axis case(s): invalid (FL-112).",
  };
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("blend.normal", { chromium: stale })],
  };
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
  assert.equal(summary.pendingArtifact, 1);
  assert.deepEqual(overlay.rows[0].axes.chromium, {
    status: "blocked",
    reason:
      "All chromium-axis cases covered; awaiting the CI measured-conformance artifact (FL-112).",
  });
});

test("applyFamilyCoverage is idempotent once a row is already marked pending-artifact", async () => {
  const pending = {
    status: "blocked",
    reason:
      "All chromium-axis cases covered; awaiting the CI measured-conformance artifact (FL-112).",
  };
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("blend.normal", { chromium: pending })],
  };
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
  assert.equal(summary.pendingArtifact, 0);
  assert.deepEqual(overlay.rows[0].axes.chromium, pending);
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
    pendingArtifact: 0,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.chromium, passed);
});

test("applyFamilyCoverage family '*' matches every row regardless of id prefix", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [
      overlayRow("readme.foo", { graph: { status: "not-tested" } }),
      overlayRow("module.export", { graph: { status: "not-tested" } }),
      overlayRow("blend.normal", { graph: { status: "not-tested" } }),
    ],
  };
  const catalog = {
    rows: [
      fixture("readme.foo"),
      fixture("module.export"),
      fixture("blend.normal"),
    ],
  };
  const summary = await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "*",
    "graph",
    new Set(["normal", "invalid", "save", "reopen"]),
  );
  assert.deepEqual(summary, {
    family: "*",
    axis: "graph",
    rows: 3,
    blocked: 3,
    alreadyPassed: 0,
    fullyCovered: 0,
    pendingArtifact: 0,
    passed: 0,
  });
  assert.deepEqual(overlay.rows[0].axes.graph, {
    status: "blocked",
    reason: "Missing graph-axis case(s): bundle, unknown-fields (FL-112).",
  });
  assert.deepEqual(overlay.rows[1].axes.graph, {
    status: "blocked",
    reason: "Missing graph-axis case(s): bundle, unknown-fields (FL-112).",
  });
});

test("applyFamilyCoverage with a real family does not touch rows outside it, unlike '*'", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("readme.foo"), overlayRow("blend.normal")],
  };
  const catalog = { rows: [fixture("readme.foo"), fixture("blend.normal")] };
  const summary = await applyFamilyCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    "blend",
    "chromium",
    new Set(["normal", "extreme"]),
  );
  assert.equal(summary.rows, 1);
  assert.deepEqual(overlay.rows[0].axes.chromium, { status: "not-tested" });
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
      startedAt: "2026-09-29T00:00:00Z",
      finishedAt: "2026-09-29T00:00:01Z",
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
      pendingArtifact: 0,
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

test("mergeMatrixCoverage unions per-row coverage across reports that own disjoint cases", () => {
  const shared = commandMatrixCoverage({
    commands: [
      {
        id: "access.project-source-render",
        manifestIds: ["command.timeline-trim"],
        cases: [
          { case: "owner", result: "passed" },
          { case: "shared", result: "passed" },
        ],
      },
    ],
  });
  const engine = commandMatrixCoverage({
    commands: [
      {
        id: "timeline.trim",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "deleted", result: "passed" }],
      },
    ],
  });
  const merged = mergeMatrixCoverage([shared, engine]);
  assert.deepEqual(
    merged.get("command.timeline-trim"),
    new Set(["owner", "shared", "deleted"]),
  );
});

test("mergeMatrixCoverage throws when two reports both claim the same case for the same row", () => {
  const first = commandMatrixCoverage({
    commands: [
      {
        id: "a",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "viewer", result: "passed" }],
      },
    ],
  });
  const second = commandMatrixCoverage({
    commands: [
      {
        id: "b",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "viewer", result: "passed" }],
      },
    ],
  });
  assert.throws(
    () => mergeMatrixCoverage([first, second]),
    /case "viewer" reported passed by more than one report/,
  );
});

test("applyCommandMatrixCoverage takes the axis as a parameter, not hardcoded to 'command'", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [
      overlayRow("command.timeline-trim", {
        authorizationFailure: { status: "not-tested" },
      }),
    ],
  };
  const catalog = { rows: [fixture("command.timeline-trim")] };
  const sharedAccessReport = {
    commands: [
      {
        id: "access.project-source-render",
        manifestIds: ["command.timeline-trim"],
        cases: ["owner", "shared", "viewer", "sensitive", "revoked"].map(
          (name) => ({ case: name, result: "passed" }),
        ),
      },
    ],
  };
  const engineFailureReport = {
    commands: [
      {
        id: "timeline.trim",
        manifestIds: ["command.timeline-trim"],
        cases: [
          "deleted",
          "unsupported",
          "cancel",
          "restart",
          "stale-result",
        ].map((name) => ({ case: name, result: "passed" })),
      },
    ],
  };
  const summary = await applyCommandMatrixCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    [sharedAccessReport, engineFailureReport],
    { axis: "authorizationFailure" },
  );
  assert.equal(summary.axis, "authorizationFailure");
  assert.equal(summary.untested, 0);
  // All 10 authorizationFailure-specific cases are covered by the union of both reports; the
  // row's own base cases (normal/invalid) are genuinely unmeasured by either, so still missing.
  assert.deepEqual(overlay.rows[0].axes.authorizationFailure, {
    status: "blocked",
    reason:
      "Missing authorizationFailure-axis case(s): invalid, normal (FL-112).",
  });
});

test("applyCommandMatrixCoverage propagates the cross-report case-ownership conflict as an error", async () => {
  const overlay = {
    engineRevision: "e",
    rows: [
      overlayRow("command.timeline-trim", {
        authorizationFailure: { status: "not-tested" },
      }),
    ],
  };
  const catalog = { rows: [fixture("command.timeline-trim")] };
  const reportA = {
    commands: [
      {
        id: "a",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "viewer", result: "passed" }],
      },
    ],
  };
  const reportB = {
    commands: [
      {
        id: "b",
        manifestIds: ["command.timeline-trim"],
        cases: [{ case: "viewer", result: "passed" }],
      },
    ],
  };
  await assert.rejects(
    () =>
      applyCommandMatrixCoverage(
        overlay,
        catalog,
        manifest(),
        build(),
        [reportA, reportB],
        { axis: "authorizationFailure" },
      ),
    /case "viewer" reported passed by more than one report/,
  );
});

test("applyCommandMatrixCoverage leaves a ruled command-axis waiver as it is", async () => {
  const waiver = { status: "not-applicable", reason: "ruled" };
  const overlay = {
    engineRevision: "e",
    rows: [overlayRow("module.docs", { command: { ...waiver } })],
  };
  const catalog = { rows: [fixture("module.docs")] };
  const report = {
    commands: [
      {
        id: "effect.add",
        manifestIds: ["module.docs"],
        cases: [{ case: "access", result: "passed" }],
      },
    ],
  };
  const summary = await applyCommandMatrixCoverage(
    overlay,
    catalog,
    manifest(),
    build(),
    report,
  );
  assert.deepEqual(overlay.rows[0].axes.command, waiver);
  assert.equal(summary.waived, 1);
  assert.equal(summary.untested, 0);
  assert.equal(summary.blocked, 0);
});
