import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import cases from "../server/test/assistant-eval/cases.json" with { type: "json" };
import library from "../server/test/assistant-eval/library.json" with { type: "json" };
import { verifyQualification } from "./assistant-qualification.mjs";

const source = "f".repeat(40);
const workerModel = "fixture-model";
const report = {
  workerModel,
  source,
  mode: "qualification",
  cases: cases.length,
  assets: library.length,
  corpusDigest: createHash("sha256")
    .update(JSON.stringify([cases, library]))
    .digest("hex"),
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
    cases: cases.length - 1,
    assets: library.length - 1,
    corpusDigest: "0".repeat(64),
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

test("rejects substituted corpus sizes even when they clear the minimum", () => {
  for (const [field, value] of Object.entries({
    cases: cases.length + 1,
    assets: library.length + 1,
  })) {
    assert.throws(
      () =>
        verifyQualification({ ...report, [field]: value }, source, workerModel),
      new RegExp(field),
    );
  }
});
