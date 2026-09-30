#!/usr/bin/env node
/**
 * FL-112 (STU-405): turn the Studio browser-matrix scripts' raw `*_REPORT` dumps into
 * `studio/conformance.json` axis updates, honestly - never claiming a passing axis unless the
 * evidence actually covers every fixture case `studio/tools/conformance.mjs`'s `fixtureIds()`
 * requires for it. A row whose evidence covers only some of the required cases is marked
 * `blocked` with the exact missing cases named, not silently left `not-tested` and not marked
 * `passed` on partial evidence - conformance.mjs itself would refuse a `passed` row whose
 * `fixtureIds` don't exactly match what the row's fixture requires (see `exact()` in that file),
 * so this script cannot produce a false "passed" even by mistake.
 *
 * Two ways to run it:
 *
 *   node scripts/frameleaf-studio-evidence.mjs --family blend --report <path> [--write]
 *
 * The CI path (frameleaf-studio-engine.yml): checks a family's `chromium`-axis coverage from
 * that engine job's own software-WebGPU run. It only ever touches `row.axes.chromium` - every
 * other axis, on every row, is left byte-for-byte untouched, whatever it currently says.
 *
 *   node scripts/frameleaf-studio-evidence.mjs --family blend --axis safari \
 *     --meta <path-to-run-meta.json> [--write]
 *
 * The one deliberate exception to "only CI evidence counts" (owner decision, 2026-09-29): Safari
 * evidence comes from a real Mac running real Safari, produced locally by library-qa, because no
 * CI runner can do that (Playwright's WebKit is explicitly not accepted as Safari evidence, and a
 * macOS CI runner was declined). `--axis safari` only ever touches `row.axes.safari`; every other
 * axis is untouched the same way the CI path leaves `safari` untouched.
 * `node studio/tools/conformance.mjs` re-validates every axis, including `safari`, on every run -
 * this script never needs its own separate "is the existing safari entry still valid" check.
 *
 * `--meta` supplies what only the person running it can attest to (browser/OS version, the actual
 * command, hardware, reviewer): schema `{ version, hardware, tool, commit, command, controlPaths,
 * parameterDomain, tolerances, reviewer, artifacts }`, where `artifacts` is a list of real file
 * paths (this script hashes them itself) - typically the raw `*_REPORT` dump(s) the coverage claim
 * is based on. `engineRevision`, `sourceSha256` and `patches` come from the repo's own
 * `studio/conformance.json` / `studio/engine-build.json`, never from `--meta`, so they can't drift
 * from what's actually checked out.
 *
 * Per-family case coverage is a manually reviewed constant (FAMILY_CASE_COVERAGE below), not
 * something inferred from a report's shape - a script can plausibly demonstrate a case without a
 * field visibly named after it, and the honest answer to "does this evidence exercise case X"
 * needs a human (ideally the script's own owner) to say so. Update the constant, with a comment
 * citing the review, when evidence for a family/axis pair gains or is confirmed to already have
 * coverage.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureIds } from "../studio/tools/conformance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OVERLAY_PATH = "studio/conformance.json";
const CATALOG_PATH = "studio/conformance-fixtures.json";
const MANIFEST_PATH = "studio/freecut-feature-manifest.json";
const BUILD_PATH = "studio/engine-build.json";
const DEFAULT_AXIS = "chromium";

/**
 * Cases each family's evidence is confirmed (by direct code review, or the evidence owner) to
 * exercise, per axis, out of the five `fixtureIds()` requires for an effect/transition/blend row
 * (normal, invalid, animated, extreme, composed). Only axes with a real coverage claim appear
 * here; an axis/family pair absent from this map has no evidence at all yet.
 *
 * chromium:
 * - effect (effects-matrix.browser.mjs): all five. normal (SDR rows), extreme (HDR row and
 *   declared-extended-range assertion), animated (keyframe resolver test), composed
 *   (effect+Brightness stack-order test), and invalid (FL-99, studio-color): non-finite, below-
 *   and above-range numbers, unknown select options, non-boolean flags and undeclared keys each
 *   draw exactly as their declared meaning (engine patch 0039), and an unknown effect id passes
 *   the input through. EFFECTS_MATRIX_REPORT carries them as effects[].invalid.
 * - transition (transition-matrix.browser.mjs): normal and extreme (SDR/HDR route boundaries and
 *   parity, per the file's header comment). No animated-parameter, composed/stack, or
 *   invalid-input case is described or found in the file.
 * - blend (blend-matrix.browser.mjs): all five. normal and extreme come from the per-mode
 *   pipeline results (pinned SDR formula on both routes; extended-range base, branch points and
 *   translucent alpha). animated, composed and invalid come from the per-mode production-renderer
 *   cases (FL-99, studio-color): opacity keyframed 0 -> 1 through the keyframe resolver; a screen
 *   blend stacked over the mode; opacity -0.5/1.5/NaN drawn as the clamped 0/1/0 plus an unknown
 *   mode id drawn as normal. BLEND_MATRIX_REPORT carries them as `report.cases`
 *   [{ mode, case, ... }].
 */
export const FAMILY_CASE_COVERAGE = {
  chromium: {
    blend: new Set(["normal", "extreme", "animated", "composed", "invalid"]),
    effect: new Set(["normal", "extreme", "animated", "composed", "invalid"]),
    transition: new Set(["normal", "extreme"]),
  },
};

/** The case name is the fixture id's final path segment: `<row>/<action>/<case>`. */
const caseOf = (fixtureId) => fixtureId.split("/").at(-1);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The cases a row's evidence on `axis` is still missing, given which cases are confirmed covered.
 * Empty means every required case is covered - the only condition under which a `passed` axis
 * entry is legitimate.
 */
export function missingCases(fixture, axis, coveredCases) {
  const required = new Set(fixtureIds(fixture, axis).map(caseOf));
  return [...required].filter((name) => !coveredCases.has(name)).sort();
}

/** Recomputes a `blocked` entry naming exactly what's missing, or null if nothing is. */
export function blockedAxisEntry(axis, missing) {
  if (missing.length === 0) {
    return null;
  }
  return {
    status: "blocked",
    reason: `Missing ${axis}-axis case(s): ${missing.join(", ")} (FL-112).`,
  };
}

/**
 * The entry a fully-covered row gets when no `--meta` was given to actually write a `passed`
 * artifact (the CI path today). Distinct from `blockedAxisEntry`'s "cases are missing" reason -
 * this row has everything it needs, it just hasn't been measured into an artifact yet. Without
 * this, a row whose case coverage went from partial to full would keep its old, now-false
 * "missing case(s)" reason forever, since nothing else ever revisits it (found by studio-color on
 * FL-112, 2026-09-30).
 */
export function pendingArtifactEntry(axis) {
  return {
    status: "blocked",
    reason: `All ${axis}-axis cases covered; awaiting the CI measured-conformance artifact (FL-112).`,
  };
}

/**
 * Builds a schema-compliant `measured-conformance` artifact and the `passed` axis entry pointing
 * at it, hashing every file itself so nothing here can be silently stale. `meta` fields the
 * generator cannot derive from the repo alone (see the module doc) must all be supplied; anything
 * missing throws rather than guessing.
 */
export async function buildPassedEntry({
  row,
  feature,
  fixture,
  axis,
  engineRevision,
  build,
  manifest,
  meta,
  artifactPath,
}) {
  for (const field of [
    "version",
    "hardware",
    "tool",
    "commit",
    "command",
    "controlPaths",
    "parameterDomain",
    "tolerances",
    "reviewer",
    "artifacts",
  ]) {
    if (meta[field] === undefined)
      throw new Error(
        `meta.${field} is required to mark ${row.id}/${axis} passed`,
      );
  }
  const artifacts = await Promise.all(
    meta.artifacts.map(async (relativePath) => {
      const bytes = await readFile(path.join(ROOT, relativePath));
      return { path: relativePath, sha256: sha256(bytes) };
    }),
  );
  const sourcePaths =
    manifest.familySourceInventory[feature.category] ??
    feature.source.map((source) => source.path);
  const record = {
    schemaVersion: 1,
    kind: "measured-conformance",
    featureId: row.id,
    axis,
    result: "passed",
    exitCode: 0,
    fixtureIds: fixtureIds(fixture, axis),
    engineRevision,
    sourceSha256: build.sourceSha256,
    patches: build.patches,
    commit: meta.commit,
    command: meta.command,
    target: `${axis}/${meta.version}`,
    tool: meta.tool,
    hardware: meta.hardware,
    parameterDomain: meta.parameterDomain,
    tolerances: meta.tolerances,
    controlPaths: meta.controlPaths,
    sourceReview: {
      paths: sourcePaths,
      actions: fixture.actions,
      reviewer: meta.reviewer,
    },
    artifacts,
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(ROOT, artifactPath), bytes);
  return {
    status: "passed",
    run: { path: artifactPath, sha256: sha256(bytes) },
  };
}

/**
 * Applies coverage for `family` on `axis`, in the overlay, in place - and only on that one axis;
 * every other axis on every row is left exactly as it was. Returns a summary. `meta`, when
 * supplied, lets a fully-covered row actually become `passed` (writing a real artifact under
 * `artifactDir`); without it a fully-covered row is only counted, never written - this is the
 * default for the CI (`chromium`) path today, since no family has full coverage there yet.
 *
 * `family: "*"` is the all-rows sentinel: it matches every row in the overlay instead of an
 * id-prefix family. It exists because `conformance.mjs`'s own schema (the `not-applicable`
 * waiver is gated to `preview`/`export` on `NON_RENDERING_ROWS` only) means axes like `command`,
 * `graph`, `timingColor` and `authorizationFailure` apply to all 210 manifest rows, not to one
 * id-prefix family - so evidence for them is naturally a single shared-layer report that should
 * route through every row, not a `blend.*`/`effect.*`/`transition.*`-style subset.
 */
export async function applyFamilyCoverage(
  overlay,
  catalog,
  manifest,
  build,
  family,
  axis,
  coveredCases,
  { meta, artifactDir } = {},
) {
  const catalogById = new Map(catalog.rows.map((row) => [row.id, row]));
  const featureById = new Map(
    manifest.features.map((feature) => [feature.id, feature]),
  );
  const summary = {
    family,
    axis,
    rows: 0,
    blocked: 0,
    alreadyPassed: 0,
    fullyCovered: 0,
    pendingArtifact: 0,
    passed: 0,
  };
  for (const row of overlay.rows) {
    if (family !== "*" && !row.id.startsWith(`${family}.`)) {
      continue;
    }
    summary.rows++;
    const fixture = catalogById.get(row.id);
    if (!fixture) {
      throw new Error(`${row.id}: no matching row in ${CATALOG_PATH}`);
    }
    const missing = missingCases(fixture, axis, coveredCases);
    const current = row.axes[axis];
    if (current.status === "passed") {
      summary.alreadyPassed++;
      continue;
    }
    if (missing.length === 0) {
      summary.fullyCovered++;
      if (!meta) {
        const entry = pendingArtifactEntry(axis);
        if (
          current.status !== entry.status ||
          current.reason !== entry.reason
        ) {
          row.axes[axis] = entry;
          summary.pendingArtifact++;
        }
        continue;
      }
      const feature = featureById.get(row.id);
      if (!feature)
        throw new Error(`${row.id}: no matching feature in ${MANIFEST_PATH}`);
      row.axes[axis] = await buildPassedEntry({
        row,
        feature,
        fixture,
        axis,
        engineRevision: overlay.engineRevision,
        build,
        manifest,
        meta,
        artifactPath: path.posix.join(artifactDir, `${row.id}.${axis}.json`),
      });
      summary.passed++;
      continue;
    }
    const entry = blockedAxisEntry(axis, missing);
    if (current.status === entry.status && current.reason === entry.reason) {
      continue;
    }
    row.axes[axis] = entry;
    summary.blocked++;
  }
  return summary;
}

/**
 * Maps each manifest row to the command-axis case names (`access`, `lease`, `revision`,
 * `idempotence`, `undo`) `studio/adapters/web/test/command-matrix.test.ts`'s own report actually
 * measured as `passed` for it - never `failed` or `not-applicable` (a command that doesn't mutate
 * the graph reports `lease`/`revision` as `not-applicable`, which is not the same as proving
 * them). A row absent from the result had no command in the report claim it at all (e.g. a
 * `readme.*` row, or one implemented by a host service rather than an engine command handler -
 * see the test's own `HOST_SERVICE_COMMANDS` exclusion) - that must read as "nothing measured",
 * not as an empty pass, so `applyCommandMatrixCoverage` treats a missing row exactly like an empty
 * `Set`, never skips it.
 */
export function commandMatrixCoverage(report) {
  const coverage = new Map();
  for (const command of report.commands ?? []) {
    const passed = new Set(
      command.cases
        .filter((entry) => entry.result === "passed")
        .map((entry) => entry.case),
    );
    for (const manifestId of command.manifestIds ?? []) {
      const existing = coverage.get(manifestId);
      if (existing) {
        for (const name of passed) existing.add(name);
      } else {
        coverage.set(manifestId, new Set(passed));
      }
    }
  }
  return coverage;
}

/**
 * The command axis's own coverage rule, separate from `applyFamilyCoverage`: coverage isn't one
 * case-set shared by every row in a family, it's per-row, read straight from the report's own
 * `manifestIds`/`cases` (see `commandMatrixCoverage`) - the same honesty rule as everywhere else
 * in this file (never trust a claim the report itself doesn't establish), applied here because a
 * single static Set can't represent "this row's evidence differs from that row's evidence" the
 * way `FAMILY_CASE_COVERAGE` can for a uniformly-measured family like blend or effect.
 */
export async function applyCommandMatrixCoverage(
  overlay,
  catalog,
  manifest,
  build,
  report,
  { meta, artifactDir } = {},
) {
  const axis = "command";
  const coverageByRow = commandMatrixCoverage(report);
  const catalogById = new Map(catalog.rows.map((row) => [row.id, row]));
  const featureById = new Map(
    manifest.features.map((feature) => [feature.id, feature]),
  );
  const summary = {
    axis,
    rows: 0,
    untested: 0,
    blocked: 0,
    alreadyPassed: 0,
    fullyCovered: 0,
    pendingArtifact: 0,
    passed: 0,
  };
  for (const row of overlay.rows) {
    summary.rows++;
    const fixture = catalogById.get(row.id);
    if (!fixture) {
      throw new Error(`${row.id}: no matching row in ${CATALOG_PATH}`);
    }
    const coveredCases = coverageByRow.get(row.id);
    if (!coveredCases) summary.untested++;
    const missing = missingCases(fixture, axis, coveredCases ?? new Set());
    const current = row.axes[axis];
    if (current.status === "passed") {
      summary.alreadyPassed++;
      continue;
    }
    if (missing.length === 0) {
      summary.fullyCovered++;
      if (!meta) {
        const entry = pendingArtifactEntry(axis);
        if (
          current.status !== entry.status ||
          current.reason !== entry.reason
        ) {
          row.axes[axis] = entry;
          summary.pendingArtifact++;
        }
        continue;
      }
      const feature = featureById.get(row.id);
      if (!feature)
        throw new Error(`${row.id}: no matching feature in ${MANIFEST_PATH}`);
      row.axes[axis] = await buildPassedEntry({
        row,
        feature,
        fixture,
        axis,
        engineRevision: overlay.engineRevision,
        build,
        manifest,
        meta,
        artifactPath: path.posix.join(artifactDir, `${row.id}.${axis}.json`),
      });
      summary.passed++;
      continue;
    }
    const entry = blockedAxisEntry(axis, missing);
    if (current.status === entry.status && current.reason === entry.reason) {
      continue;
    }
    row.axes[axis] = entry;
    summary.blocked++;
  }
  return summary;
}

function parseArguments(argv) {
  const options = { write: false, axis: DEFAULT_AXIS };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--family") {
      options.family = argv[++index];
      continue;
    }
    if (arg === "--report") {
      options.report = argv[++index];
      continue;
    }
    if (arg === "--command-matrix-report") {
      options.commandMatrixReport = argv[++index];
      continue;
    }
    if (arg === "--axis") {
      options.axis = argv[++index];
      continue;
    }
    if (arg === "--meta") {
      options.meta = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.commandMatrixReport) {
    if (options.family)
      throw new Error(
        "--command-matrix-report cannot be combined with --family",
      );
    return options;
  }
  if (!options.family)
    throw new Error(
      "Usage: --family <blend|effect|transition> [--axis <axis>] [--report <path>] [--meta <path>] [--write]\n" +
        "   or: --command-matrix-report <path> [--meta <path>] [--write]",
    );
  if (!FAMILY_CASE_COVERAGE[options.axis]?.[options.family]) {
    throw new Error(
      `No reviewed case coverage recorded for family "${options.family}" on axis "${options.axis}"`,
    );
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const overlayFile = path.join(ROOT, OVERLAY_PATH);
  const [overlay, catalog, manifest, build] = await Promise.all([
    readFile(overlayFile, "utf8").then(JSON.parse),
    readFile(path.join(ROOT, CATALOG_PATH), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, MANIFEST_PATH), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, BUILD_PATH), "utf8").then(JSON.parse),
  ]);
  const meta = options.meta
    ? JSON.parse(await readFile(options.meta, "utf8"))
    : undefined;
  let summary;
  if (options.commandMatrixReport) {
    const report = JSON.parse(
      await readFile(options.commandMatrixReport, "utf8"),
    );
    summary = await applyCommandMatrixCoverage(
      overlay,
      catalog,
      manifest,
      build,
      report,
      {
        meta,
        artifactDir: "studio/rights-evidence/conformance",
      },
    );
  } else {
    // The report itself isn't consumed beyond confirming it exists and parses when no --meta is
    // given: without --meta a fully-covered row is only counted, never written (see
    // applyFamilyCoverage), so there is nothing yet to build a `passed` artifact from.
    if (options.report) {
      JSON.parse(await readFile(options.report, "utf8"));
    }
    summary = await applyFamilyCoverage(
      overlay,
      catalog,
      manifest,
      build,
      options.family,
      options.axis,
      FAMILY_CASE_COVERAGE[options.axis][options.family],
      { meta, artifactDir: "studio/rights-evidence/conformance" },
    );
  }
  console.log(JSON.stringify(summary));
  if (options.write) {
    await writeFile(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
