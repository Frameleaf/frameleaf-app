// Per-job Frameleaf Cloud helpers for the prototype: model choice by workload,
// estimates, the wallet hold placed at confirmation and the settled charge.
// Simulation only. Every amount is USD, rounded to 1/100 of a cent.

import {
  cloudModelView,
  cloudModels,
  estimateCloudJob,
  formatUsd,
  walletAvailable,
} from "./frameleaf-cloud-data.mjs";
import { cloudPositions, formatDuration, formatRate } from "./gpu-model-catalog.mjs";

export const DISCLOSURE_VERSION = "2026-09";
export const DISCLOSURE_TEXT =
  "Previews leave this server; metadata is removed; nothing is kept after the job.";

/** Studio renders, billed like AI work: GPU time per second plus a start fee. */
export const renderModels = Object.freeze(cloudPositions("render").map((item) => cloudModelView(item)));

const allModels = () => [...cloudModels, ...renderModels];
const cents = (value) => Math.round(value * 10000) / 10000;
const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/** Cloud models a person can pick for a workload today; retired ones drop out, retiring ones stay flagged. */
export function modelsFor(workload, today = Date.now()) {
  const day = isoDay(today);
  return allModels()
    .filter((model) => model.workload === workload)
    .filter((model) => !model.retiresOn || model.retiresOn >= day);
}

export function findModel(id) {
  return allModels().find((model) => model.id === id) ?? null;
}

/** Start fee + GPU time × rate, with the p50–p90 band and a hold from p90. */
export function estimateJob(modelId, quantity) {
  return estimateCloudJob(modelId, quantity);
}

export function estimateRange(estimate) {
  if (!estimate) return "—";
  return `${formatUsd(estimate.p50)}–${formatUsd(estimate.p90)}`;
}

/** Start fees are whole cents. */
const fee = (value) => `$${(Number(value) || 0).toFixed(2)}`;

const workerFees = (cloud) => {
  const workers = Math.max(1, Number(cloud?.workers) || 1);
  return workers > 1
    ? `${fee(cloud.startFee)} start fee × ${workers} workers`
    : `${fee(cloud?.startFee)} start fee`;
};

/** "GPU time × $0.0780 per minute + $0.20 start fee" for a job's billing basis. */
export function billingFormula(cloud) {
  if (!cloud || !Number.isFinite(cloud.rate) || !cloud.rate) return "Metered GPU time";
  return `GPU time × ${formatRate(cloud.rate)} + ${workerFees(cloud)}`;
}

/** "Billed by GPU time: $0.0780 per minute on a 48 GB GPU (L40S class) plus a $0.20 start fee." */
export function billingSentence(estimate) {
  if (!estimate?.gpuClass) return "";
  const chunks =
    estimate.workers > 1
      ? ` Long videos run as ${estimate.chunkSeconds} s chunks on ${estimate.workers} workers, each with its own start fee.`
      : "";
  return `Billed by GPU time: ${formatRate(estimate.rate)} on a ${estimate.gpuClass.label} plus a ${fee(
    estimate.startFee,
  )} start fee${estimate.workers > 1 ? " per worker" : ""}.${chunks}`;
}

/** Per-unit estimate, always phrased as "about". */
export function perUnitText(estimate) {
  if (!estimate?.perUnit || !estimate.model) return "";
  return `about ${formatUsd(estimate.perUnit.p50)} per ${estimate.model.unit}`;
}

/** Quantity in the model's billing unit: minutes for video work, a count otherwise. */
export function jobQuantity(workload, { durationSeconds = 0, count = 1 } = {}) {
  if (["restoration", "render", "studio", "interpolation"].includes(workload)) {
    const minutes = Math.max(0.1, Math.round((Number(durationSeconds) / 60) * 100) / 100);
    return { quantity: minutes, label: `${minutes} min` };
  }
  const total = Math.max(1, Math.round(Number(count) || 1));
  return { quantity: total, label: `${total} ${total === 1 ? "item" : "items"}` };
}

export function cloudJobMeta({ model, estimate, quantity, label, now = Date.now() }) {
  return {
    modelId: model.id,
    modelName: model.name,
    quantity,
    quantityLabel: label,
    p50: cents(estimate.p50),
    p90: cents(estimate.p90),
    hold: estimate.hold,
    gpuClass: estimate.gpuClass?.id ?? "",
    gpuClassLabel: estimate.gpuClass?.label ?? "",
    rate: estimate.rate ?? 0,
    startFee: cents(estimate.startFee ?? 0),
    workers: estimate.workers ?? 1,
    workSeconds: estimate.workSeconds?.p50 ?? 0,
    disclosureVersion: DISCLOSURE_VERSION,
    consentedAt: new Date(now).toISOString(),
    settled: false,
    chargedUsd: null,
  };
}

/** Deterministic spread so the same job always settles at the same amount. */
function spread(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 0.86 + (hash % 21) / 100;
}

const startFeesFor = (cloud) => (cloud.startFee ?? 0) * Math.max(1, Number(cloud.workers) || 1);
const metered = (cloud) => Number.isFinite(cloud?.rate) && cloud.rate > 0 && Number.isFinite(cloud.workSeconds);

/** GPU seconds metered so far (after model load), deterministic per job. */
export function gpuSecondsFor(job, progress = 100) {
  if (!metered(job?.cloud)) return 0;
  const share = Math.max(0, Math.min(100, Number(progress) || 0)) / 100;
  return Math.round(job.cloud.workSeconds * spread(job.id) * share);
}

export function spentSoFar(job) {
  if (!job?.cloud) return 0;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  if (metered(job.cloud))
    return Math.min(job.cloud.hold, cents(startFeesFor(job.cloud) + gpuSecondsFor(job, progress) * job.cloud.rate));
  return cents(job.cloud.p50 * spread(job.id) * (progress / 100));
}

/**
 * What a finished job costs: start fee + metered GPU time × rate when it
 * completes, the time used when it is cancelled, nothing when the service
 * fails. Never above the hold.
 */
export function settlementFor(job) {
  if (!job?.cloud) return 0;
  if (job.status === "failed") return 0;
  if (job.status === "cancelled") return Math.min(job.cloud.hold, spentSoFar(job));
  if (metered(job.cloud))
    return Math.min(job.cloud.hold, cents(startFeesFor(job.cloud) + gpuSecondsFor(job) * job.cloud.rate));
  return Math.min(job.cloud.hold, cents(job.cloud.p50 * spread(job.id)));
}

/** "21 min 4 s GPU time × $0.0780 per minute + $0.20 start fee" for a settled or running job. */
export function settlementBreakdown(job, progress = 100) {
  if (!metered(job?.cloud)) return "";
  const seconds = gpuSecondsFor(job, progress);
  return `${formatDuration(seconds)} GPU time × ${formatRate(job.cloud.rate)} + ${workerFees(job.cloud)}`;
}

export function placeHold(state, amount) {
  const wallet = state.wallet;
  return { ...state, wallet: { ...wallet, heldUsd: cents(wallet.heldUsd + amount) } };
}

export function settleWallet(state, meta, charged) {
  const wallet = state.wallet;
  return {
    ...state,
    wallet: {
      ...wallet,
      balanceUsd: cents(Math.max(0, wallet.balanceUsd - charged)),
      heldUsd: cents(Math.max(0, wallet.heldUsd - meta.hold)),
      spentTodayUsd: cents(wallet.spentTodayUsd + charged),
    },
  };
}

export function addCredit(state, amount) {
  const wallet = state.wallet;
  return { ...state, wallet: { ...wallet, balanceUsd: cents(wallet.balanceUsd + amount) } };
}

export function creditLabel(state) {
  return formatUsd(walletAvailable(state?.wallet), 2);
}

export const isCloudDestination = (id) => id === "cloud" || id === "runpod";
