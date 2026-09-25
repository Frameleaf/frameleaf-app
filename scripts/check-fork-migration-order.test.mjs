import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkForkManifest,
  checkOrder,
} from "./check-fork-migration-order.mjs";

const upstream = new Set(["100-upstream", "101-upstream", "102-upstream"]);
const base = ["100-upstream", "200-fork"];

test("permits upstream and fork appends without renumbering", () => {
  checkOrder(
    base,
    ["100-upstream", "101-upstream", "200-fork", "201-fork"],
    upstream,
  );
});
test("rejects removal or reordering in either authority", () => {
  for (const current of [
    [],
    ["100-upstream"],
    ["101-upstream", "100-upstream", "200-fork"],
    ["100-upstream", "201-fork", "200-fork"],
  ]) {
    assert.throws(() => checkOrder(base, current, upstream));
  }
});

test("fork-schema manifest: appends after released migrations only", () => {
  const released = ["0000000000191-a", "0000000000201-b"];
  checkForkManifest(released, [...released, "0000000000202-c"]);
  checkForkManifest([], released);
  assert.throws(() =>
    checkForkManifest(released, [
      "0000000000191-a",
      "0000000000190-x",
      "0000000000201-b",
    ]),
  );
  assert.throws(() =>
    checkForkManifest(released, [...released, "0000000000190-late"]),
  );
  assert.throws(() => checkForkManifest(released, ["0000000000191-a"]));
});
