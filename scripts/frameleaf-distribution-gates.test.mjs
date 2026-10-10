import assert from "node:assert/strict";
import test from "node:test";
import {
  validateGates,
  validateCoverage,
} from "./frameleaf-distribution-gates.mjs";

const baseGate = () => ({
  id: "example-gate",
  area: "cloud",
  component: "example component",
  description: "an example gate",
  status: "blocked-on-owner",
  owner: null,
  reason: "needs the owner",
});

test("accepts a well-formed manifest", () => {
  const gates = validateGates({ schemaVersion: 1, gates: [baseGate()] });
  assert.equal(gates.length, 1);
});

test("rejects the wrong schema version", () => {
  assert.throws(
    () => validateGates({ schemaVersion: 2, gates: [baseGate()] }),
    /schemaVersion must be 1/,
  );
});

test("rejects an empty gate list", () => {
  assert.throws(
    () => validateGates({ schemaVersion: 1, gates: [] }),
    /non-empty array/,
  );
});

test("rejects a duplicate id", () => {
  assert.throws(
    () => validateGates({ schemaVersion: 1, gates: [baseGate(), baseGate()] }),
    /duplicate gate id/,
  );
});

test("rejects a native/mobile area", () => {
  assert.throws(
    () =>
      validateGates({
        schemaVersion: 1,
        gates: [{ ...baseGate(), area: "native" }],
      }),
    /out of scope/,
  );
});

test("rejects a blocked-on-owner gate that names an owner", () => {
  assert.throws(
    () =>
      validateGates({
        schemaVersion: 1,
        gates: [{ ...baseGate(), owner: "Someone" }],
      }),
    /names an owner/,
  );
});

test("rejects a cleared gate with no owner", () => {
  assert.throws(
    () =>
      validateGates({
        schemaVersion: 1,
        gates: [{ ...baseGate(), status: "cleared", owner: null }],
      }),
    /must name the owner/,
  );
});

test("rejects a gate value that looks like a live secret", () => {
  assert.throws(
    () =>
      validateGates({
        schemaVersion: 1,
        gates: [{ ...baseGate(), reason: "token AKIAABCDEFGHIJKLMNOP leaked" }],
      }),
    /looks like a live secret/,
  );
});

test("flags a blocked embedded component with no matching gate", () => {
  const gates = [baseGate()];
  const attribution = {
    embeddedComponents: [
      {
        id: "lame",
        package: "@mediabunny/mp3-encoder",
        rightsStatus: "blocked",
      },
    ],
  };
  assert.throws(() => validateCoverage(gates, attribution), /lame/);
});

test("passes when the blocked embedded component is named in a gate", () => {
  const gates = [
    {
      ...baseGate(),
      id: "dolby-tool-admission",
      component: "lame (@mediabunny/mp3-encoder)",
    },
  ];
  const attribution = {
    embeddedComponents: [
      {
        id: "lame",
        package: "@mediabunny/mp3-encoder",
        rightsStatus: "blocked",
      },
    ],
    dolbyTools: { included: false },
  };
  assert.doesNotThrow(() => validateCoverage(gates, attribution));
});

test("blocked components require an open gate with their exact identifier", () => {
  const attribution = {
    embeddedComponents: [
      {
        id: "lame",
        package: "@mediabunny/mp3-encoder",
        rightsStatus: "blocked",
      },
    ],
    dolbyTools: { included: false },
  };
  for (const gate of [
    { ...baseGate(), component: "lame", status: "cleared", owner: "Owner" },
    { ...baseGate(), component: "not-lame" },
  ]) {
    assert.throws(
      () =>
        validateCoverage(
          [{ ...baseGate(), id: "dolby-tool-admission" }, gate],
          attribution,
        ),
      /blocked embedded component\(s\) with no open gate: lame/,
    );
  }
});

test("ignores an embedded component whose rights are allowed", () => {
  const gates = [{ ...baseGate(), id: "dolby-tool-admission" }];
  const attribution = {
    embeddedComponents: [
      {
        id: "lame",
        package: "@mediabunny/mp3-encoder",
        rightsStatus: "allowed",
      },
    ],
    dolbyTools: { included: false },
  };
  assert.doesNotThrow(() => validateCoverage(gates, attribution));
});

test("fails when the Dolby admission gate is missing", () => {
  const gates = [{ ...baseGate(), id: "something-else" }];
  const attribution = {
    embeddedComponents: [],
    dolbyTools: { included: false },
  };
  assert.throws(
    () => validateCoverage(gates, attribution),
    /Dolby tool admission gate/,
  );
});
