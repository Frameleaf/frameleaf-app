import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARTNER_SHARED_ITEMS,
  backfillProgress,
  originLabel,
  parseOrigin,
} from "../src/partner-sharing.mjs";

test("partner sharing lists everything a partner receives", () => {
  assert.deepEqual(
    PARTNER_SHARED_ITEMS.map((item) => item.label),
    [
      "Photos and videos",
      "Albums you own",
      "Tags",
      "People",
      "Descriptions and locations",
      "Locked items",
    ],
  );
  for (const item of PARTNER_SHARED_ITEMS) assert.match(item.icon, /^mdi/);
});

test("backfill progress reports copying, done, waiting and stopped states", () => {
  assert.deepEqual(backfillProgress({ state: "running", total: 3000, done: 1240 }), {
    state: "running",
    percent: 41,
    label: "Copying 1,240 of 3,000 items",
  });
  assert.deepEqual(backfillProgress({ state: "done", total: 3000, done: 3000 }), {
    state: "done",
    percent: 100,
    label: "Up to date · 3,000 items copied",
  });
  assert.deepEqual(backfillProgress({ state: "queued", total: 0, done: 0 }), {
    state: "queued",
    percent: 0,
    label: "Waiting to start",
  });
  assert.deepEqual(backfillProgress({ state: "stopped", total: 10, done: 4 }), {
    state: "stopped",
    percent: 40,
    label: "Stopped · 4 items already copied stay in their library",
  });
  assert.equal(backfillProgress(null), null);
  // Totals can lag behind while the cursor walks; never exceed 100%.
  assert.equal(backfillProgress({ state: "running", total: 5, done: 9 }).percent, 100);
  assert.equal(backfillProgress({ state: "bogus", total: 5, done: 1 }).state, "queued");
});

test("origin label names the original library owner", () => {
  const users = [{ id: "jamie", name: "Jamie" }, { id: "chris", name: "Chris" }];
  assert.equal(originLabel({ rootOwnerId: "jamie" }, users), "From Jamie’s library");
  assert.equal(originLabel({ rootOwnerName: "Chris" }), "From Chris’ library");
  assert.equal(originLabel({ rootOwnerId: "sam" }), "From Sam’s library");
  assert.equal(originLabel(null), null);
  assert.equal(originLabel({}), null);
});

test("parseOrigin keeps only a valid owner reference", () => {
  assert.deepEqual(parseOrigin({ rootOwnerId: " jamie ", extra: 1 }), { rootOwnerId: "jamie" });
  assert.equal(parseOrigin({ rootOwnerId: "" }), null);
  assert.equal(parseOrigin("jamie"), null);
  assert.equal(parseOrigin(undefined), null);
});
