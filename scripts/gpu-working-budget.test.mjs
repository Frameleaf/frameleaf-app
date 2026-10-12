import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGpuWorkingBudget } from "../server/src/utils/gpu-working-budget.ts";

// Synthetic contract data: these hashes do not qualify a GPU or approve a workload profile.
const evidence = {
  metric: "measured-usable-gpu-working-budget-v1",
  profileDigest: "a".repeat(64),
  measurementId: "11111111-1111-4111-8111-111111111111",
  receiptDigest: "b".repeat(64),
  workerId: "0195e2a0-0000-7000-8000-00000000aaa1",
  engineDigest: "sha256:engine",
  buildDigest: "c".repeat(64),
  browserIdentity: "reviewed-browser-build",
  deviceLifetimeId: "22222222-2222-4222-8222-222222222222",
  bindingMethod: "same-export-device",
  topology: "unknown",
  topologyEvidenceDigest: null,
  hardwareBackend: "hardware",
  encoderEvidenceDigest: "d".repeat(64),
  pressureEnvelopeDigest: "e".repeat(64),
  outputReceiptDigest: "f".repeat(64),
  measuredBytes: "2147483648",
  headroomBytes: "536870912",
  completedAt: "2026-10-12T00:00:00.000Z",
  validUntil: "2026-10-12T00:01:00.000Z",
  status: "passed",
};
const context = {
  workerId: evidence.workerId,
  engineDigest: evidence.engineDigest,
  buildDigest: evidence.buildDigest,
  browserIdentity: evidence.browserIdentity,
  deviceLifetimeId: evidence.deviceLifetimeId,
  approvedProfileDigest: evidence.profileDigest,
  reportedBytes: "2147483648",
  administratorCeiling: null,
  phase: { kind: "admission" },
  now: new Date("2026-10-12T00:00:30.000Z"),
  conformanceExpiresAt: new Date("2026-10-12T00:02:00.000Z"),
  credentialExpiresAt: new Date("2026-10-12T00:03:00.000Z"),
};
const evaluate = (change = {}, policy = {}) =>
  evaluateGpuWorkingBudget(
    { ...evidence, ...change },
    { ...context, ...policy },
  );
const success = (
  qualifiedBytes = "2147483648",
  expiresAt = "2026-10-12T00:01:00.000Z",
) => ({
  valid: true,
  measuredBytes: "2147483648",
  qualifiedBytes,
  expiresAt,
});

test("canonical quantities, digests and UUIDs reject trailing line terminators", () => {
  for (const suffix of ["\n", "\r", "\r\n"]) {
    assert.equal(
      evaluate({}, { administratorCeiling: `1${suffix}` }).valid,
      false,
    );
    for (const key of [
      "profileDigest",
      "receiptDigest",
      "buildDigest",
      "encoderEvidenceDigest",
      "pressureEnvelopeDigest",
      "outputReceiptDigest",
      "measurementId",
      "workerId",
      "deviceLifetimeId",
    ]) {
      const value = evidence[key] + suffix;
      assert.equal(evaluate({ [key]: value }).valid, false);
    }
  }
});

test("preserves measured bytes when no administrator ceiling exists", () => {
  assert.deepEqual(evaluate(), success());
});

test("an administrator ceiling restricts Q without rewriting raw M", () => {
  assert.deepEqual(
    evaluate({}, { administratorCeiling: "1073741824" }),
    success("1073741824"),
  );
  assert.deepEqual(evaluate({}, { administratorCeiling: "0" }), success("0"));
  assert.deepEqual(
    evaluate({}, { administratorCeiling: "9007199254740993" }),
    success(),
  );
  assert.deepEqual(
    evaluate({}, { administratorCeiling: "9223372036854775807" }),
    success(),
  );
});

test("a later administrator increase cannot widen the admitted session budget", () => {
  assert.deepEqual(
    evaluate(
      {},
      { phase: { kind: "session", admittedBudgetBytes: "1073741824" } },
    ),
    success("1073741824"),
  );
  assert.deepEqual(
    evaluate(
      {},
      {
        phase: { kind: "session", admittedBudgetBytes: "1073741824" },
        administratorCeiling: "536870912",
      },
    ),
    success("536870912"),
  );
});

test("a session with absent or contradictory persisted Q stays unqualified", () => {
  for (const admittedBudgetBytes of [null, undefined, "2147483649"]) {
    assert.equal(
      evaluate({}, { phase: { kind: "session", admittedBudgetBytes } }).valid,
      false,
    );
  }
  for (const phase of [null, {}, { kind: "unknown" }]) {
    assert.equal(evaluate({}, { phase }).valid, false);
  }
});

test("missing evidence or measurement never inherits an administrator amount", () => {
  for (const missing of [null, undefined, {}, [], "2147483648"]) {
    assert.equal(
      evaluateGpuWorkingBudget(missing, {
        ...context,
        administratorCeiling: "8589934592",
      }).valid,
      false,
    );
  }
  assert.equal(
    evaluate({}, { reportedBytes: null, administratorCeiling: "8589934592" })
      .valid,
    false,
  );
});

test("missing approval or a different profile cannot create qualification", () => {
  assert.equal(evaluate({}, { approvedProfileDigest: null }).valid, false);
  assert.equal(evaluate({ profileDigest: "0".repeat(64) }).valid, false);
  assert.equal(evaluate({ metric: "nominal-vram" }).valid, false);
});

test("changed owner, engine, build, browser or live device generation invalidates the receipt", () => {
  for (const field of [
    "workerId",
    "engineDigest",
    "buildDigest",
    "browserIdentity",
    "deviceLifetimeId",
  ]) {
    assert.equal(evaluate({}, { [field]: "different" }).valid, false, field);
  }
});

test("the canonical opaque engine identity is bounded and must match the pinned owner identity", () => {
  assert.deepEqual(evaluate(), success());
  for (const engineDigest of [" engine", "engine ", "", "x".repeat(201)]) {
    assert.equal(evaluate({ engineDigest }, { engineDigest }).valid, false);
  }
  assert.equal(evaluate({ engineDigest: "unapproved-engine" }).valid, false);
});

test("only the reviewed same-device hardware binding and final successful status are representable", () => {
  for (const change of [
    { bindingMethod: "equal-model" },
    { hardwareBackend: "software" },
    { status: "partial" },
    { measuredBytes: "2147483647" },
    { headroomBytes: "536870911" },
  ]) {
    assert.equal(evaluate(change).valid, false);
  }
});

test("topology stays unknown without bound evidence and never defaults to dedicated", () => {
  assert.deepEqual(evaluate(), success());
  for (const topology of ["unified", "dedicated"]) {
    assert.equal(evaluate({ topology }).valid, false);
    assert.deepEqual(
      evaluate({ topology, topologyEvidenceDigest: "0".repeat(64) }),
      success(),
    );
  }
  assert.equal(
    evaluate({ topology: "unknown", topologyEvidenceDigest: "0".repeat(64) })
      .valid,
    false,
  );
  assert.equal(evaluate({ topology: "inferred" }).valid, false);
});

test("every provenance field is required and newer unknown fields do not silently downgrade", () => {
  for (const field of Object.keys(evidence)) {
    const incomplete = { ...evidence };
    delete incomplete[field];
    assert.equal(
      evaluateGpuWorkingBudget(incomplete, context).valid,
      false,
      field,
    );
  }
  assert.equal(evaluate({ ignoredNewMetric: true }).valid, false);
});

test("malformed quantities cannot round, wrap or parse into a qualifying value", () => {
  for (const quantity of [
    "-1",
    "+2147483648",
    "2.147483648e9",
    "2147483648.0",
    " 2147483648",
    "2147483648 ",
    "02147483648",
    "",
    "9223372036854775808",
    "9".repeat(200),
    2147483648,
    NaN,
    Infinity,
  ]) {
    assert.equal(evaluate({ measuredBytes: quantity }).valid, false);
    assert.equal(evaluate({ headroomBytes: quantity }).valid, false);
    assert.equal(evaluate({}, { reportedBytes: quantity }).valid, false);
    assert.equal(evaluate({}, { administratorCeiling: quantity }).valid, false);
    assert.equal(
      evaluate(
        {},
        { phase: { kind: "session", admittedBudgetBytes: quantity } },
      ).valid,
      false,
    );
  }
});

test("corrupt digests, identifiers or empty identity strings refuse", () => {
  for (const field of [
    "profileDigest",
    "receiptDigest",
    "buildDigest",
    "encoderEvidenceDigest",
    "pressureEnvelopeDigest",
    "outputReceiptDigest",
  ]) {
    assert.equal(evaluate({ [field]: "A".repeat(64) }).valid, false, field);
    assert.equal(evaluate({ [field]: "a".repeat(63) }).valid, false, field);
  }
  for (const field of [
    "measurementId",
    "workerId",
    "deviceLifetimeId",
    "engineDigest",
    "browserIdentity",
  ]) {
    assert.equal(evaluate({ [field]: "" }).valid, false, field);
  }
});

test("a measurement expires at its deadline and may not claim more than sixty seconds", () => {
  assert.deepEqual(
    evaluate({}, { now: new Date("2026-10-12T00:00:59.999Z") }),
    success(),
  );
  assert.equal(
    evaluate({}, { now: new Date("2026-10-12T00:01:00.000Z") }).valid,
    false,
  );
  assert.equal(
    evaluate({ validUntil: "2026-10-12T00:01:00.001Z" }).valid,
    false,
  );
  assert.equal(
    evaluate({ completedAt: "2026-10-12T00:00:30.001Z" }).valid,
    false,
  );
  assert.equal(evaluate({ validUntil: evidence.completedAt }).valid, false);
});

test("invalid and noncanonical times cannot bypass freshness", () => {
  for (const time of [
    "invalid",
    "2026-10-12",
    "2026-10-12T00:00:00+00:00",
    "2026-02-30T00:00:00.000Z",
    null,
  ]) {
    assert.equal(evaluate({ completedAt: time }).valid, false);
    assert.equal(evaluate({ validUntil: time }).valid, false);
  }
  for (const field of ["now", "conformanceExpiresAt", "credentialExpiresAt"]) {
    assert.equal(evaluate({}, { [field]: new Date(NaN) }).valid, false, field);
  }
});

test("conformance and credential deadlines independently shorten qualification", () => {
  for (const field of ["conformanceExpiresAt", "credentialExpiresAt"]) {
    assert.equal(evaluate({}, { [field]: context.now }).valid, false, field);
    assert.deepEqual(
      evaluate({}, { [field]: new Date("2026-10-12T00:00:45.000Z") }),
      success("2147483648", "2026-10-12T00:00:45.000Z"),
    );
  }
});
