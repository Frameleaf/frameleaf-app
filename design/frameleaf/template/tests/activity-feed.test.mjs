import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTERS,
  START_SECONDS,
  advanceBackgroundQueues,
  advanceJobs,
  cloudStartNote,
  groupJobs,
  itemsProgress,
  jobStatusLine,
  matchesFilter,
  progressLabel,
  queuePositions,
  resumeStatus,
  stageAnnouncements,
  stageOf,
  stepLabel,
  summariseBackgroundQueues,
  summariseCloudWork,
  summariseUploads,
} from "../src/activity-feed.mjs";
import { createJobsState } from "../src/jobs-data.mjs";
import { cloudJobs, createCloudState } from "../src/frameleaf-cloud-data.mjs";

const job = (id, patch = {}) => ({ id, kind: "Export", name: `Clip ${id}`, destination: "local", status: "queued", progress: 0, ...patch });
const run = (jobs, seconds) => {
  let current = jobs;
  const seen = [];
  for (let n = 0; n < seconds; n += 1) {
    current = advanceJobs(current, n * 1000);
    seen.push(current.map((item) => item.status));
  }
  return { current, seen };
};

test("stored statuses map to the stages people see", () => {
  assert.deepEqual(
    ["queued", "preparing", "rendering", "validating", "paused", "completed", "failed", "cancelled"].map(stageOf),
    ["queued", "starting", "running", "running", "paused", "done", "failed", "cancelled"],
  );
  assert.equal(stepLabel(job("a", { status: "rendering" })), "Rendering");
  assert.equal(stepLabel(job("a", { status: "validating" })), "Checking output");
  assert.equal(stepLabel(job("a", { kind: "Upscale", status: "rendering" })), "Upscaling");
});

test("a local job passes Queued → Starting → Running → Done", () => {
  const { current, seen } = run([job("a")], 40);
  const order = [...new Set(seen.map(([status]) => status))];
  assert.deepEqual(order, ["queued", "preparing", "rendering", "validating", "completed"]);
  assert.equal(seen.filter(([status]) => status === "preparing").length, START_SECONDS.local);
  assert.equal(current[0].progress, 100);
});

test("cloud jobs start slower than local ones", () => {
  const { seen } = run([job("c", { destination: "cloud" })], 20);
  assert.equal(seen.filter(([status]) => status === "preparing").length, START_SECONDS.cloud);
  assert.ok(START_SECONDS.cloud > START_SECONDS.local);
});

test("a second job of the same kind waits its turn; other kinds run alongside", () => {
  // Newest first, as the app stores them.
  const jobs = [job("up", { kind: "Upscale" }), job("second"), job("first")];
  const positions = queuePositions(jobs);
  assert.equal(positions.get("first"), 0);
  assert.equal(positions.get("second"), 1);
  assert.equal(positions.get("up"), 0);
  const { seen } = run(jobs, 4);
  const [up, second, first] = seen.at(-1);
  assert.equal(first, "preparing");
  assert.equal(up, "preparing");
  assert.equal(second, "queued");
  assert.equal(queuePositions(advanceJobs(advanceJobs(jobs))).get("second"), 1);
});

test("advance returns the same list when nothing moves", () => {
  const jobs = [job("a", { status: "completed", progress: 100 }), job("b", { status: "paused", progress: 30 })];
  assert.equal(advanceJobs(jobs), jobs);
  assert.equal(resumeStatus(jobs[1]), "rendering");
  assert.equal(resumeStatus(job("c", { status: "paused" })), "queued");
});

test("status lines spell out the stage, position, step, items and time left", () => {
  assert.equal(jobStatusLine(job("a"), { ahead: 2 }), "Waiting for its turn · 2 ahead");
  assert.equal(jobStatusLine(job("a"), { ahead: 0 }), "Waiting for its turn · next up");
  assert.equal(jobStatusLine(job("a", { status: "preparing" })), "Starting on this server");
  assert.equal(
    jobStatusLine(job("a", { status: "preparing", destination: "cloud" })),
    "Starting a Frameleaf Cloud worker · loading the model",
  );
  assert.equal(
    jobStatusLine(job("a", { status: "rendering", progress: 50 }), { durationSeconds: 30 }),
    "Rendering · 50% · 15 s of 30 s · about 6 s left",
  );
  const items = job("b", { kind: "Upscale", status: "rendering", progress: 50, cloud: { quantity: 6, quantityLabel: "6 items" } });
  assert.deepEqual(itemsProgress(items), { done: 3, total: 6, unit: "items" });
  assert.match(jobStatusLine(items), /^Upscaling · 50% · 3 of 6 items · about 10 s left$/);
  assert.equal(jobStatusLine(job("a", { status: "rendering", progress: 40 }), { online: false }), "Waiting for connection · 40%");
  assert.equal(jobStatusLine(job("a", { status: "failed", error: "Out of memory" })), "Failed · Out of memory");
  assert.match(cloudStartNote(job("c", { destination: "cloud", cloud: { startFee: 0.2, workers: 1 } })), /\$0\.20 start fee/);
  assert.equal(cloudStartNote(job("a")), "");
});

test("grouping and filters count every stage", () => {
  const jobs = [
    job("q"),
    job("s", { status: "preparing" }),
    job("r", { status: "rendering", progress: 20 }),
    job("v", { status: "validating", progress: 90 }),
    job("p", { status: "paused", progress: 10 }),
    job("d", { status: "completed", progress: 100 }),
    job("f", { status: "failed" }),
    job("x", { status: "cancelled" }),
  ];
  const { groups, recent, counts, filterCounts } = groupJobs(jobs);
  assert.deepEqual(groups.running.map((item) => item.id), ["v", "r"]);
  assert.deepEqual(recent.map((item) => item.id), ["d", "f", "x"]);
  assert.deepEqual(
    { ...counts },
    { queued: 1, starting: 1, running: 2, paused: 1, done: 1, failed: 1, cancelled: 1, inProgress: 5 },
  );
  assert.deepEqual(FILTERS, ["All", "In progress", "Done", "Failed"]);
  assert.deepEqual(filterCounts, { All: 8, "In progress": 5, Done: 1, Failed: 2 });
  assert.equal(matchesFilter(jobs[4], "In progress"), true);
  assert.equal(matchesFilter(jobs[7], "Failed"), true);
  assert.equal(progressLabel(jobs), "4 jobs in progress · 1 queued, 1 starting, 2 running");
  assert.equal(progressLabel([jobs[5]]), "");
});

test("stage changes are announced in words", () => {
  const before = new Map([
    ["a", "queued"],
    ["b", "rendering"],
    ["c", "rendering"],
  ]);
  const after = [
    job("a", { status: "preparing", name: "Lake morning" }),
    job("b", { status: "validating" }),
    job("c", { status: "completed", name: "Lake morning" }),
    job("n", { kind: "Upscale", name: "Pier" }),
  ];
  assert.equal(
    stageAnnouncements(before, after),
    "Export of Lake morning is starting. Export of Lake morning finished. Upscale of Pier is queued.",
  );
  assert.equal(stageAnnouncements(new Map(), after), "");
});

test("background queues summarise busy work read-only and link to the Job manager", () => {
  const state = createJobsState();
  const rows = summariseBackgroundQueues(state);
  const thumbs = rows.find((row) => row.queueId === "thumbnailGeneration");
  assert.equal(thumbs.stage, "running");
  assert.equal(thumbs.running, 1);
  assert.equal(thumbs.waiting, 3);
  assert.match(thumbs.detail, /^Running · 3 waiting · 1 running · \d+%$/);
  assert.deepEqual(thumbs.target, { area: "processing", section: "queues", label: "Background work" });
  assert.equal(rows.find((row) => row.queueId === "mediaHealth").stage, "paused");
  assert.ok(!rows.some((row) => row.queueId === "sidecar"), "failed-only queues stay in the Job manager");

  const waitingOnly = {
    queues: {},
    jobs: [
      { id: "1", queueId: "library", status: "waiting", destination: "server", progress: 0 },
      { id: "2", queueId: "imageDescription", status: "active", destination: "cloud", progress: 40 },
      { id: "3", queueId: "imageDescription", status: "waiting", destination: "cloud", progress: 0 },
    ],
  };
  const [description, library] = summariseBackgroundQueues(waitingOnly).sort((a, b) => a.title.localeCompare(b.title));
  assert.equal(library.detail, "Queued · 1 waiting");
  assert.equal(library.title, "Library scan");
  assert.equal(description.title, "Descriptions & tags on Frameleaf Cloud");
  assert.equal(description.detail, "Running · 1 waiting · 1 running · 40%");
  assert.deepEqual(summariseBackgroundQueues(null), []);
});

test("cloud batches and backup runs appear only when the cloud state has them", () => {
  const cloud = createCloudState();
  assert.deepEqual(summariseCloudWork(cloud, cloudJobs), []);
  const on = { ...cloud, processing: { ...cloud.processing, enabled: true } };
  const [batch] = summariseCloudWork(on, cloudJobs);
  assert.equal(batch.title, "Enhance 6 prints");
  assert.equal(batch.detail, "Running · $1.12 held");
  const backup = {
    ...cloud,
    backup: { ...cloud.backup, configured: true, run: { status: "running", progress: 42 } },
  };
  const [row] = summariseCloudWork(backup, cloudJobs);
  assert.equal(row.title, "Cloud backup");
  assert.equal(row.detail, "Running · 42%");
  assert.equal(row.target.section, "cloud-backup");
});

test("a saved stage start time keeps a job's place after a reload", () => {
  const start = 1_000_000;
  const starting = job("s", { status: "preparing", stageStartedAt: start });
  assert.equal(advanceJobs([starting], start + 2000)[0].status, "preparing");
  assert.equal(advanceJobs([starting], start + START_SECONDS.local * 1000)[0].status, "rendering");
  const fresh = advanceJobs([job("q")], start)[0];
  assert.equal(fresh.stageStartedAt, start, "the first tick stamps a missing start time");
});

test("background queues move: progress rises, jobs finish and waiting ones start", () => {
  const base = {
    queues: { facialRecognition: { paused: false }, mediaHealth: { paused: true } },
    jobs: [
      { id: "a", queueId: "facialRecognition", status: "active", progress: 99, createdAt: "2026-09-19T13:00:00.000Z", updatedAt: "x" },
      { id: "b", queueId: "facialRecognition", status: "waiting", progress: 0, createdAt: "2026-09-19T13:01:00.000Z", updatedAt: "x" },
      { id: "c", queueId: "facialRecognition", status: "delayed", progress: 0, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "x" },
      { id: "p", queueId: "mediaHealth", status: "active", progress: 10, createdAt: "2026-09-19T13:00:00.000Z", updatedAt: "x" },
    ],
    revision: 7,
  };
  const now = Date.parse("2026-09-25T10:00:00Z");
  const next = advanceBackgroundQueues(base, now);
  const byId = Object.fromEntries(next.jobs.map((item) => [item.id, item]));
  assert.equal(byId.a.status, "completed");
  assert.equal(byId.b.status, "active", "waiting jobs start before delayed ones");
  assert.equal(byId.c.status, "delayed", "face recognition runs one at a time");
  assert.equal(byId.p.progress, 10, "paused queues stay still");
  assert.equal(next.revision, 7);
  const later = advanceBackgroundQueues(next, now + 1000);
  assert.ok(later.jobs.find((item) => item.id === "b").progress > 0);
  const idle = { queues: {}, jobs: [{ ...base.jobs[0], status: "completed", progress: 100 }] };
  assert.equal(advanceBackgroundQueues(idle, now), idle, "empty queues stop");
});

test("uploads from this browser show as one imports row", () => {
  assert.deepEqual(summariseUploads([{ status: "done", progress: 100 }]), []);
  const [row] = summariseUploads([
    { status: "uploading", progress: 40 },
    { status: "queued", progress: 0 },
    { status: "done", progress: 100 },
  ]);
  assert.equal(row.title, "Imports");
  assert.equal(row.detail, "Running · 1 waiting · 1 uploading · 20%");
  assert.equal(row.target.kind, "uploads");
});
