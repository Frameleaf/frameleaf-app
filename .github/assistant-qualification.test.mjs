import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyQualification } from "./assistant-qualification.mjs";

const source = "f".repeat(40);
const workerModel = "fixture-model";
const report = {
  workerModel,
  source,
  mode: "qualification",
  cases: 213,
  assets: 300,
  plannerAnswers: 201,
  protectedHits: 0,
  filterAccuracy: 0.85,
  recallAt24: 0.8,
  faithfulness: 1,
  p95Ms: 6000,
};

test("accepts a passing live Assistant report for the candidate source", () => {
  assert.doesNotThrow(() => verifyQualification(report, source, workerModel));
});

test("rejects stale reports and measurements from other modes", () => {
  assert.throws(
    () => verifyQualification(report, "a".repeat(40), workerModel),
    /source/,
  );
  for (const mode of ["assistant", "live", "replay", "baseline"]) {
    assert.throws(
      () => verifyQualification({ ...report, mode }, source, workerModel),
      /mode/,
    );
  }
});

test("rejects incomplete, private, rules-only and below-threshold results", () => {
  for (const [field, value] of Object.entries({
    workerModel: "different-fixture-model",
    cases: 199,
    assets: 299,
    plannerAnswers: 0,
    protectedHits: 1,
    filterAccuracy: 0.849,
    recallAt24: 0.799,
    faithfulness: 0.999,
    p95Ms: 6001,
  })) {
    assert.throws(
      () =>
        verifyQualification({ ...report, [field]: value }, source, workerModel),
      new RegExp(field),
    );
  }
});
