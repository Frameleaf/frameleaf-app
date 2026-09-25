import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANDS,
  LADDER_WORKLOADS,
  PRICE_MULTIPLIER,
  bandFor,
  cloudPositions,
  composeFixes,
  containerGpus,
  gpuProblems,
  startFees,
  INTERPOLATION_TRADEOFF,
  interpolationEstimate,
  interpolationWork,
  estimateCost,
  gpuClasses,
  gpuForWorkload,
  hardwareSamples,
  ladderFor,
  ladderStates,
  modelLadders,
  positionById,
  positionState,
  quotedUnitCost,
  resolvePosition,
  runBenchmark,
} from "../src/gpu-model-catalog.mjs";
import {
  createCloudState,
  detectedWorker,
  hardwareBenchmark,
  jobDestinations,
  localCapability,
  routeSummary,
  setHardwareSample,
} from "../src/frameleaf-cloud-data.mjs";

const bands = (workload, gpu, cpuProfile) => ladderFor(workload).map((item) => bandFor(item, gpu, cpuProfile));
const gpu = (sample) => containerGpus(sample).ml;

test("ladders run light to heavy, with at most two models per size class, and every workload has a cloud position", () => {
  const order = ["cpu", "tiny", "small", "medium", "large", "xl"];
  for (const workload of LADDER_WORKLOADS) {
    const ladder = ladderFor(workload);
    assert.ok(ladder.length >= (workload === "interpolation" ? 2 : 3), workload);
    assert.ok(cloudPositions(workload).length >= 1, workload);
    const sizes = ladder.map((item) => order.indexOf(item.sizeClass));
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), `${workload} runs light to heavy`);
    for (const size of order)
      assert.ok(ladder.filter((item) => item.sizeClass === size).length <= 2, `${workload}/${size}`);
  }
  // Descriptions top out with the 122B-A10B model on the cloud.
  assert.equal(ladderFor("descriptions").at(-1).id, "qwen3.5-122b-a10b@1");
});

test("bands follow the detected GPU: white on CPU, green when it runs on the GPU, blue beyond it", () => {
  // No GPU: CPU-feasible models are white, the rest move to the cloud.
  assert.deepEqual(bands("descriptions", gpu("cpu-only")), ["cpu", "cpu", "cpu", "cpu", "cpu", "cloud", "cloud", "cloud", "cloud", "cloud"]);
  // GTX 1650 4 GB: up to the small models run on the GPU.
  assert.deepEqual(bands("descriptions", gpu("gtx1650")), ["gpu", "gpu", "gpu", "gpu", "gpu", "cloud", "cloud", "cloud", "cloud", "cloud"]);
  // RTX 3060 12 GB: the 9B and 12B join the green band.
  assert.deepEqual(bands("descriptions", gpu("rtx3060")), ["gpu", "gpu", "gpu", "gpu", "gpu", "gpu", "gpu", "cloud", "cloud", "cloud"]);
  // RTX 4090 24 GB: only the 122B stays on the cloud.
  assert.deepEqual(bands("descriptions", gpu("rtx4090")).slice(-3), ["gpu", "gpu", "cloud"]);
  assert.deepEqual(bands("restoration", gpu("cpu-only")), ["cloud", "cloud", "cloud"]);
  assert.deepEqual(bands("restoration", gpu("rtx3060")), ["gpu", "cloud", "cloud"]);
  // A misconfigured card counts as no GPU until it is fixed.
  for (const id of ["arc-a770-no-dri", "rx7900xtx-render-group", "rtx3060-cpu-image", "rtx4070-no-toolkit", "macos-docker-desktop"])
    assert.equal(gpu(id), null, id);
  // The server container can still encode when only the analysis image is wrong.
  assert.ok(gpuForWorkload("rtx3060-cpu-image", "render"));
  assert.equal(gpuForWorkload("rtx3060-cpu-image", "descriptions"), null);
});

test("the route disables positions with a reason: local only blocks blue, cloud only keeps only hosted models", () => {
  const g = gpu("gtx1650");
  const local = ladderStates("descriptions", { gpu: g, route: "local" });
  assert.ok(local.filter((entry) => entry.band === "cloud").every((entry) => entry.disabled && /this server only/.test(entry.reason)));
  assert.ok(local.filter((entry) => entry.band === "gpu").every((entry) => !entry.disabled));
  // Cloud only: nothing runs on this server's CPU or GPU; hosted models move to the blue band.
  const cloud = ladderStates("descriptions", { gpu: g, route: "cloud" });
  assert.ok(cloud.every((entry) => entry.band === "cloud" && entry.runsOn === "cloud"));
  const encoders = ladderStates("render", { gpu: g, route: "cloud" });
  assert.ok(encoders.filter((entry) => entry.band !== "cloud").every((entry) => entry.disabled && /Frameleaf Cloud only/.test(entry.reason)));
  const both = ladderStates("descriptions", { gpu: g, route: "both" });
  assert.ok(both.every((entry) => !entry.disabled));
  // A saved choice that no longer fits falls back to the heaviest usable local model and says so.
  const resolved = resolvePosition("descriptions", "qwen3.5-122b-a10b@1", { gpu: g, route: "local" });
  assert.equal(resolved.runsOn, "local");
  assert.equal(resolved.fallback, true);
  assert.equal(resolvePosition("descriptions", null, { gpu: null, route: "cloud" }).item.id, "florence2-large@1");
});

test("labels carry text and icons, never colour alone", () => {
  const g = gpu("gtx1650");
  const [cpu] = ladderStates("descriptions", { gpu: null, route: "both" });
  assert.match(cpu.label, /^CPU · slow · ~.+ per photo$/);
  const green = positionState(positionById("moondream2@1"), { gpu: g });
  assert.match(green.label, /^Your GPU · ~.+ per photo$/);
  const blue = positionState(positionById("qwen3.5-122b-a10b@1"), { gpu: g });
  assert.match(blue.label, /^Cloud · 122B · about \$\d+\.\d+ per 100 photos$/);
  const slow = positionState(positionById("qwen3.5-4b@1"), { gpu: g });
  assert.match(slow.label, /^Your GPU · slow · ~/);
  for (const entry of ladderStates("descriptions", { gpu: g }))
    assert.ok(BANDS[entry.band].icon && BANDS[entry.band].label && entry.label, entry.item.id);
});

test("estimate maths: 2× loaded rate, start fee per worker, p90 hold", () => {
  assert.equal(PRICE_MULTIPLIER, 2);
  for (const item of gpuClasses) assert.ok(Math.abs(item.customerUsdPerSec - item.loadedUsdPerSec * 2) < 1e-7, item.id);
  // Matches the pricing research's customer rates.
  assert.ok(Math.abs(gpuClasses.find((item) => item.id === "gpu48pro").customerUsdPerSec - 0.00130035) < 1e-7);
  assert.ok(Math.abs(gpuClasses.find((item) => item.id === "gpu80pro").customerUsdPerSec - 0.00370161) < 1e-7);
  const item = positionById("qwen3.5-27b@1");
  const rate = gpuClasses.find((entry) => entry.id === item.cloud.gpuClass).customerUsdPerSec;
  const estimate = estimateCost(item, 250);
  assert.equal(estimate.startFee, startFees[item.cloud.feeClass].customerUsd);
  assert.equal(estimate.workers, 1);
  assert.ok(Math.abs(estimate.p50 - (estimate.startFee + 250 * item.cloud.secondsPerUnit.p50 * rate)) < 1e-6);
  assert.ok(Math.abs(estimate.p90 - (estimate.startFee + 250 * item.cloud.secondsPerUnit.p90 * rate)) < 1e-6);
  assert.equal(estimate.hold, Math.ceil(estimate.p90 * 100) / 100);
  assert.ok(estimate.hold >= estimate.p90);
  // One photo still pays the start fee.
  assert.ok(estimateCost(item, 1).p50 > estimateCost(item, 1).perUnit.p50);
  assert.equal(estimateCost(item, 0), null);
  // Video fans out: every chunk worker pays its own start fee, at most five.
  const video = estimateCost("seedvr2-3b@1", 1);
  assert.equal(video.workers, 2);
  assert.equal(estimateCost("seedvr2-3b@1", 60).workers, 5);
  assert.ok(Math.abs(video.p50 - (2 * video.startFee + video.workSeconds.p50 * video.rate)) < 1e-6);
  // Start fees are at least 2 × our cold-start cost (p90 + 5 s idle) on their GPU class.
  for (const [id, fee] of Object.entries(startFees)) {
    const cls = gpuClasses.find((entry) => entry.id === fee.gpuClass);
    assert.ok(fee.customerUsd + 1e-9 >= 2 * 1.07 * (fee.coldStartP90 + 5) * cls.flexUsdPerSec, id);
  }
  assert.ok(quotedUnitCost(positionById("qwen3.5-9b@1")).usd > 0);
});

test("no cloud position uses a licence that forbids hosted use", () => {
  for (const item of Object.values(modelLadders).flat()) {
    if (item.commercialHosted === "no") {
      assert.equal(cloudPositions(item.workload).includes(item), false, item.id);
      assert.notEqual(bandFor(item, null), "cloud", item.id);
      assert.notEqual(bandFor(item, { vramGb: 1, name: "tiny", speed: 1 }), "cloud", item.id);
    }
  }
  for (const item of cloudPositions()) {
    assert.equal(item.commercialHosted, "yes", item.id);
    assert.doesNotMatch(item.licence, /non-commercial|research/i, item.id);
  }
});

test("hardware samples cover the owner's cases and every problem points at a real fix", () => {
  const ids = hardwareSamples.map((item) => item.id);
  for (const id of ["rtx3060", "gtx1650", "arc-a770-no-dri", "rx7900xtx-render-group", "cpu-only", "macos-docker-desktop"])
    assert.ok(ids.includes(id), id);
  const problemIds = new Set(gpuProblems.map((item) => item.id));
  for (const sample of hardwareSamples) {
    for (const issue of sample.issues) assert.ok(problemIds.has(issue), `${sample.id}: ${issue}`);
    for (const fix of sample.fixes ?? []) assert.ok(composeFixes[fix], `${sample.id}: ${fix}`);
  }
  assert.ok(gpuProblems.length >= 19);
  for (const problem of gpuProblems) if (problem.fix) assert.ok(composeFixes[problem.fix], problem.id);
  assert.match(composeFixes.nvidia.yaml, /reservations:\s+devices:\s+- driver: nvidia/);
  assert.doesNotMatch(composeFixes.nvidia.yaml, /\/dev\/dri/);
  assert.match(composeFixes.intel.yaml, /\/dev\/dri/);
  assert.match(composeFixes.intel.yaml, /group_add/);
  assert.match(composeFixes.amd.yaml, /\/dev\/kfd/);
  const copy = JSON.stringify({ hardwareSamples, composeFixes, gpuProblems, gpuClasses, modelLadders });
  assert.doesNotMatch(copy, /runpod|immich/i);
});

test("the detected ML-container GPU drives local capability, routing and the benchmark", () => {
  let state = createCloudState();
  assert.equal(detectedWorker(state).gpu, "GeForce GTX 1650");
  assert.equal(localCapability("restoration", detectedWorker(state)).ok, true, "RealBasicVSR runs slowly on 4 GB");
  state = setHardwareSample(state, "rtx3060", 0);
  assert.equal(detectedWorker(state).memoryGb, 12);
  assert.equal(localCapability("restoration", detectedWorker(state)).ok, true);
  assert.deepEqual(jobDestinations(state, "restoration").map((item) => [item.id, item.available]), [["local", true], ["cloud", false]]);
  state = setHardwareSample(state, "cpu-only", 0);
  assert.equal(localCapability("restoration", detectedWorker(state)).ok, false);
  assert.match(routeSummary(state, "restoration").text, /no usable GPU/);
  assert.equal(localCapability("descriptions", detectedWorker(state)).ok, true, "Florence-2 runs on the processor");
  const benchmark = runBenchmark("cpu-only", "2026-09-25T00:00:00Z");
  state = { ...state, hardware: { ...state.hardware, benchmark } };
  assert.equal(hardwareBenchmark(state), benchmark);
  const measured = positionState(positionById("florence2-large@1"), { gpu: null, benchmark });
  assert.match(measured.detail, /measured by your benchmark/);
  // Changing hardware drops a benchmark measured on other hardware.
  assert.equal(hardwareBenchmark(setHardwareSample(state, "rtx3060", 0)), null);
});

test("smooth motion: RIFE white on CPU and green on a GPU, FILM blue beyond it; cloud tier is commercial-OK", () => {
  assert.deepEqual(bands("interpolation", gpu("cpu-only")), ["cpu", "cloud"]);
  assert.deepEqual(bands("interpolation", gpu("gtx1650")), ["gpu", "cloud"], "FILM needs 6 GB");
  assert.deepEqual(bands("interpolation", gpu("rtx3060")), ["gpu", "gpu"]);
  assert.deepEqual(bands("interpolation", null, "mac_docker"), ["cpu", "cpu"]);
  for (const item of cloudPositions("interpolation")) {
    assert.equal(item.commercialHosted, "yes", item.id);
    assert.match(item.licence, /^(MIT|Apache-2\.0)$/, item.id);
  }
  assert.equal(ladderFor("interpolation").at(-1).id, "film@1");
  assert.match(INTERPOLATION_TRADEOFF, /smear/);
});

test("smooth motion estimates: new frames per source minute, chunked cloud workers, ~2× size at double rate", () => {
  const work = interpolationWork({ durationSeconds: 120, sourceFps: 30, targetFps: 60 });
  assert.deepEqual(work, { ratio: 2, units: 2, sizeFactor: 2 });
  assert.equal(interpolationWork({ durationSeconds: 60, sourceFps: 25, targetFps: 50 }).sizeFactor, 2);
  // 4× slow motion needs three new frames per source frame.
  assert.equal(interpolationWork({ durationSeconds: 60, sourceFps: 30, targetFps: 120 }).units, 3);
  const film = positionById("film@1");
  const cloudJob = interpolationEstimate(film, work, { gpu: gpu("gtx1650") });
  assert.equal(cloudJob.runsOn, "cloud");
  const rate = gpuClasses.find((entry) => entry.id === film.cloud.gpuClass).customerUsdPerSec;
  assert.equal(cloudJob.cost.startFee, startFees["small-24"].customerUsd);
  assert.equal(cloudJob.cost.workers, 4, "two minutes run as four 30 s chunks");
  assert.ok(Math.abs(cloudJob.cost.p50 - (4 * 0.05 + 2 * 480 * rate)) < 1e-6);
  assert.ok(cloudJob.cost.hold >= cloudJob.cost.p90);
  const local = interpolationEstimate(positionById("rife-4.25@1"), work, { gpu: gpu("gtx1650") });
  assert.equal(local.runsOn, "gpu");
  assert.ok(local.seconds > 0 && local.cost === null);
  assert.equal(local.sizeFactor, 2);
});
