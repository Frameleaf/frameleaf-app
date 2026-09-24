import assert from "node:assert/strict";
import { test } from "node:test";
import { isCompareKey } from "../src/develop.mjs";

test("backslash and Y hold the original", () => {
  assert.equal(isCompareKey({ key: "\\", code: "Backslash" }), true);
  assert.equal(isCompareKey({ key: "#", code: "Backslash" }), true);
  assert.equal(isCompareKey({ key: "y", code: "KeyY" }), true);
  assert.equal(isCompareKey({ key: "Y", code: "KeyY" }), true);
});

test("compare does not claim other editor keys or M", () => {
  for (const key of ["m", "M", "i", "o", " ", "Escape", "ArrowLeft"]) {
    assert.equal(isCompareKey({ key, code: "" }), false, key);
  }
  assert.equal(isCompareKey(undefined), false);
});

test("modified presses are not a compare, but releases always are", () => {
  assert.equal(isCompareKey({ key: "\\", metaKey: true }), false);
  assert.equal(isCompareKey({ key: "y", ctrlKey: true }), false);
  assert.equal(isCompareKey({ key: "\\", altKey: true }), false);
  assert.equal(
    isCompareKey({ key: "\\", metaKey: true }, { release: true }),
    true,
  );
});
