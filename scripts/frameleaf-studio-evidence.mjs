#!/usr/bin/env node
/**
 * FL-112 (STU-405): turn the Studio browser-matrix scripts' raw `*_REPORT` dumps into
 * `studio/conformance.json` axis updates, honestly - never claiming a passing axis unless the
 * report actually covers every fixture case `studio/tools/conformance.mjs`'s `fixtureIds()`
 * requires for it. A row whose report covers only some of the required cases is marked
 * `blocked` with the exact missing cases named, not silently left `not-tested` and not marked
 * `passed` on partial evidence - conformance.mjs itself would refuse a `passed` row whose
 * `fixtureIds` don't exactly match what the row's fixture requires (see `exact()` in that file),
 * so this script cannot produce a false "passed" even by mistake.
 *
 * Per-family case coverage is a manually reviewed constant (FAMILY_CASE_COVERAGE below), not
 * something inferred from the report's shape - a browser script can plausibly demonstrate a case
 * without a field visibly named after it, and the honest answer to "does this script exercise
 * case X" needs a human (ideally the script's own owner) to say so. Update the constant, with a
 * comment citing the review, when a script gains or is confirmed to already have coverage.
 *
 *   node scripts/frameleaf-studio-evidence.mjs --family blend --report <path> [--write]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureIds } from "../studio/tools/conformance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OVERLAY_PATH = "studio/conformance.json";
const CATALOG_PATH = "studio/conformance-fixtures.json";
const AXIS = "chromium";

/**
 * Cases each family's browser script(s) are confirmed (by direct code review, or the script
 * owner) to exercise on the `chromium` axis, out of the five `fixtureIds()` requires for an
 * effect/transition/blend row (normal, invalid, animated, extreme, composed).
 *
 * - effect (studio/tools/effects-matrix.browser.mjs): normal (SDR rows), extreme (HDR row and
 *   declared-extended-range assertion), animated (keyframe resolver test, lines ~155-181),
 *   composed (effect+Brightness stack-order test, lines ~184-193). No case feeds a malformed or
 *   out-of-declared-range parameter (every case is a valid default, numeric extreme, enum option
 *   or boolean) - `invalid` is not exercised.
 * - transition (studio/tools/transition-matrix.browser.mjs): normal and extreme (SDR/HDR route
 *   boundaries and parity, per the file's header comment). No animated-parameter, composed/stack,
 *   or invalid-input case is described or found in the file.
 * - blend (studio/tools/blend-matrix.browser.mjs): normal and extreme only, per studio-color's own
 *   review on FL-112 (2026-09-30) - invalid, animated and composed all genuinely apply to blending
 *   (opacity is keyframable and enters every blend formula; stacking two blends is ordinary
 *   compositing; an unknown mode id or out-of-range/non-finite opacity is a real untested input),
 *   they are simply not measured yet. studio-color is extending blend-matrix.browser.mjs to cover
 *   all three, with a per-case `{ mode, case }` section in BLEND_MATRIX_REPORT.
 */
export const FAMILY_CASE_COVERAGE = {
  blend: new Set(["normal", "extreme"]),
  effect: new Set(["normal", "extreme", "animated", "composed"]),
  transition: new Set(["normal", "extreme"]),
};

/** The case name is the fixture id's final path segment: `<row>/<action>/<case>`. */
const caseOf = (fixtureId) => fixtureId.split("/").at(-1);

/**
 * The cases a row's `chromium`-axis evidence is still missing, given which cases the family's
 * script(s) are confirmed to cover. Empty means every required case is covered - the only
 * condition under which a `passed` axis is legitimate.
 */
export function missingCases(fixture, axis, coveredCases) {
  const required = new Set(fixtureIds(fixture, axis).map(caseOf));
  return [...required].filter((name) => !coveredCases.has(name)).sort();
}

/**
 * Recomputes one row's axis entry. A row with every required case covered needs a real measured
 * artifact to become `passed` - this function alone never manufactures one, so it can only move a
 * row to `blocked` (naming exactly what's missing) or leave a fully-covered row for the caller to
 * evidence separately. It refuses to downgrade a row that is already `passed`.
 */
export function blockedAxisEntry(missing) {
  if (missing.length === 0) {
    return null;
  }
  return {
    status: "blocked",
    reason: `Missing chromium-axis case(s): ${missing.join(", ")} (FL-112).`,
  };
}

/** Applies blockedAxisEntry() to every row of `family` in the overlay, in place. Returns a summary. */
export function applyFamilyCoverage(overlay, catalog, family, coveredCases) {
  const catalogById = new Map(catalog.rows.map((row) => [row.id, row]));
  const summary = {
    family,
    rows: 0,
    blocked: 0,
    alreadyPassed: 0,
    fullyCovered: 0,
  };
  for (const row of overlay.rows) {
    if (!row.id.startsWith(`${family}.`)) {
      continue;
    }
    summary.rows++;
    const fixture = catalogById.get(row.id);
    if (!fixture) {
      throw new Error(`${row.id}: no matching row in ${CATALOG_PATH}`);
    }
    const missing = missingCases(fixture, AXIS, coveredCases);
    const current = row.axes[AXIS];
    if (current.status === "passed") {
      summary.alreadyPassed++;
      continue;
    }
    if (missing.length === 0) {
      summary.fullyCovered++;
      continue;
    }
    const entry = blockedAxisEntry(missing);
    if (current.status === entry.status && current.reason === entry.reason) {
      continue;
    }
    row.axes[AXIS] = entry;
    summary.blocked++;
  }
  return summary;
}

function parseArguments(argv) {
  const options = { write: false };
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.family)
    throw new Error(
      "Usage: --family <blend|effect|transition> [--report <path>] [--write]",
    );
  if (!Object.hasOwn(FAMILY_CASE_COVERAGE, options.family)) {
    throw new Error(`Unknown family: ${options.family}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const overlayFile = path.join(ROOT, OVERLAY_PATH);
  const [overlay, catalog] = await Promise.all([
    readFile(overlayFile, "utf8").then(JSON.parse),
    readFile(path.join(ROOT, CATALOG_PATH), "utf8").then(JSON.parse),
  ]);
  // The report itself isn't consumed yet beyond confirming it exists and parses: today no family
  // has full case coverage, so there is no `passed` artifact to build from it. Requiring it keeps
  // this script honest about needing real measured data, not just the coverage constant, once a
  // family reaches full coverage and this script's `passed` path is written.
  if (options.report) {
    JSON.parse(await readFile(options.report, "utf8"));
  }
  const summary = applyFamilyCoverage(
    overlay,
    catalog,
    options.family,
    FAMILY_CASE_COVERAGE[options.family],
  );
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
