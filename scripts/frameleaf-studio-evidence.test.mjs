import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WORKING_DOMAINS, REPORT_BINDINGS, domainObservations, observedFixtureIds } from "../studio/tools/lib/working-domain-report.mjs";
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

// Synthetic schema witnesses only; these cannot qualify actual browser rendering.
async function familyReport(ids = ['blend.normal'], names = ['normal', 'invalid', 'animated', 'composed']) {
  const runner = 'studio/tools/blend-matrix.browser.mjs';
  const digest = async (file) => createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex');
  const pixels = () => ({ pixels: [0.25, 0.5, 0.75, 1] });
  const results = ids.map(id => ({ mode: id.split('.')[1], ...(names.includes('normal') ? { sdr: pixels() } : {}),
    ...(names.includes('extreme') ? { floatSdr: pixels(), float: id === 'blend.normal' ? pixels() :
      { outcome: 'refused', errorType: 'HdrRenderUnavailableError' } } : {}) }));
  const cases = ids.flatMap(id => names.filter(name => ['animated', 'composed', 'invalid'].includes(name))
    .map(name => ({ mode: id.split('.')[1], case: name, ...pixels() })));
  return { schemaVersion: 1, kind: 'studio-domain-regression', result: 'passed', browser: { name: 'chromium', userAgent: 'Chromium/1 synthetic schema fixture' },
    source: { engineRevision: 'e', ...build(), commit: 'a'.repeat(40), runner: { path: runner, sha256: await digest(runner) },
      bindings: await Promise.all(REPORT_BINDINGS.map(async (path) => ({ path, sha256: await digest(path) }))) }, results, cases,
    observations: results.flatMap((row, index) => [
      ...names.map(name => ({ fixtureId: `blend.${row.mode}/apply/${name}`, workingDomain: WORKING_DOMAINS.sdr,
        expected: 'rendered', observed: 'rendered', result: 'passed', oracle: 'synthetic schema fixture only',
        witness: name === 'normal' ? `results.${index}.sdr` : name === 'extreme' ? `results.${index}.floatSdr` :
          `cases.${cases.findIndex(value => value.mode === row.mode && value.case === name)}` })),
      ...(row.float ? [{ fixtureId: `blend.${row.mode}/apply/extreme`, workingDomain: WORKING_DOMAINS.hdr,
        expected: row.mode === 'normal' ? 'rendered' : 'refused', observed: row.mode === 'normal' ? 'rendered' : 'refused',
        result: 'passed', oracle: 'synthetic schema fixture only', witness: `results.${index}.float` }] : []),
    ]) };
}

test('family coverage requires observed cases per row; SDR extremes and typed refusals cannot qualify HDR renders', async () => {
  const overlay = { engineRevision: 'e', rows: [overlayRow('blend.normal'), overlayRow('blend.dissolve'), overlayRow('effect.gpu-brightness')] };
  const catalog = { rows: overlay.rows.map(({ id }) => fixture(id)) };
  const report = await familyReport();
  report.results[0].floatSdr = structuredClone(report.results[0].sdr);
  report.observations.push({ ...report.observations[0], fixtureId: 'blend.normal/apply/extreme', witness: 'results.0.floatSdr' }); // SDR only.
  report.results.push({ mode: 'dissolve', float: { outcome: 'refused', errorType: 'HdrRenderUnavailableError' } });
  report.observations.push({ fixtureId: 'blend.dissolve/apply/extreme', workingDomain: WORKING_DOMAINS.hdr,
    expected: 'refused', observed: 'refused', result: 'passed', oracle: 'synthetic typed refusal', witness: 'results.1.float' });
  await applyFamilyCoverage(overlay, catalog, manifest(), build(), 'blend', 'chromium', report);
  assert.match(overlay.rows[0].axes.chromium.reason, /extreme.*SDR measurements cannot cover HDR extremes/);
  assert.match(overlay.rows[1].axes.chromium.reason, /typed-refused; refusal regression does not cover/);
  assert.match(overlay.rows[1].axes.chromium.reason, /animated, composed, extreme, invalid, normal/);
  assert.deepEqual(overlay.rows[0].axes.safari, { status: 'not-tested' });
  assert.deepEqual(overlay.rows[2].axes.chromium, { status: 'not-tested' });
});

test('family reports reject static grants, stale source, wrong domain, missing/duplicate cases, unexpected outcomes and changed bindings', async () => {
  const args = [{ engineRevision: 'e', rows: [overlayRow('blend.normal')] }, { rows: [fixture('blend.normal')] }, manifest(), build(), 'blend', 'chromium'];
  await assert.rejects(applyFamilyCoverage(...args, new Set(['normal', 'extreme'])), /domain report schema/);
  const wrongFamily = structuredClone(args); wrongFamily[4] = 'effect';
  await assert.rejects(applyFamilyCoverage(...wrongFamily, await familyReport()), /another operator family/);
  for (const mutate of [
    r => { r.result = 'failed'; }, r => { r.browser.name = 'safari'; }, r => { delete r.browser.userAgent; },
    r => { r.source.sourceSha256 = '0'.repeat(64); }, r => { r.source.patches = []; },
    r => { r.source.runner.sha256 = '0'.repeat(64); }, r => { r.source.bindings[0].sha256 = '0'.repeat(64); },
    r => { r.observations = []; }, r => { r.observations.push(r.observations[0]); },
    r => { r.observations[0].workingDomain = { ...WORKING_DOMAINS.hdr, referenceWhiteNits: 100 }; },
    r => { r.observations[0].workingDomain = { ...WORKING_DOMAINS.sdr, encoding: 'linear' }; },
    r => { r.observations[0].observed = 'refused'; }, r => { r.results[0].sdr.error = 'unexpected'; }, r => { r.observations[0].witness = 'missing'; },
    r => { r.observations[0].fixtureId = 'blend.unknown/apply/normal'; },
  ]) {
    const report = await familyReport(); mutate(report);
    await assert.rejects(applyFamilyCoverage(...structuredClone(args), report));
  }
});

test('a complete observed family row remains pending until measured metadata and its exact report are retained', async () => {
  const overlay = { engineRevision: 'e', rows: [overlayRow('blend.normal')] };
  const catalog = { rows: [fixture('blend.normal')] };
  const report = await familyReport(['blend.normal'], ['normal', 'invalid', 'animated', 'extreme', 'composed']);
  const args = [overlay, catalog, { ...manifest(), features: [feature('blend.normal')] }, build(), 'blend', 'chromium', report];
  assert.equal((await applyFamilyCoverage(...args)).pendingArtifact, 1);
  assert.deepEqual(overlay.rows[0].axes.chromium, pendingArtifactEntry('chromium'));
  assert.equal((await applyFamilyCoverage(...args)).pendingArtifact, 0);
  const dir = await mkdtemp(path.join(ROOT, 'studio/.evidence-test-'));
  try {
    const reportPath = path.relative(ROOT, path.join(dir, 'report.json'));
    await writeFile(path.join(ROOT, reportPath), JSON.stringify(report));
    const meta = { version: 'synthetic', hardware: 'synthetic', tool: 'node schema test', commit: report.source.commit,
      command: ['node', 'synthetic'], controlPaths: ['synthetic'], parameterDomain: 'synthetic', tolerances: 'exact', reviewer: 'synthetic',
      artifacts: [reportPath], startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:00:01Z' };
    assert.equal((await applyFamilyCoverage(...args, { meta, artifactDir: path.relative(ROOT, dir) })).passed, 1);
    const record = JSON.parse(await readFile(path.join(ROOT, overlay.rows[0].axes.chromium.run.path)));
    assert.equal(record.observationReport.path, reportPath);
    assert.equal(record.fixtureIds.length, 5);
    await assert.rejects(buildPassedEntry({ row: overlay.rows[0], feature: feature('blend.normal'), fixture: catalog.rows[0],
      axis: 'chromium', engineRevision: 'e', build: build(), manifest: manifest(), meta, artifactPath: 'unused' }), /domain report/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('independent conformance validation rejects fixture lists without observed HDR render evidence', async () => {
  const data = await loadConformance(ROOT);
  const row = data.overlay.rows.find(value => value.id === 'blend.normal');
  const feature = data.manifest.features.find(value => value.id === row.id);
  const fixture = data.catalog.rows.find(value => value.id === row.id);
  const dir = await mkdtemp(path.join(ROOT, 'studio/.evidence-test-'));
  const save = async (name, value) => {
    const relative = path.relative(ROOT, path.join(dir, name));
    const bytes = JSON.stringify(value);
    await writeFile(path.join(ROOT, relative), bytes);
    return { path: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  try {
    const report = await familyReport([row.id], ['normal', 'invalid', 'animated', 'extreme', 'composed']);
    Object.assign(report.source, data.build, { engineRevision: data.manifest.engineRevision });
    const retained = await save('report.json', report);
    const meta = { version: 'synthetic', hardware: 'synthetic schema environment', tool: 'node schema test', commit: report.source.commit,
      command: ['node', 'synthetic'], controlPaths: ['synthetic'], parameterDomain: 'synthetic', tolerances: 'exact', reviewer: 'synthetic',
      artifacts: [retained.path], startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:00:01Z' };
    row.axes.chromium = await buildPassedEntry({ row, feature, fixture, axis: 'chromium', report, meta,
      engineRevision: data.manifest.engineRevision, build: data.build, manifest: data.manifest,
      artifactPath: path.relative(ROOT, path.join(dir, 'run.json')) });
    assert.equal((await validateConformance(data, ROOT)).passedAxes, 1);
    const run = JSON.parse(await readFile(path.join(ROOT, row.axes.chromium.run.path)));
    const noReport = structuredClone(run); delete noReport.observationReport;
    row.axes.chromium.run = await save('run.json', noReport);
    await assert.rejects(validateConformance(data, ROOT), /retained observation report/);
    for (const mutate of [
      r => { r.observations.find(value => value.fixtureId.endsWith('/extreme') && value.workingDomain.id === WORKING_DOMAINS.hdr.id).workingDomain = WORKING_DOMAINS.sdr; },
      r => { const value = r.observations.find(value => value.fixtureId.endsWith('/extreme') && value.workingDomain.id === WORKING_DOMAINS.hdr.id);
        Object.assign(value, { expected: 'refused', observed: 'refused', witness: 'results.1.float' }); },
      r => { r.source.runner.sha256 = '0'.repeat(64); },
      r => { r.source.bindings[0].sha256 = '0'.repeat(64); },
    ]) {
      const changed = structuredClone(report); mutate(changed);
      const ref = await save('report.json', changed);
      row.axes.chromium.run = await save('run.json', { ...run, artifacts: [ref], observationReport: ref });
      await assert.rejects(validateConformance(data, ROOT));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Keep artifact/source metadata valid: these attacks change only observation-to-route binding.
const forgedRoutes = [
  report => {
    report.observations = report.observations.filter(value => !(value.fixtureId === 'blend.screen/apply/extreme' && value.workingDomain.id === WORKING_DOMAINS.hdr.id));
    report.observations.find(value => value.fixtureId === 'blend.screen/apply/extreme').workingDomain = WORKING_DOMAINS.hdr;
  },
  report => { report.observations.find(value => value.fixtureId === 'blend.normal/apply/normal').witness = 'results.1.sdr'; },
  report => { report.observations.find(value => value.fixtureId === 'blend.normal/apply/animated').witness = 'cases.2'; },
];

test('updater rejects SDR-to-HDR relabeling and another feature or case witness', async () => {
  const args = [{ engineRevision: 'e', rows: [overlayRow('blend.normal'), overlayRow('blend.screen')] },
    { rows: [fixture('blend.normal'), fixture('blend.screen')] }, manifest(), build(), 'blend', 'chromium'];
  for (const [index, forge] of forgedRoutes.entries()) {
    const report = await familyReport(['blend.normal', 'blend.screen'], ['normal', 'invalid', 'animated', 'extreme', 'composed']);
    forge(report);
    const id = index === 0 ? 'blend.screen' : 'blend.normal', name = ['extreme', 'normal', 'animated'][index];
    assert(!observedFixtureIds(report, id).includes(`${id}/apply/${name}`), 'coverage must derive the measured route');
    await assert.rejects(applyFamilyCoverage(...structuredClone(args), report), /route binding/);
  }
});

test('independent validator rejects relabeled and substituted witnesses despite matching artifact/source metadata', async () => {
  const original = await loadConformance(ROOT);
  const dir = await mkdtemp(path.join(ROOT, 'studio/.evidence-test-'));
  const save = async (name, value) => {
    const relative = path.relative(ROOT, path.join(dir, name)), bytes = JSON.stringify(value);
    await writeFile(path.join(ROOT, relative), bytes);
    return { path: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  try {
    const report = await familyReport(['blend.normal', 'blend.screen'], ['normal', 'invalid', 'animated', 'extreme', 'composed']);
    Object.assign(report.source, original.build, { engineRevision: original.manifest.engineRevision });
    const data = structuredClone(original), row = data.overlay.rows.find(value => value.id === 'blend.normal');
    const fixture = data.catalog.rows.find(value => value.id === row.id), feature = data.manifest.features.find(value => value.id === row.id);
    const retained = await save('report.json', report);
    const meta = { version: 'synthetic', hardware: 'synthetic schema environment', tool: 'node schema test', commit: report.source.commit,
      command: ['node', 'synthetic'], controlPaths: ['synthetic'], parameterDomain: 'synthetic', tolerances: 'exact', reviewer: 'synthetic',
      artifacts: [retained.path], startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:00:01Z' };
    row.axes.chromium = await buildPassedEntry({ row, feature, fixture, axis: 'chromium', report, meta,
      engineRevision: data.manifest.engineRevision, build: data.build, manifest: data.manifest,
      artifactPath: path.relative(ROOT, path.join(dir, 'run.json')) });
    assert.equal((await validateConformance(data, ROOT)).passedAxes, 1);
    const run = JSON.parse(await readFile(path.join(ROOT, row.axes.chromium.run.path)));
    for (const [index, forge] of forgedRoutes.entries()) {
      const changed = structuredClone(report); forge(changed);
      const ref = await save('report.json', changed), data = structuredClone(original);
      const id = index === 0 ? 'blend.screen' : 'blend.normal';
      data.overlay.rows.find(value => value.id === id).axes.chromium = { status: 'passed',
        run: await save('run.json', { ...run, featureId: id,
          fixtureIds: run.fixtureIds.map(value => value.replace('blend.normal', id)), artifacts: [ref], observationReport: ref }) };
      await assert.rejects(validateConformance(data, ROOT), /route binding/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test('brightness HDR coverage is bound only to its actual migrated routes', async () => {
  const report = await familyReport();
  const runner = 'studio/tools/effects-matrix.browser.mjs';
  report.source.runner = { path: runner, sha256: createHash('sha256').update(await readFile(path.join(ROOT,runner))).digest('hex') };
  const pixels = () => ({ pixels: [-.5,2,4,.5] });
  const cases = () => [pixels(),pixels(),pixels()];
  report.effects = [
    { id:'gpu-brightness',cases:cases(),animation:pixels(),stack:pixels(),invalid:cases(),
      hdr:{cases:cases(),animation:pixels(),stack:pixels(),invalid:cases()} },
    { id:'gpu-exposure',cases:cases(),hdrRefusal:{outcome:'refused',errorType:'HdrRenderUnavailableError'} },
  ];
  report.observations = domainObservations(report);
  const args = [{engineRevision:'e',rows:[overlayRow('effect.gpu-brightness'),overlayRow('effect.gpu-exposure')]},
    {rows:[fixture('effect.gpu-brightness'),fixture('effect.gpu-exposure')]},manifest(),build(),'effect','chromium'];
  const overlay = structuredClone(args);
  assert.equal((await applyFamilyCoverage(...overlay,report)).pendingArtifact,1);
  assert.equal(overlay[0].rows[0].axes.chromium.status,'blocked');
  assert.match(overlay[0].rows[1].axes.chromium.reason,/typed-refused/);
  for (const change of [
    r => {r.observations.find(e=>e.fixtureId==='effect.gpu-brightness/apply/extreme' && e.workingDomain.id===WORKING_DOMAINS.hdr.id).witness='effects.0.cases';},
    r => {r.observations.find(e=>e.fixtureId==='effect.gpu-brightness/apply/animated' && e.workingDomain.id===WORKING_DOMAINS.hdr.id).witness='effects.0.hdr.stack';},
    r => {const e=r.observations.find(e=>e.fixtureId==='effect.gpu-exposure/apply/extreme' && e.workingDomain.id===WORKING_DOMAINS.hdr.id);Object.assign(e,{expected:'rendered',observed:'rendered',witness:'effects.0.hdr.cases'});},
  ]) {
    const forged=structuredClone(report);change(forged);
    await assert.rejects(applyFamilyCoverage(...structuredClone(args),forged),/route binding/);
  }
});
