import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudAdmission, createCloudState } from "../src/frameleaf-cloud-data.mjs";
import {
  addCredit,
  cloudJobMeta,
  estimateJob,
  jobQuantity,
  modelsFor,
  placeHold,
  settleWallet,
  settlementBreakdown,
  settlementFor,
  spentSoFar,
  billingFormula,
  billingSentence,
} from "../src/cloud-jobs.mjs";
import { activatePlan, linkAccount, unlinkAccount } from "../src/cloud-account.mjs";

const meta = (modelId = "realbasicvsr@1", quantity = 4) => {
  const model = modelsFor("restoration").find((entry) => entry.id === modelId);
  const estimate = estimateJob(modelId, quantity);
  return cloudJobMeta({ model, estimate, quantity, label: `${quantity} min`, now: 0 });
};

test("model choice is filtered by workload and only lists cloud-hosted models", () => {
  assert.deepEqual(
    modelsFor("restoration", Date.parse("2026-09-25")).map((model) => model.id),
    ["realbasicvsr@1", "seedvr2-3b@1", "seedvr2-7b@1"],
  );
  assert.ok(modelsFor("render").length >= 1);
  assert.ok(modelsFor("upscale").every((model) => model.workload === "upscale"));
  // Local-only encoders never appear as cloud choices.
  assert.ok(!modelsFor("render").some((model) => model.id === "render-hardware@1"));
});

test("estimates are start fees + GPU time × rate with a p50-p90 band and a hold from p90, including render models", () => {
  for (const id of ["realbasicvsr@1", "render-standard@1"]) {
    const estimate = estimateJob(id, 3);
    assert.ok(estimate.p50 > 0 && estimate.p90 > estimate.p50 && estimate.hold >= estimate.p90);
    assert.ok(Math.abs(estimate.p50 - (estimate.startFee * estimate.workers + estimate.workSeconds.p50 * estimate.rate)) < 1e-6);
  }
  assert.equal(estimateJob("render-standard@1", 0), null);
  assert.equal(estimateJob("render-hardware@1", 3), null, "local-only positions have no cloud estimate");
  assert.deepEqual(jobQuantity("restoration", { durationSeconds: 90 }), { quantity: 1.5, label: "1.5 min" });
  assert.equal(jobQuantity("upscale", { count: 3 }).quantity, 3);
  const cloud = meta();
  assert.equal(cloud.workers, 5, "4 minutes of video fan out to five chunk workers");
  assert.equal(billingFormula(cloud), "GPU time × $0.078 per minute + $0.10 start fee × 5 workers");
  assert.match(
    billingSentence(estimateJob("qwen3.5-9b@1", 1000)),
    /^Billed by GPU time: \$0\.078 per minute on a 48 GB GPU \(L40S class\) plus a \$0\.20 start fee\.$/,
  );
  assert.match(billingSentence(estimateJob("seedvr2-3b@1", 5)), /30 s chunks on 5 workers/);
});

test("settlement is deterministic, never above the hold, free on failure and partial on cancel", () => {
  const cloud = meta();
  const done = { id: "job-1", status: "completed", progress: 100, cloud };
  assert.equal(settlementFor(done), settlementFor({ ...done }));
  assert.ok(settlementFor(done) > 0 && settlementFor(done) <= cloud.hold);
  // Metered: the start fee plus GPU seconds × rate, explained in words.
  assert.ok(settlementFor(done) >= cloud.startFee * cloud.workers);
  assert.match(settlementBreakdown(done), /^\d+ min( \d+ s)? GPU time × \$0\.078 per minute \+ \$0\.10 start fee × 5 workers$/);
  assert.equal(settlementFor({ ...done, status: "failed" }), 0);
  const half = { ...done, status: "cancelled", progress: 50 };
  assert.equal(settlementFor(half), spentSoFar(half));
  assert.ok(settlementFor(half) < settlementFor(done));
});

test("a hold is placed at confirmation and released when the job settles", () => {
  const cloud = meta();
  const start = createCloudState();
  const held = placeHold(start, cloud.hold);
  assert.ok(Math.abs(held.wallet.heldUsd - (start.wallet.heldUsd + cloud.hold)) < 1e-9);
  const charged = settlementFor({ id: "job-2", status: "completed", progress: 100, cloud });
  const settled = settleWallet(held, cloud, charged);
  assert.ok(Math.abs(settled.wallet.heldUsd - start.wallet.heldUsd) < 1e-9);
  assert.ok(Math.abs(settled.wallet.balanceUsd - (start.wallet.balanceUsd - charged)) < 1e-4);
  assert.ok(settled.wallet.spentTodayUsd > start.wallet.spentTodayUsd);
  assert.equal(addCredit(start, 26).wallet.balanceUsd, start.wallet.balanceUsd + 26);
});

test("linking and subscribing unlock admission prerequisites without enabling processing", () => {
  const start = createCloudState();
  assert.match(cloudAdmission(start, null), /Link this server/);
  const linked = linkAccount(start, 0);
  assert.equal(linked.link.status, "linked");
  assert.equal(linked.link.account.email, "taylor@example.test");
  assert.match(cloudAdmission(linked, null), /Turn on cloud processing/);
  const active = activatePlan(start, "cloud-annual", Date.parse("2026-09-25T00:00:00Z"));
  assert.equal(active.link.status, "linked");
  assert.equal(active.license.state, "active");
  assert.equal(active.license.renewsOn, "2027-09-25");
  assert.deepEqual(
    [active.license.entitlements.remoteAccess, active.license.entitlements.cloudBackup, active.license.entitlements.cloudProcessing],
    [true, true, true],
  );
  assert.equal(active.processing.enabled, false);
  assert.equal(unlinkAccount(active).link.account, null);
  assert.throws(() => activatePlan(start, "unknown"));
});
