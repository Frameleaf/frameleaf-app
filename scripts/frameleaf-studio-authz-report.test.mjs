import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CASES,
  buildReport,
  gatesOf,
} from "./frameleaf-studio-authz-report.mjs";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../studio/conformance-fixtures.json", import.meta.url),
    "utf8",
  ),
);
const rowIds = fixtures.rows.map((row) => row.id);

const allPassed = (gates) => ({
  results: Object.fromEntries(
    gates.map((gate) => [
      gate,
      Object.fromEntries(
        CASES.map((scenario) => [scenario, { result: "passed" }]),
      ),
    ]),
  ),
});
const GATES = ["project", "source", "preview", "export", "import", "bundle"];

test("attributes each row to the gates its actions reach", () => {
  assert.deepEqual(gatesOf("module.projects"), ["project", "source"]);
  assert.deepEqual(gatesOf("readme.timeline-editing.1"), [
    "project",
    "source",
    "preview",
    "export",
  ]);
  assert.deepEqual(gatesOf("module.media-library"), [
    "project",
    "source",
    "preview",
    "export",
    "import",
  ]);
  assert.deepEqual(gatesOf("module.project-bundle"), [
    "project",
    "source",
    "bundle",
  ]);
});

test("puts every conformance row in exactly one entry", () => {
  const { commands } = buildReport(rowIds, allPassed(GATES));
  const seen = commands.flatMap(({ manifestIds }) => manifestIds);
  assert.equal(seen.length, rowIds.length);
  assert.equal(new Set(seen).size, rowIds.length);
  for (const { cases } of commands) {
    assert.deepEqual(
      cases.map(({ case: scenario }) => scenario),
      CASES,
    );
  }
});

test("passes a case for an entry only when every gate of it passed", () => {
  const measured = allPassed(GATES);
  measured.results.preview.viewer = { result: "failed", reason: "leaked" };
  const { commands } = buildReport(rowIds, measured);
  const rendering = commands.find(
    ({ id }) => id === "authz.project+source+preview+export",
  );
  const nonRendering = commands.find(({ id }) => id === "authz.project+source");
  const viewerOf = (entry) =>
    entry.cases.find(({ case: scenario }) => scenario === "viewer");
  assert.equal(viewerOf(rendering).result, "failed");
  assert.match(viewerOf(rendering).reason, /preview: leaked/);
  // a row that never reaches preview is not held back by it
  assert.equal(viewerOf(nonRendering).result, "passed");
});

test("treats a gate that was never measured as failed", () => {
  const measured = allPassed(["project", "source", "preview", "export"]);
  const { commands } = buildReport(["module.media-library"], measured);
  assert.equal(commands[0].cases[0].result, "failed");
  assert.match(commands[0].cases[0].reason, /import: not measured/);
});
