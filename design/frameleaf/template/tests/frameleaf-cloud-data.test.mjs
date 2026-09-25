import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_STORAGE_KEY,
  advanceBackupRun,
  backupRunActive,
  startBackupRun,
  DEVICE_CODE_TTL_SECONDS,
  activateProductKey,
  activeEntitlements,
  approveDeviceLink,
  checkBucketClaim,
  cloudAdmission,
  cloudModels,
  completeBackupRun,
  configureBackup,
  createCloudState,
  createUserCode,
  deviceCodeSecondsLeft,
  estimateCloudJob,
  formatUsd,
  installLicenceFile,
  isUserCode,
  licenseStatus,
  linkUserAccount,
  loadCloudState,
  remoteAvailability,
  sampleLicenceFile,
  saveCloudState,
  startDeviceLink,
  subscribe,
  topUpWallet,
  unlinkServer,
  validateBucketSettings,
  walletAvailable,
  acceptCloudConsent,
} from "../src/frameleaf-cloud-data.mjs";

const T0 = Date.parse("2026-09-25T12:00:00Z");
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
};
const linked = () =>
  approveDeviceLink(startDeviceLink(createCloudState(), T0), { email: "taylor@example.invalid" }, T0 + 1000);
const ready = () => acceptCloudConsent(linked());

test("estimates are start fees plus GPU time at twice our cost, matching the pricing research", () => {
  // Research worked examples: describe 1,000 photos ≈ $0.85 (7B class), $5.50 (32B class).
  const seven = estimateCloudJob("qwen3.5-9b@1", 1000);
  assert.equal(seven.gpuClass.id, "gpu48pro");
  assert.ok(Math.abs(seven.p50 - 0.85) < 0.01, seven.p50);
  const large = estimateCloudJob("qwen3.5-27b@1", 1000);
  assert.ok(Math.abs(large.p50 - 5.5) < 0.01, large.p50);
  // 4× upscale of 20 photos with Real-ESRGAN ≈ $0.30; transcribe 30 min ≈ $0.10.
  assert.ok(Math.abs(estimateCloudJob("realesrgan-x4plus@1", 20).p50 - 0.3) < 0.01);
  assert.ok(Math.abs(estimateCloudJob("whisper-large-v3@1", 30).p50 - 0.1) < 0.01);
  // Restore 5 min: Faithful ≈ $1.86 on one worker in the example; chunked on 5 workers here.
  const faithful = estimateCloudJob("realbasicvsr@1", 5);
  assert.equal(faithful.workers, 5);
  assert.ok(Math.abs(faithful.p50 - (1.86 + 4 * 0.1)) < 0.01, faithful.p50);
  // Creative ≈ $54.22 on 5 chunked workers.
  const creative = estimateCloudJob("seedvr2-3b@1", 5);
  assert.equal(creative.workers, 5);
  assert.ok(Math.abs(creative.p50 - 54.22) < 0.01, creative.p50);
  for (const estimate of [seven, large, faithful, creative]) {
    assert.ok(estimate.p90 > estimate.p50);
    assert.ok(estimate.hold >= estimate.p90);
    assert.equal(Math.round(estimate.hold * 100), estimate.hold * 100);
  }
  for (const [model, quantity] of [
    ["unknown@1", 10],
    ["qwen3.5-9b@1", 0],
    ["qwen3.5-9b@1", -3],
    ["qwen3.5-9b@1", "many"],
    ["qwen3.5-9b@1", Number.NaN],
    ["render-hardware@1", 10],
  ])
    assert.equal(estimateCloudJob(model, quantity), null, `${model} × ${quantity}`);
  for (const model of cloudModels) assert.ok(estimateCloudJob(model.id, 1), model.id);
});

test("cloud admission explains each refusal in order and never admits silently", () => {
  const estimate = estimateCloudJob("qwen3.5-27b@1", 1000);
  assert.match(cloudAdmission(null, estimate), /not set up/);
  assert.match(cloudAdmission(createCloudState(), estimate), /Link this server/);
  const notEnabled = linked();
  assert.match(cloudAdmission(notEnabled, estimate), /Turn on cloud processing/);
  const oldTerms = ready();
  oldTerms.processing = { ...oldTerms.processing, consentVersion: "2025-01" };
  assert.match(cloudAdmission(oldTerms, estimate), /current cloud processing terms/);
  const poor = ready();
  poor.wallet = { ...poor.wallet, balanceUsd: 1, heldUsd: 0.9 };
  assert.match(cloudAdmission(poor, estimate), /Add AI credit/);
  const capped = ready();
  capped.wallet = { ...capped.wallet, spentTodayUsd: 19.9, dailyCapUsd: 20 };
  assert.match(cloudAdmission(capped, estimate), /spending cap/);
  assert.equal(cloudAdmission(ready(), estimate), null);
  assert.equal(cloudAdmission(ready(), null), null);
});

test("wallet availability excludes held credit and top-ups are $25, $50 or $100 with no bonus", async () => {
  assert.equal(walletAvailable({ balanceUsd: 10, heldUsd: 2.5 }), 7.5);
  assert.equal(walletAvailable({ balanceUsd: 1, heldUsd: 2 }), 0);
  assert.equal(walletAvailable(null), 0);
  const topped = topUpWallet(createCloudState(), "pack-25");
  assert.ok(Math.abs(topped.wallet.balanceUsd - (18.42 + 25)) < 1e-9);
  const data = await import("../src/frameleaf-cloud-data.mjs");
  assert.equal(data.DEFAULT_WALLET_PACK, "pack-25");
  assert.deepEqual(data.walletPacks.map((pack) => pack.amount), [25, 50, 100]);
  assert.ok(data.walletPacks.every((pack) => !pack.bonus), "no bonus credit");
  assert.ok(
    data.walletPacks.every((pack) => pack.amount >= data.WALLET_MIN_TOP_UP_USD && pack.amount <= data.WALLET_MAX_TOP_UP_USD),
  );
  assert.throws(() => topUpWallet(createCloudState(), "pack-7"), /Choose an amount/);
  assert.equal(formatUsd(0.0025), "$0.0025");
  assert.equal(formatUsd(12), "$12.00");
  assert.equal(formatUsd(Number.NaN), "—");
});

test("loadCloudState falls back to sample state for corrupt, foreign or blocked storage", () => {
  const fresh = createCloudState();
  for (const raw of ["{not json", "null", "[]", '"text"', JSON.stringify({ version: 2, link: {} })])
    assert.deepEqual(loadCloudState(memoryStorage({ [CLOUD_STORAGE_KEY]: raw })), fresh, raw);
  assert.deepEqual(loadCloudState(memoryStorage()), fresh);
  assert.deepEqual(loadCloudState(undefined), fresh);
  const throwing = {
    getItem() {
      throw new Error("SecurityError");
    },
  };
  assert.deepEqual(loadCloudState(throwing), fresh);
});

test("loadCloudState keeps saved sections, fills new fields and ignores malformed sections", () => {
  const storage = memoryStorage({
    [CLOUD_STORAGE_KEY]: JSON.stringify({
      version: 1,
      wallet: { balanceUsd: 3 },
      remote: "broken",
      unknown: { x: 1 },
    }),
  });
  const state = loadCloudState(storage);
  assert.equal(state.wallet.balanceUsd, 3);
  assert.equal(state.wallet.dailyCapUsd, 20);
  assert.deepEqual(state.remote, createCloudState().remote);
  assert.equal(Object.hasOwn(state, "unknown"), false);
  assert.deepEqual(state.userLinks, {});
});

test("saveCloudState round-trips and reports blocked storage", () => {
  const storage = memoryStorage();
  const state = linked();
  assert.equal(saveCloudState(state, storage), true);
  assert.deepEqual(loadCloudState(storage), state);
  assert.equal(
    saveCloudState(state, {
      setItem() {
        throw new Error("QuotaExceededError");
      },
    }),
    false,
  );
});

test("device codes follow RFC 8628 shape and expire after ten minutes", () => {
  for (let index = 0; index < 50; index += 1) assert.ok(isUserCode(createUserCode()));
  assert.equal(isUserCode("ABCD-EFGH"), false);
  const pending = startDeviceLink(createCloudState(), T0);
  assert.equal(pending.link.status, "pending");
  assert.ok(isUserCode(pending.link.deviceCode.userCode));
  assert.match(pending.link.deviceCode.verificationUriComplete, /^https:\/\/frameleaf\.cloud\/link\?code=/);
  assert.equal(deviceCodeSecondsLeft(pending.link.deviceCode, T0), DEVICE_CODE_TTL_SECONDS);
  assert.equal(deviceCodeSecondsLeft(pending.link.deviceCode, T0 + 700000), 0);
  assert.throws(
    () => approveDeviceLink(pending, { email: "taylor@example.invalid" }, T0 + 601000),
    /expired/,
  );
  assert.throws(() => approveDeviceLink(createCloudState(), { email: "a@b.cd" }, T0), /Start linking/);
  const state = linked();
  assert.equal(state.link.status, "linked");
  assert.equal(state.link.deviceCode, null);
  assert.equal(state.link.account.email, "taylor@example.invalid");
});

test("licences gate only cloud features, with a grace period before expiry", () => {
  assert.equal(licenseStatus(createCloudState().license).state, "none");
  assert.match(remoteAvailability(createCloudState()), /Link this server/);
  assert.match(remoteAvailability(linked(), T0), /included with a Frameleaf Cloud plan/);
  const paid = subscribe(linked(), "cloud-annual", T0);
  assert.equal(licenseStatus(paid.license, T0).state, "active");
  assert.equal(remoteAvailability(paid, T0), null);
  const grace = { ...paid.license, state: "grace", graceUntil: "2026-10-09T00:00:00Z" };
  assert.equal(licenseStatus(grace, T0).state, "grace");
  assert.equal(activeEntitlements(grace, T0).remoteAccess, true);
  assert.equal(licenseStatus(grace, Date.parse("2026-10-10T00:00:00Z")).state, "expired");
  assert.equal(activeEntitlements(grace, Date.parse("2026-10-10T00:00:00Z")).cloudBackup, false);
  assert.throws(() => subscribe(createCloudState(), "cloud-annual", T0), /Link this server/);
});

test("supporter keys add only the badge and licence files must match this server", () => {
  const supporter = activateProductKey(createCloudState(), "fl-s2ab-cd34-ef56", T0);
  assert.equal(supporter.license.entitlements.supporter, true);
  assert.equal(supporter.license.entitlements.remoteAccess, false);
  assert.equal(supporter.license.keyHint, "EF56");
  assert.throws(() => activateProductKey(createCloudState(), "FL-X2AB-CD34-EF56"), /Frameleaf product/);
  assert.throws(() => activateProductKey(createCloudState(), "hello"), /FL-XXXX-XXXX-XXXX/);
  const state = createCloudState();
  const installed = installLicenceFile(state, sampleLicenceFile(state.link.instanceId), T0);
  assert.equal(installed.license.source, "file");
  assert.equal(licenseStatus(installed.license, T0).state, "active");
  assert.throws(() => installLicenceFile(state, sampleLicenceFile("other-server"), T0), /different server/);
  assert.throws(() => installLicenceFile(state, "not json", T0), /not a Frameleaf licence/);
});

test("unlinking stops cloud features but keeps identity and backups", () => {
  let state = subscribe(ready(), "cloud-monthly", T0);
  state = { ...state, remote: { ...state.remote, enabled: true, relayConnected: true } };
  state = configureBackup(state, { target: "managed", keyMode: "server", fingerprint: "AB12-CD34" }, T0);
  state = linkUserAccount(state, "taylor", "taylor@example.invalid", T0);
  const next = unlinkServer(state);
  assert.equal(next.link.status, "unlinked");
  assert.equal(next.link.instanceId, state.link.instanceId);
  assert.equal(next.remote.enabled, false);
  assert.equal(next.processing.enabled, false);
  assert.equal(next.backup.configured, true);
  assert.deepEqual(next.userLinks, {});
  assert.throws(() => linkUserAccount(next, "taylor", "taylor@example.invalid"), /administrator/);
});

test("backup targets need an HTTPS endpoint and a bucket dedicated to this server", () => {
  const valid = {
    endpoint: "https://s3.eu-central-2.wasabisys.com",
    bucket: "taylor-frameleaf-backup",
    accessKey: "AKIAEXAMPLE",
    secret: "secret",
  };
  assert.deepEqual(validateBucketSettings(valid), {});
  assert.ok(validateBucketSettings({ ...valid, endpoint: "http://minio.local:9000" }).endpoint);
  assert.ok(validateBucketSettings({ ...valid, bucket: "Bad_Bucket" }).bucket);
  assert.ok(validateBucketSettings({ ...valid, secret: "" }).secret);
  assert.equal(checkBucketClaim("family-photos-backup", "me").ok, false);
  assert.equal(checkBucketClaim("shared-archive", "me").ok, false);
  assert.equal(checkBucketClaim("taylor-frameleaf-backup", "me").marker.instanceId, "me");
  const run = completeBackupRun(
    configureBackup(createCloudState(), { target: "managed", keyMode: "own-memory", fingerprint: "AB12-CD34" }, T0),
    T0,
  );
  assert.ok(run.backup.lastRunSkipped > run.backup.lastRunUploaded);
  assert.throws(() => configureBackup(createCloudState(), { keyMode: "nope" }), /how the key is kept/);
});

test("licensed servers pay less and removing the plan keeps the licence", async () => {
  const data = await import("../src/frameleaf-cloud-data.mjs");
  let state = data.createCloudState();
  assert.equal(data.cloudPrice(60, state.license), 60);
  state = data.activateProductKey(state, "FL-S2AB-CD3E-FGH4");
  assert.equal(data.isLicensed(state.license), true);
  assert.equal(data.cloudPrice(60, state.license), 48);
  state = data.approveDeviceLink(data.startDeviceLink(state), { email: "taylor@example.invalid", name: "Taylor" });
  state = data.subscribe(state, "cloud-annual");
  const withoutPlan = data.removePlan(state);
  assert.equal(withoutPlan.license.plan, null);
  assert.equal(withoutPlan.license.entitlements.supporter, true);
  assert.equal(withoutPlan.license.entitlements.remoteAccess, false);
  const withoutKey = data.removeProductKey(state);
  assert.equal(withoutKey.license.plan, "cloud-annual");
  assert.equal(data.isLicensed(withoutKey.license), false);
});

test("custom hostnames need a subdomain the owner controls and verify on the second check", async () => {
  const data = await import("../src/frameleaf-cloud-data.mjs");
  for (const bad of ["", "example.com", "https://photos.example.com", "a.frameleaf-direct.net", "bad_host.example.com"])
    assert.equal(data.validateCustomHostname(bad).valid, false, bad);
  assert.equal(data.validateCustomHostname("Photos.Example.com.").host, "photos.example.com");
  const records = data.customHostnameRecords("photos.example.com", "https://r.k3v9q2m7x4a8d1fh.frameleaf-direct.net");
  assert.deepEqual(records.map((record) => [record.name, record.value]), [
    ["photos.example.com", "r.k3v9q2m7x4a8d1fh.frameleaf-direct.net"],
    ["_acme-challenge.photos.example.com", "_acme-challenge.k3v9q2m7x4a8d1fh.frameleaf-direct.net"],
  ]);
  let state = data.createCloudState();
  state = data.checkCustomHostname(state, "photos.example.com");
  assert.equal(state.remote.customHostnameStatus, "pending");
  state = data.checkCustomHostname(state, "photos.example.com");
  assert.equal(state.remote.customHostnameStatus, "verified");
  assert.throws(() => data.checkCustomHostname(state, "example.com"));
  assert.equal(data.removeCustomHostname(state).remote.customHostname, "");
});

test("each kind of ML work can run locally, on Frameleaf Cloud or both, and never moves on its own", async () => {
  const data = await import("../src/frameleaf-cloud-data.mjs");
  // Everything starts on this server; without a usable GPU restoration cannot run there.
  let state = data.setHardwareSample(data.createCloudState(), "cpu-only", 0);
  assert.equal(data.workloadRoute(state, "restoration"), "local");
  const local = data.jobDestinations(state, "restoration");
  assert.deepEqual(local.map((item) => [item.id, item.available]), [["local", false], ["cloud", false]]);
  assert.match(local[0].reason, /no usable GPU/);
  assert.equal(data.preferredDestination(state, "restoration"), null);
  // Search, faces and text recognition stay on this server.
  for (const id of ["search", "faces", "ocr"]) assert.throws(() => data.setWorkloadRoute(state, id, "both"));
  // With a linked, consented cloud and "both", the job offers the cloud and the LAN worker.
  state = data.approveDeviceLink(data.startDeviceLink(state), { email: "taylor@example.invalid", name: "Taylor" });
  state = data.acceptCloudConsent({ ...state, processing: { ...state.processing, enabled: true } });
  state = data.setWorkloadRoute(state, "restoration", "both");
  const workers = [data.detectedWorker(state), data.lanWorker];
  const both = data.jobDestinations(state, "restoration", workers);
  assert.deepEqual(both.map((item) => [item.id, item.available]), [["local", false], ["lan", true], ["cloud", true]]);
  assert.equal(data.preferredDestination(state, "restoration", "local", workers), "lan");
  assert.equal(data.preferredDestination(state, "restoration", "cloud"), "cloud");
  // Cloud only removes local choices even when they fit.
  state = data.setWorkloadRoute(state, "upscale", "cloud");
  assert.deepEqual(data.jobDestinations(state, "upscale").map((item) => item.available), [false, true]);
  assert.throws(() => data.setWorkloadRoute(state, "upscale", "anywhere"));
});

test("Back up now is saved as a run that goes queued → starting → running → completed", () => {
  const base = configureBackup(
    subscribe(ready(), "cloud-monthly", T0),
    { target: "managed", keyMode: "server", fingerprint: "AB12-CD34" },
    T0,
  );
  const t0 = Date.parse("2026-09-25T10:00:00Z");
  let state = startBackupRun(base, t0);
  assert.equal(state.backup.run.status, "queued");
  assert.equal(state.backup.run.startedAt, "2026-09-25T10:00:00.000Z");
  assert.equal(backupRunActive(state), true);
  assert.equal(startBackupRun(state, t0 + 500), state, "one run at a time");
  const seen = [];
  for (let second = 1; second <= 20 && backupRunActive(state); second += 1) {
    state = advanceBackupRun(state, t0 + second * 1000);
    seen.push(state.backup.run.status);
  }
  assert.deepEqual([...new Set(seen)], ["queued", "starting", "running", "completed"]);
  assert.equal(state.backup.run.progress, 100);
  assert.equal(state.backup.lastRunUploaded, 214);
  assert.ok(state.backup.lastRunAt);
  assert.equal(advanceBackupRun(state, t0 + 60000), state, "a finished run stays put");
  const unlinked = { ...startBackupRun(base, t0), link: { ...base.link, status: "unlinked" } };
  assert.equal(advanceBackupRun(unlinked, t0 + 1000).backup.run.status, "failed");
});
