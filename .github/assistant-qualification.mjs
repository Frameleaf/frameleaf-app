import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import thresholds from "../server/test/assistant-eval/thresholds.json" with { type: "json" };

export function verifyQualification(report, source, workerModel) {
  assert.match(source, /^[a-f0-9]{40}$/, "Expected a candidate source SHA");
  assert.equal(
    report.source,
    source,
    "Assistant qualification source mismatch",
  );
  assert.equal(
    report.mode,
    "qualification",
    "Assistant qualification mode mismatch",
  );
  assert(
    typeof workerModel === "string" && workerModel.length > 0,
    "Expected a pinned workerModel",
  );
  assert.equal(
    report.workerModel,
    workerModel,
    "Assistant qualification workerModel mismatch",
  );
  assert(
    Number.isInteger(report.cases) && report.cases >= 200,
    "Incomplete cases",
  );
  assert(
    Number.isInteger(report.assets) && report.assets >= 300,
    "Incomplete assets",
  );
  assert(
    Number.isInteger(report.plannerAnswers) &&
      report.plannerAnswers >=
        Math.ceil(report.cases * thresholds.filterAccuracy) &&
      report.plannerAnswers <= report.cases,
    "Insufficient plannerAnswers",
  );
  assert.equal(
    report.protectedHits,
    0,
    "Assistant qualification found protectedHits",
  );
  for (const field of ["filterAccuracy", "recallAt24", "faithfulness"]) {
    assert(
      report[field] >= thresholds[field] &&
        report[field] <= 1 &&
        typeof report[field] === "number",
      field,
    );
  }
  assert(
    typeof report.p95Ms === "number" &&
      report.p95Ms >= 0 &&
      report.p95Ms <= thresholds.p95Ms,
    "p95Ms",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , reportPath, source] = process.argv;
  assert.match(source, /^[a-f0-9]{40}$/, "Expected a candidate source SHA");
  const manifest = JSON.parse(
    execFileSync(
      "git",
      [
        "show",
        `${source}:machine-learning/frameleaf_ml/models/assistant-planner-models.json`,
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      },
    ),
  );
  const defaults = manifest.filter((entry) => entry.default);
  assert.equal(
    defaults.length,
    1,
    "The candidate must pin one default Assistant planner",
  );
  verifyQualification(
    JSON.parse(readFileSync(reportPath, "utf8")),
    source,
    defaults[0].name,
  );
}
