#!/usr/bin/env node
/**
 * FL-112: turns the Studio authorization gates measured by
 * e2e/src/specs/web/studio-authorization.e2e-spec.ts into the authorizationFailure report that
 * scripts/frameleaf-studio-evidence.mjs reads: `{commands: [{id, manifestIds, cases: [{case, result, reason?}]}]}`.
 *
 * Each conformance row is attributed to the gates its actions reach, and rows reaching the same set
 * share one entry, so a row appears in exactly one entry. A case passes for an entry only when it passed
 * at every gate of that set: the generator unions passed cases across entries, so one entry per gate
 * would let a gate that passed hide one that failed.
 *
 *   node scripts/frameleaf-studio-authz-report.mjs --gates <studio-authorization-gates.json> [--out <report.json>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NON_RENDERING_ROWS } from "../studio/tools/conformance.mjs";

/** The cases this report owns; studio-editing reports deleted, unsupported, cancel, restart and stale-result. */
export const CASES = ["owner", "shared", "viewer", "sensitive", "revoked"];

/** Rows whose own actions import a file into a project (studio-project-import). */
const IMPORT_ROWS =
  /^(readme\.media-import\.\d+|module\.media-library|module\.lottie-browser)$/;
/** Rows whose own actions export or import a project bundle (studio-bundle). */
const BUNDLE_ROWS = new Set([
  "readme.projects-storage.5",
  "module.project-bundle",
]);

/** The gates a row's actions reach. Every row opens and saves a project whose sources are admitted. */
export const gatesOf = (rowId) => [
  "project",
  "source",
  ...(NON_RENDERING_ROWS.has(rowId) ? [] : ["preview", "export"]),
  ...(IMPORT_ROWS.test(rowId) ? ["import"] : []),
  ...(BUNDLE_ROWS.has(rowId) ? ["bundle"] : []),
];

/** One entry per set of gates; a case passes only if it passed at every gate in the set. */
export const buildReport = (rowIds, measured) => {
  const bySet = new Map();
  for (const rowId of rowIds) {
    const gates = gatesOf(rowId);
    const key = gates.join("+");
    if (!bySet.has(key)) {
      bySet.set(key, { gates, manifestIds: [] });
    }
    bySet.get(key).manifestIds.push(rowId);
  }
  const commands = [...bySet.entries()].map(
    ([key, { gates, manifestIds }]) => ({
      id: `authz.${key}`,
      manifestIds,
      cases: CASES.map((scenario) => {
        const failing = gates.filter(
          (gate) => measured.results?.[gate]?.[scenario]?.result !== "passed",
        );
        if (failing.length === 0) {
          return { case: scenario, result: "passed" };
        }
        const reasons = failing.map(
          (gate) =>
            `${gate}: ${measured.results?.[gate]?.[scenario]?.reason ?? "not measured"}`,
        );
        return { case: scenario, result: "failed", reason: reasons.join("; ") };
      }),
    }),
  );
  return { commands };
};

const main = () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const gatesPath = argument("--gates");
  if (!gatesPath) {
    console.error(
      "usage: node scripts/frameleaf-studio-authz-report.mjs --gates <studio-authorization-gates.json> [--out <file>]",
    );
    process.exit(2);
  }
  const fixtures = JSON.parse(
    readFileSync(join(root, "studio/conformance-fixtures.json"), "utf8"),
  );
  const report = buildReport(
    fixtures.rows.map((row) => row.id),
    JSON.parse(readFileSync(gatesPath, "utf8")),
  );
  const out = argument("--out");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    writeFileSync(out, text);
    const passed = report.commands.flatMap(({ manifestIds, cases }) =>
      cases
        .filter(({ result }) => result === "passed")
        .map(() => manifestIds.length),
    );
    console.log(
      `wrote ${report.commands.length} entries (${passed.reduce((a, b) => a + b, 0)} passed row cases) to ${out}`,
    );
  } else {
    process.stdout.write(text);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
