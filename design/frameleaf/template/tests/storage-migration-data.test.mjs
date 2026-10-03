import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STORAGE_MIGRATION_STAGES,
  advanceStorageMigrationDemo,
  createStorageMigrationDemo,
  formatTimeLeft,
  storageMigrationView,
} from "../src/storage-migration-data.mjs";

const finish = (status) => {
  let next = status;
  for (let step = 0; step < 500 && next.stage !== "done"; step++) {
    next = advanceStorageMigrationDemo(next, 1000);
  }
  return next;
};

test("the four stages are named the way the spec lists them", () => {
  assert.deepEqual(
    STORAGE_MIGRATION_STAGES.map(({ id, title }) => [id, title]),
    [
      ["checking", "Checking files"],
      ["relinking", "Relinking missing files"],
      ["linking", "Linking duplicate groups"],
      ["trashing", "Moving extra copies to the file trash"],
    ],
  );
});

test("a running migration shows X of Y for the current stage and no Continue", () => {
  const view = storageMigrationView(createStorageMigrationDemo());
  assert.equal(view.kind, "working");
  assert.equal(view.canContinue, false);
  assert.deepEqual(
    view.tasks.map(({ id, status }) => [id, status]),
    [
      ["checking", "running"],
      ["relinking", "queued"],
      ["linking", "queued"],
      ["trashing", "queued"],
    ],
  );
  assert.equal(view.tasks[0].progressLabel, "0 of 48,210");
  assert.equal(view.percent, 0);
});

test("progress moves forward stage by stage and never back", () => {
  let status = createStorageMigrationDemo();
  let percent = 0;
  for (let step = 0; step < 80; step++) {
    status = advanceStorageMigrationDemo(status, 1000);
    const view = storageMigrationView(status);
    assert.ok(view.percent >= percent, `percent went back at step ${step}`);
    percent = view.percent;
  }
  assert.ok(percent > 0);
});

test("relinking reports how many were relinked and how many are left to review", () => {
  const status = {
    ...createStorageMigrationDemo(),
    stage: "relinking",
    relinked: 7,
    toReview: 2,
  };
  const view = storageMigrationView(status);
  assert.equal(view.relinkLine, "7 relinked, 2 to review");
  assert.equal(view.tasks[0].status, "done");
  assert.equal(view.tasks[1].status, "running");
});

test("space freed and time left come from the status", () => {
  const view = storageMigrationView({
    ...createStorageMigrationDemo(),
    stage: "linking",
    bytesFreed: 3.5 * 1024 ** 3,
    estimatedSecondsLeft: 4 * 60 + 10,
  });
  assert.equal(view.freedLabel, "3.5 GB");
  assert.equal(view.timeLeftLabel, "About 5 minutes left");
});

test("finishing without findings reads Done", () => {
  const view = storageMigrationView(finish(createStorageMigrationDemo({ toReview: 0 })));
  assert.equal(view.kind, "done");
  assert.equal(view.title, "Done");
  assert.equal(view.canContinue, true);
  assert.equal(view.percent, 100);
});

test("finishing with findings points to Library Care", () => {
  const view = storageMigrationView(finish(createStorageMigrationDemo({ toReview: 3 })));
  assert.equal(view.kind, "review");
  assert.equal(view.title, "Finished with 3 files to review in Library Care");
  assert.equal(view.canContinue, true);
});

test("a migration sent to the background is no longer waited for", () => {
  const view = storageMigrationView({ ...createStorageMigrationDemo(), background: true });
  assert.equal(view.kind, "background");
  assert.equal(view.canContinue, true);
});

test("time left reads plainly", () => {
  assert.equal(formatTimeLeft(null), null);
  assert.equal(formatTimeLeft(20), "Less than a minute left");
  assert.equal(formatTimeLeft(90), "About 2 minutes left");
  assert.equal(formatTimeLeft(2 * 3600 + 600), "About 2 hours 10 minutes left");
});
