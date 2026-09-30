import assert from "node:assert/strict";
import test from "node:test";
import {
  sampleRawFiles,
  repairableRawIds,
  advanceRawRepair,
  repairRawFiles,
} from "../src/raw-library.mjs";

test("RAW repair preserves identity and unrelated failures, and can pause and resume", () => {
  const original = structuredClone(sampleRawFiles);
  const ids = repairableRawIds(original);
  const paused = { status: "paused", completed: 0, total: ids.length };
  assert.deepEqual(advanceRawRepair(paused), paused);
  let job = { ...paused, status: "running" };
  while (job.status === "running") job = advanceRawRepair(job);
  assert.equal(job.completed, ids.length);
  const repaired = repairRawFiles(original, ids);
  assert.deepEqual(
    repaired.map(({ id, name }) => ({ id, name })),
    original.map(({ id, name }) => ({ id, name })),
  );
  assert.equal(
    repaired.find(({ status }) => status === "unsupported").id,
    "raw-04",
  );
  assert.equal(original.find(({ id }) => id === "raw-02").status, "preview");
  assert.equal(
    repaired.find(({ id }) => id === "raw-02").source,
    "Sensor render",
  );
  const first = advanceRawRepair({
    ids: ["raw-02"],
    total: 1,
    completed: 0,
    status: "running",
  });
  const second = advanceRawRepair({
    ...first,
    ids: ["raw-03"],
    completed: 0,
    status: "running",
  });
  const reopened = repairRawFiles(sampleRawFiles, second.repairedIds);
  assert.equal(
    reopened.find(({ id }) => id === "raw-02").status,
    "ready",
    "a later repair retains earlier successful files",
  );
  assert.equal(reopened.find(({ id }) => id === "raw-03").status, "ready");
});
