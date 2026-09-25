// Prototype sample data for the optional Frameleaf Cloud layer (account link,
// licence, remote access, cloud processing with the AI Wallet, cloud backup).
// Simulation only: nothing here contacts a service or moves media.
import { validateProductKey } from "./system-data.mjs";
import {
  DEFAULT_HARDWARE_SAMPLE,
  LADDER_WORKLOADS,
  bandFor,
  cloudPositions,
  containerGpus,
  estimateCost,
  hardwareSampleById,
  ladderFor,
  minVramGb,
  positionById,
  startFees,
  workloadUnits,
} from "./gpu-model-catalog.mjs";

export const CLOUD_STORAGE_KEY = "frameleaf:cloud:v1";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const CLOUD_DESTINATION = Object.freeze({
  id: "cloud",
  name: "Frameleaf Cloud",
  short: "Frameleaf Cloud",
});

export const cloudPlans = Object.freeze([
  {
    id: "cloud-monthly",
    title: "Frameleaf Cloud",
    price: 6,
    currency: "USD",
    period: "month",
    description: "Remote access and encrypted cloud backup for this server.",
    features: [
      "Remote access through the Frameleaf relay",
      "1 TB encrypted cloud backup",
      "Up to 3 linked servers",
    ],
    recommended: false,
  },
  {
    id: "cloud-annual",
    title: "Frameleaf Cloud · yearly",
    price: 60,
    currency: "USD",
    period: "year",
    description: "Everything in monthly, two months free.",
    features: [
      "Remote access through the Frameleaf relay",
      "1 TB encrypted cloud backup",
      "Up to 3 linked servers",
    ],
    recommended: true,
  },
]);

/**
 * AI credit top-ups (docs/ai-wallet.md, 2026-09-25): presets $25 (default),
 * $50 and $100; custom amounts from $20 to $500. No bonus credit, which would
 * cut into the per-run margin floor. Card fees are included in the amount.
 */
export const WALLET_MIN_TOP_UP_USD = 20;
export const WALLET_MAX_TOP_UP_USD = 500;
export const DEFAULT_WALLET_PACK = "pack-25";
export const WALLET_FEES_NOTE = "Card fees are included; the full amount becomes AI credit.";
export const walletPacks = Object.freeze([
  { id: "pack-25", amount: 25 },
  { id: "pack-50", amount: 50 },
  { id: "pack-100", amount: 100 },
]);

/**
 * Models Frameleaf Cloud hosts for AI work. Studio exports render locally only, so none are listed.
 * Billed by metered GPU time per GPU class plus a per-job start fee; per-unit
 * figures are estimates. Source of truth: gpu-model-catalog.mjs.
 */
export const cloudModels = Object.freeze(
  cloudPositions()
    .filter((item) => item.workload !== "render")
    .map((item) => cloudModelView(item)),
);

/** The shape screens use for a cloud-hosted model. */
export function cloudModelView(item) {
  return Object.freeze({
    id: item.id,
    workload: item.workload,
    name: item.name,
    params: item.params,
    unit: item.unit,
    note: item.note,
    licence: item.licence,
    gpuClass: item.cloud.gpuClass,
    secondsPerUnit: item.cloud.secondsPerUnit,
    startFee: startFees[item.cloud.feeClass]?.customerUsd ?? 0,
    retiresOn: item.retiresOn,
  });
}

export const backupKeyModes = Object.freeze([
  {
    id: "server",
    title: "Generated key, kept on this server",
    summary:
      "The server creates the bucket key and stores it next to its identity. You get a recovery kit once.",
    warning:
      "If you lose this server and the recovery kit, the backup cannot be read.",
    escrow: true,
  },
  {
    id: "own-stored",
    title: "Your own key, with a copy on this server",
    summary:
      "You create and download the key. The server keeps a copy so scheduled backups run unattended. It is never sent to Frameleaf Cloud.",
    warning: "Keep the downloaded key file safe; nobody can recover it for you.",
    escrow: false,
  },
  {
    id: "own-memory",
    title: "Your own key, never saved",
    summary:
      "You enter the key after every restart. Backups pause until you do, and restores always need the key file.",
    warning:
      "A lost key means every backup in this bucket is permanently unreadable.",
    escrow: false,
  },
]);

export function createCloudState() {
  return {
    version: 1,
    link: {
      status: "unlinked",
      account: null,
      instanceId: "018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55",
      fingerprint: "SHA256:q7Lk…9vXe",
      linkedAt: null,
      lastContactAt: null,
      userCode: null,
      deviceCode: null,
      permissions: {
        allowRemoteEnable: false,
        allowBackupTrigger: true,
        allowEntitlementRefresh: true,
      },
    },
    license: {
      state: "none",
      plan: null,
      source: null,
      keyHint: null,
      supporterKind: null,
      checkedAt: null,
      renewsOn: null,
      graceUntil: null,
      entitlements: {
        remoteAccess: false,
        cloudBackup: false,
        cloudProcessing: false,
        supporter: false,
      },
    },
    remote: {
      enabled: false,
      mode: "relay-and-direct",
      relay: "eu1",
      relayConnected: false,
      relayLatencyMs: 38,
      directPort: 2443,
      portMapping: "upnp",
      portMappingResult: null,
      manualPort: false,
      cgnatSuspected: false,
      lastTestAt: null,
      publicUrl: "https://r.k3v9q2m7x4a8d1fh.frameleaf-direct.net",
      certificateExpires: "2026-11-02",
      allowOriginals: false,
      allowPasswordSignIn: false,
      customHostname: "",
      customHostnameStatus: null,
      usageGb: 42.6,
      allowanceGb: 200,
    },
    processing: {
      enabled: false,
      consentVersion: null,
      requiredConsentVersion: "2026-09",
      identityNames: false,
      medicalSignals: false,
      // Chosen position on each workload's model slider; null picks the best that fits.
      defaultModels: {
        descriptions: null,
        upscale: null,
        restoration: null,
        studio: null,
        render: null,
        interpolation: null,
      },
      autoDescribe: false,
      dailyBudgetUsd: 2,
      // Where each kind of ML work may run: "local" | "cloud" | "both".
      routing: {
        descriptions: "local",
        upscale: "local",
        restoration: "local",
        studio: "local",
        interpolation: "local",
      },
    },
    // Result of Settings → Compute & jobs → Hardware & GPU (sample state in the prototype).
    hardware: {
      sample: DEFAULT_HARDWARE_SAMPLE,
      checkedAt: "2026-09-25T07:40:00Z",
      benchmark: null,
    },
    wallet: {
      balanceUsd: 18.42,
      heldUsd: 1.35,
      spentTodayUsd: 0.62,
      dailyCapUsd: 20,
      autoTopUp: false,
    },
    backup: {
      configured: false,
      target: "managed",
      keyMode: null,
      keyLoaded: true,
      bucket: null,
      endpoint: null,
      keyFingerprint: null,
      escrow: false,
      recoveryKitSavedAt: null,
      lastVerifyAt: null,
      region: "eu-central-2",
      usedBytes: 0,
      quotaBytes: 1e12,
      lastRunAt: null,
      lastRunUploaded: 0,
      lastRunSkipped: 0,
      schedule: "0 3 * * *",
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
    },
    signIn: {
      showOnLocalLogin: true,
    },
    // Local accounts that linked their own Frameleaf account for remote sign-in.
    userLinks: {},
  };
}

export const cloudJobs = Object.freeze([
  {
    id: "cj-2031",
    title: "Describe 1,284 photos",
    model: "qwen3.5-27b@1",
    status: "completed",
    estimateUsd: 6.81,
    settledUsd: 6.53,
    gpuSeconds: 1529,
    workers: 1,
    finishedAt: "2026-09-24T21:14:00Z",
  },
  {
    id: "cj-2032",
    title: "Restore “Lake house 1994.mov” (4 min)",
    model: "realbasicvsr@1",
    status: "completed",
    estimateUsd: 1.9,
    settledUsd: 1.84,
    gpuSeconds: 1031,
    workers: 5,
    finishedAt: "2026-09-25T08:02:00Z",
  },
  {
    id: "cj-2033",
    title: "Enhance 6 prints",
    model: "seedvr2-7b-image@1",
    status: "running",
    estimateUsd: 1.01,
    settledUsd: null,
    heldUsd: 1.12,
    workers: 1,
  },
]);

// Each manifest pairs with the nightly database backup uploaded in the same run.
export const backupManifests = Object.freeze([
  { id: "m-2026-09-25", createdAt: "2026-09-25T03:00:00Z", assets: 48211, bytes: 612e9, db: { createdAt: "2026-09-25T02:00:00Z", bytes: 1.84e9 } },
  { id: "m-2026-09-24", createdAt: "2026-09-24T03:00:00Z", assets: 48160, bytes: 611.4e9, db: { createdAt: "2026-09-24T02:00:00Z", bytes: 1.83e9 } },
  { id: "m-2026-09-18", createdAt: "2026-09-18T03:00:00Z", assets: 47904, bytes: 606.2e9, db: { createdAt: "2026-09-18T02:00:00Z", bytes: 1.82e9 } },
  { id: "m-2026-09-01", createdAt: "2026-09-01T03:00:00Z", assets: 47302, bytes: 598e9, db: { createdAt: "2026-09-01T02:00:00Z", bytes: 1.79e9 } },
  { id: "m-2026-06-01", createdAt: "2026-06-01T03:00:00Z", assets: 44870, bytes: 561.3e9, db: { createdAt: "2026-06-01T02:00:00Z", bytes: 1.66e9 } },
  { id: "m-2026-01-01", createdAt: "2026-01-01T03:00:00Z", assets: 41215, bytes: 509.8e9, db: { createdAt: "2026-01-01T02:00:00Z", bytes: 1.51e9 } },
  { id: "m-2025-10-01", createdAt: "2025-10-01T03:00:00Z", assets: 39480, bytes: 488.1e9, db: { createdAt: "2025-10-01T02:00:00Z", bytes: 1.44e9 } },
]);

export function formatUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 0.1 ? 4 : digits)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(2)} TB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Any model on a workload ladder (local or cloud), in the cloud-model shape when hosted. */
export function modelById(id) {
  const item = positionById(id);
  if (!item) return null;
  return item.cloud && item.commercialHosted === "yes" ? cloudModelView(item) : item;
}

/**
 * Estimate for a cloud job: start fee × workers + units × measured seconds per
 * unit × the GPU class rate (both 2× our loaded cost). p50 is typical, p90 the
 * high end, and the wallet hold is p90 rounded up to the cent.
 */
export function estimateCloudJob(modelId, quantity) {
  const estimate = estimateCost(modelId, quantity);
  if (!estimate) return null;
  return {
    model: cloudModelView(estimate.item),
    gpuClass: estimate.gpuClass,
    rate: estimate.rate,
    startFee: estimate.startFee,
    workers: estimate.workers,
    chunkSeconds: estimate.chunkSeconds,
    workSeconds: estimate.workSeconds,
    perUnit: estimate.perUnit,
    p50: estimate.p50,
    p90: estimate.p90,
    hold: estimate.hold,
  };
}

export function walletAvailable(wallet) {
  if (!record(wallet)) return 0;
  return Math.max(0, wallet.balanceUsd - wallet.heldUsd);
}

/** Why a cloud job would be refused before it is submitted; null when admissible. */
export function cloudAdmission(state, estimate) {
  if (!record(state)) return "Frameleaf Cloud is not set up on this server.";
  if (state.link.status !== "linked") return "Link this server to a Frameleaf account first.";
  if (!state.processing.enabled) return "Turn on cloud processing in Settings → Frameleaf Cloud.";
  if (state.processing.consentVersion !== state.processing.requiredConsentVersion)
    return "Review and accept the current cloud processing terms.";
  if (!estimate) return null;
  if (estimate.hold > walletAvailable(state.wallet))
    return `Add AI credit: this job needs ${formatUsd(estimate.hold)} available.`;
  if (state.wallet.spentTodayUsd + estimate.p90 > state.wallet.dailyCapUsd)
    return "This job would pass today’s spending cap.";
  return null;
}

export function loadCloudState(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(CLOUD_STORAGE_KEY) ?? "null");
    if (record(parsed) && parsed.version === 1) {
      const base = createCloudState();
      return Object.fromEntries(
        Object.entries(base).map(([key, value]) => [
          key,
          record(value) && record(parsed[key]) ? { ...value, ...parsed[key] } : value,
        ]),
      );
    }
  } catch {
    // Private windows or blocked storage fall back to the sample state.
  }
  return createCloudState();
}

export function saveCloudState(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CLOUD_STORAGE_KEY, JSON.stringify(state));
    globalThis.dispatchEvent?.(new CustomEvent("frameleaf-cloud-change"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- link & code

export const LINK_VERIFICATION_URL = "https://frameleaf.cloud/link";
export const DEVICE_CODE_TTL_SECONDS = 600;
// RFC 8628 §6.1: consonants only, so a code never spells a word or confuses 0/O.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const nowMs = (now) => (now instanceof Date ? now.getTime() : Number(now ?? Date.now()));

export function createUserCode(random = Math.random) {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    const pick = Math.floor(random() * USER_CODE_ALPHABET.length);
    code += USER_CODE_ALPHABET[Math.min(pick, USER_CODE_ALPHABET.length - 1)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function isUserCode(value) {
  return typeof value === "string" && /^[BCDFGHJ-NP-TV-XZ]{4}-[BCDFGHJ-NP-TV-XZ]{4}$/.test(value);
}

/** Start an RFC 8628 device authorization; the code expires after ten minutes. */
export function startDeviceLink(state, now = Date.now(), random = Math.random) {
  const userCode = createUserCode(random);
  const issued = nowMs(now);
  return {
    ...state,
    link: {
      ...state.link,
      status: "pending",
      userCode,
      deviceCode: {
        userCode,
        verificationUri: LINK_VERIFICATION_URL,
        verificationUriComplete: `${LINK_VERIFICATION_URL}?code=${userCode}`,
        issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
        interval: 5,
      },
    },
  };
}

export function deviceCodeSecondsLeft(deviceCode, now = Date.now()) {
  if (!record(deviceCode)) return 0;
  const left = Math.ceil((Date.parse(deviceCode.expiresAt) - nowMs(now)) / 1000);
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

export function cancelDeviceLink(state) {
  return {
    ...state,
    link: { ...state.link, status: "unlinked", userCode: null, deviceCode: null },
  };
}

/** Simulated approval on frameleaf.cloud. Refuses an expired code. */
export function approveDeviceLink(state, account, now = Date.now()) {
  if (state.link.status !== "pending" || !state.link.deviceCode)
    throw new Error("Start linking first.");
  if (deviceCodeSecondsLeft(state.link.deviceCode, now) === 0)
    throw new Error("This code has expired. Start again to get a new code.");
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter the account email.");
  const at = new Date(nowMs(now)).toISOString();
  return {
    ...state,
    link: {
      ...state.link,
      status: "linked",
      account: { email, name: account.name || email.split("@")[0] },
      linkedAt: at,
      lastContactAt: at,
      userCode: null,
      deviceCode: null,
    },
    // The account's AI Wallet makes pay-per-job processing available without a plan.
    license: {
      ...state.license,
      entitlements: { ...state.license.entitlements, cloudProcessing: true },
    },
  };
}

/**
 * Unlinking stops every cloud-connected feature but never touches local photos.
 * A backup bucket is kept (and stays readable with its key) until the plan ends.
 */
export function unlinkServer(state) {
  return {
    ...state,
    link: {
      ...createCloudState().link,
      instanceId: state.link.instanceId,
      fingerprint: state.link.fingerprint,
      permissions: state.link.permissions,
    },
    remote: { ...state.remote, enabled: false, relayConnected: false },
    processing: { ...state.processing, enabled: false, autoDescribe: false },
    license: {
      ...state.license,
      entitlements: { ...state.license.entitlements, cloudProcessing: false },
    },
    userLinks: {},
  };
}

export const unlinkConsequences = Object.freeze([
  "Remote access stops. People away from home can no longer reach this server.",
  "Cloud processing stops and queued Frameleaf Cloud jobs are cancelled; held AI credit is released.",
  "Scheduled cloud backups pause. Existing backups stay in the bucket with the same key.",
  "Everyone’s linked Frameleaf accounts are disconnected from this server.",
  "Local photos, albums, accounts and sign-in keep working exactly as before.",
]);

export const serverTelemetry = Object.freeze([
  ["Frameleaf version", "Development build"],
  ["Uptime", "Days since the last restart"],
  ["Health", "Database, storage and job queue status"],
  ["Endpoints", "Local and public addresses used for remote access"],
  ["Remote access", "Relay connection and direct-connect result"],
  ["Never sent", "Photos, videos, thumbnails, metadata, names, accounts or usage"],
]);

// ------------------------------------------------------------------- licence

export const entitlementLabels = Object.freeze({
  remoteAccess: "Remote access",
  cloudBackup: "Cloud backup",
  cloudProcessing: "Cloud processing",
  supporter: "Supporter",
});

const dateOnly = (value) => (typeof value === "string" ? value.slice(0, 10) : null);

/** Normalise the licence into one of none / active / grace / expired. */
export function licenseStatus(license, now = Date.now()) {
  if (!record(license) || !license.plan) {
    return license?.entitlements?.supporter
      ? { state: "supporter", label: "Supporter", tone: "ok" }
      : { state: "none", label: "No plan", tone: "muted" };
  }
  const time = nowMs(now);
  if (license.state === "grace" && license.graceUntil && Date.parse(license.graceUntil) > time)
    return { state: "grace", label: `Renewal overdue · grace until ${dateOnly(license.graceUntil)}`, tone: "warning" };
  if (license.state === "expired" || license.state === "grace")
    return { state: "expired", label: "Expired", tone: "danger" };
  return { state: "active", label: "Active", tone: "ok" };
}

/** Cloud-connected features follow the plan; the grace period keeps them running. */
export function activeEntitlements(license, now = Date.now()) {
  const status = licenseStatus(license, now).state;
  const base = record(license?.entitlements) ? license.entitlements : {};
  const cloud = status === "active" || status === "grace";
  return {
    remoteAccess: cloud && base.remoteAccess === true,
    cloudBackup: cloud && base.cloudBackup === true,
    // Pay-per-job processing needs a linked account and wallet, not a plan.
    cloudProcessing: base.cloudProcessing === true,
    supporter: base.supporter === true,
  };
}

export function subscribe(state, planId, now = Date.now()) {
  const plan = cloudPlans.find((item) => item.id === planId);
  if (!plan) throw new Error("Choose a plan.");
  if (state.link.status !== "linked") throw new Error("Link this server first.");
  const time = nowMs(now);
  const renews = new Date(time + (plan.period === "year" ? 365 : 30) * 86400000);
  return {
    ...state,
    license: {
      ...state.license,
      state: "active",
      plan: plan.id,
      source: "account",
      renewsOn: renews.toISOString().slice(0, 10),
      graceUntil: null,
      checkedAt: new Date(time).toISOString(),
      entitlements: {
        ...state.license.entitlements,
        remoteAccess: true,
        cloudBackup: true,
        cloudProcessing: true,
      },
    },
  };
}

/** Supporter keys (FL-S… for a server, FL-I… for one person) only add the badge. */
export function activateProductKey(state, input, now = Date.now()) {
  const result = validateProductKey(input);
  if (!result.valid) throw new Error(result.message);
  return {
    ...state,
    license: {
      ...state.license,
      keyHint: result.key.slice(-4),
      supporterKind: result.kind,
      checkedAt: new Date(nowMs(now)).toISOString(),
      entitlements: { ...state.license.entitlements, supporter: true },
    },
  };
}

/**
 * Offline licence files are signed certificates bound to this server's instance id.
 * The prototype checks the envelope; the server verifies the Ed25519 signature.
 */
export function parseLicenceFile(text, instanceId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a Frameleaf licence file.");
  }
  if (!record(data) || data.format !== "frameleaf-licence" || typeof data.signature !== "string")
    throw new Error("This is not a Frameleaf licence file.");
  if (data.instanceId !== instanceId)
    throw new Error("This licence belongs to a different server. Download the file for this server’s instance ID.");
  if (!cloudPlans.some((plan) => plan.id === data.plan)) throw new Error("This licence names an unknown plan.");
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(data.expires ?? ""))) throw new Error("This licence has no expiry date.");
  return { plan: data.plan, expires: String(data.expires).slice(0, 10) };
}

export function installLicenceFile(state, text, now = Date.now()) {
  const parsed = parseLicenceFile(text, state.link.instanceId);
  const expired = Date.parse(parsed.expires) < nowMs(now);
  return {
    ...state,
    license: {
      ...state.license,
      state: expired ? "expired" : "active",
      plan: parsed.plan,
      source: "file",
      renewsOn: parsed.expires,
      graceUntil: null,
      checkedAt: new Date(nowMs(now)).toISOString(),
      entitlements: {
        ...state.license.entitlements,
        remoteAccess: true,
        cloudBackup: true,
        cloudProcessing: true,
      },
    },
  };
}

export function sampleLicenceFile(instanceId, expires = "2027-09-25") {
  return JSON.stringify(
    { format: "frameleaf-licence", version: 1, instanceId, plan: "cloud-annual", expires, signature: "ed25519:sample" },
    null,
    2,
  );
}

export function removeLicense(state) {
  return {
    ...state,
    license: {
      ...createCloudState().license,
      entitlements: {
        ...createCloudState().license.entitlements,
        cloudProcessing: state.link.status === "linked",
      },
    },
    remote: { ...state.remote, enabled: false, relayConnected: false },
  };
}

/** Removes the plan certificate from this server; a supporter licence key stays. */
export function removePlan(state) {
  const base = createCloudState().license;
  return {
    ...state,
    license: {
      ...state.license,
      state: base.state,
      plan: null,
      source: null,
      renewsOn: null,
      graceUntil: null,
      entitlements: {
        ...state.license.entitlements,
        remoteAccess: false,
        cloudBackup: false,
        cloudProcessing: state.link.status === "linked",
      },
    },
    remote: { ...state.remote, enabled: false, relayConnected: false },
  };
}

/** Removes the licence key from this server; a Frameleaf Cloud plan stays. */
export function removeProductKey(state) {
  return {
    ...state,
    license: {
      ...state.license,
      keyHint: null,
      supporterKind: null,
      entitlements: { ...state.license.entitlements, supporter: false },
    },
  };
}

// Licensed servers (an activated server or individual key) pay less for Frameleaf
// Cloud plans. AI credit is always 2× our loaded GPU cost, licensed or not.
export const LICENSED_DISCOUNT = 0.2;

export function isLicensed(license) {
  return license?.entitlements?.supporter === true;
}

/** Plan price after the licensed-server discount (plans only, never AI credit). */
export function cloudPrice(price, license) {
  if (!Number.isFinite(price)) return price;
  return isLicensed(license) ? Math.round(price * (1 - LICENSED_DISCOUNT) * 100) / 100 : price;
}

/** A hostname the owner controls, e.g. photos.example.com. */
export function validateCustomHostname(value) {
  const host = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return { valid: false, host, message: "Enter a hostname such as photos.example.com." };
  if (/^[a-z]+:\/\//.test(host) || host.includes("/"))
    return { valid: false, host, message: "Enter only the hostname, without https:// or a path." };
  const labels = host.split(".");
  if (
    labels.length < 3 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return { valid: false, host, message: "Use a subdomain you own, such as photos.example.com." };
  if (host.endsWith(".frameleaf-direct.net") || host.endsWith(".frameleaf.cloud"))
    return { valid: false, host, message: "Use a domain you own; Frameleaf addresses are already set up." };
  return { valid: true, host, message: "" };
}

/** DNS records the owner adds at their DNS provider for a custom hostname. */
export function customHostnameRecords(host, publicUrl) {
  const target = String(publicUrl ?? "").replace(/^https:\/\//, "");
  const label = target.split(".")[1] ?? "";
  return [
    { type: "CNAME", name: host, value: target, purpose: "Sends visitors to your server through Frameleaf." },
    {
      type: "CNAME",
      name: `_acme-challenge.${host}`,
      value: `_acme-challenge.${label}.frameleaf-direct.net`,
      purpose: "Lets this server renew its own certificate for your domain.",
    },
  ];
}

/** Simulated DNS check: "pending" first, "verified" once the records resolve. */
export function checkCustomHostname(state, host, now = Date.now()) {
  const result = validateCustomHostname(host);
  if (!result.valid) throw new Error(result.message);
  const again = state.remote.customHostname === result.host && state.remote.customHostnameStatus === "pending";
  return {
    ...state,
    remote: {
      ...state.remote,
      customHostname: result.host,
      customHostnameStatus: again ? "verified" : "pending",
      customHostnameCheckedAt: new Date(nowMs(now)).toISOString(),
    },
  };
}

export function removeCustomHostname(state) {
  return {
    ...state,
    remote: { ...state.remote, customHostname: "", customHostnameStatus: null },
  };
}

// ------------------------------------------------------------- remote access

/** Why remote access cannot be turned on; null when it can. */
export function remoteAvailability(state, now = Date.now()) {
  if (!record(state)) return "Frameleaf Cloud is not set up on this server.";
  if (state.link.status !== "linked") return "Link this server to a Frameleaf account first.";
  if (!activeEntitlements(state.license, now).remoteAccess)
    return "Remote access is included with a Frameleaf Cloud plan.";
  return null;
}

/** Simulated reachability test: relay handshake, then UPnP/NAT-PMP mapping. */
export function testRemoteConnection(state, now = Date.now()) {
  const direct = state.remote.mode === "relay-and-direct";
  const mapped = direct && !state.remote.cgnatSuspected;
  return {
    ...state,
    remote: {
      ...state.remote,
      relayConnected: state.remote.enabled,
      lastTestAt: new Date(nowMs(now)).toISOString(),
      portMappingResult: !direct
        ? null
        : state.remote.manualPort
          ? `Manual forward · port ${state.remote.directPort} answered`
          : mapped
            ? `UPnP mapped external ${state.remote.directPort} → this server`
            : "No mapping · your internet provider appears to share one public address (CGNAT)",
    },
  };
}

export const relayRegions = Object.freeze({
  eu1: "Europe · Falkenstein",
  na1: "North America · Ashburn",
});

// -------------------------------------------------------------- AI wallet

export function topUpWallet(state, packId) {
  const pack = walletPacks.find((item) => item.id === packId);
  if (!pack) throw new Error("Choose an amount.");
  return {
    ...state,
    wallet: { ...state.wallet, balanceUsd: state.wallet.balanceUsd + pack.amount },
  };
}

export function acceptCloudConsent(state, features = {}) {
  return {
    ...state,
    processing: {
      ...state.processing,
      enabled: true,
      consentVersion: state.processing.requiredConsentVersion,
      identityNames: features.identityNames === true,
      medicalSignals: features.medicalSignals === true,
    },
  };
}

export const consentTerms = Object.freeze([
  "Only previews are sent, never originals. Location and camera metadata are stripped first.",
  "Zero retention: files are deleted as soon as the job finishes, and within 24 hours at most.",
  "Nothing you send is used to train models.",
  "Jobs run in your account’s region; files never leave it.",
  "Every job shows its model and estimated cost before it starts. Nothing falls back to the cloud silently.",
]);

// ------------------------------------------------------------------ backup

export const BUCKET_MARKER = "frameleaf-backup.json";

/** Buckets that the sample world already knows about. */
const claimedBuckets = Object.freeze({
  "family-photos-backup": "claimed",
  "shared-archive": "foreign",
});

export function validateBucketSettings({ endpoint, bucket, accessKey, secret } = {}) {
  const errors = {};
  try {
    const url = new URL(String(endpoint ?? ""));
    if (url.protocol !== "https:")
      errors.endpoint = "Encrypted uploads with your key (SSE-C) need an HTTPS endpoint.";
    else if (url.username || url.password) errors.endpoint = "Keep credentials out of the endpoint address.";
  } catch {
    errors.endpoint = "Enter the endpoint address, for example https://s3.eu-central-2.wasabisys.com.";
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(bucket ?? "")) || /\.\.|^\d+\.\d+\.\d+\.\d+$/.test(bucket))
    errors.bucket = "Bucket names use 3–63 lowercase letters, numbers, dots or hyphens.";
  if (!String(accessKey ?? "").trim()) errors.accessKey = "Enter the access key ID.";
  if (!String(secret ?? "").trim()) errors.secret = "Enter the secret access key.";
  return errors;
}

/** One bucket per server: refuse buckets claimed by another server or holding other files. */
export function checkBucketClaim(bucket, instanceId) {
  const known = claimedBuckets[bucket];
  if (known === "claimed")
    return { ok: false, reason: `This bucket already holds ${BUCKET_MARKER} for another Frameleaf server. Each server needs its own bucket.` };
  if (known === "foreign")
    return { ok: false, reason: "This bucket already contains other files. Use an empty bucket dedicated to this server." };
  return { ok: true, reason: "", marker: { file: BUCKET_MARKER, instanceId } };
}

/** Browser-side key generation for own-key modes; never leaves the browser in the prototype. */
export function createBackupKey(random = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  if (random?.getRandomValues) random.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return { key, fingerprint: keyFingerprint(bytes) };
}

/** Short display fingerprint (FNV-1a) so people can match a key file to a bucket. */
export function keyFingerprint(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, "0").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function backupKeyFile({ key, fingerprint, instanceId, bucket, mode }) {
  return JSON.stringify(
    { format: "frameleaf-backup-key", version: 1, algorithm: "AES256 (SSE-C)", instanceId, bucket, mode, fingerprint, key },
    null,
    2,
  );
}

export function recoveryKitText({ instanceId, bucket, fingerprint, region, escrow }) {
  return [
    "FRAMELEAF CLOUD BACKUP · RECOVERY KIT",
    "",
    `Server instance: ${instanceId}`,
    `Bucket: ${bucket} (${region})`,
    `Key fingerprint: ${fingerprint}`,
    `Escrow with Frameleaf: ${escrow ? "yes, protected by your passphrase" : "no"}`,
    "",
    "Keep this kit somewhere safe and offline. Without this server and this kit,",
    "the backup cannot be read. Frameleaf cannot recover it for you.",
    "",
    "Recovery code: FLRK-7Q4M-2XWD-9HCT-KV3P-58BN",
  ].join("\n");
}

export function configureBackup(state, config, now = Date.now()) {
  if (!backupKeyModes.some((mode) => mode.id === config.keyMode)) throw new Error("Choose how the key is kept.");
  return {
    ...state,
    backup: {
      ...state.backup,
      configured: true,
      target: config.target === "byo" ? "byo" : "managed",
      endpoint: config.target === "byo" ? config.endpoint : "https://s3.eu-central-2.wasabisys.com",
      bucket: config.target === "byo" ? config.bucket : `fl-eu-${state.link.instanceId}`,
      keyMode: config.keyMode,
      keyFingerprint: config.fingerprint,
      keyLoaded: true,
      escrow: config.keyMode === "server" && config.escrow === true,
      recoveryKitSavedAt: config.keyMode === "server" ? new Date(nowMs(now)).toISOString() : null,
      quotaBytes: config.target === "byo" ? null : state.backup.quotaBytes,
    },
  };
}

/** Content-addressed run: only new or changed files upload, duplicates never. */
export function completeBackupRun(state, now = Date.now(), sample = { uploaded: 214, skipped: 47997, bytes: 3.1e9 }) {
  return {
    ...state,
    backup: {
      ...state.backup,
      lastRunAt: new Date(nowMs(now)).toISOString(),
      lastRunUploaded: sample.uploaded,
      lastRunSkipped: sample.skipped,
      usedBytes: (state.backup.usedBytes || 609e9) + sample.bytes,
    },
  };
}

export const BACKUP_RUN_ACTIVE = Object.freeze(["queued", "starting", "running"]);
const BACKUP_SAMPLE = Object.freeze({ uploaded: 214, skipped: 47997, bytes: 3.1e9 });
const BACKUP_QUEUED_SECONDS = 2;
const BACKUP_START_SECONDS = 3;
const BACKUP_STEP = 12;

export const backupRunActive = (state) => BACKUP_RUN_ACTIVE.includes(state?.backup?.run?.status);

/** "Back up now": the run waits its turn, starts, runs, then settles into the last-run summary. */
export function startBackupRun(state, now = Date.now()) {
  if (backupRunActive(state)) return state;
  const ms = nowMs(now);
  return {
    ...state,
    backup: {
      ...state.backup,
      run: {
        status: "queued",
        progress: 0,
        uploaded: 0,
        skipped: 0,
        startedAt: new Date(ms).toISOString(),
        stageStartedAt: ms,
      },
    },
  };
}

/** One simulated second of a backup run. Returns the same state when nothing moved. */
export function advanceBackupRun(state, now = Date.now(), sample = BACKUP_SAMPLE) {
  const run = state?.backup?.run;
  if (!run || !BACKUP_RUN_ACTIVE.includes(run.status)) return state;
  const ms = nowMs(now);
  const since = Number.isFinite(run.stageStartedAt) ? run.stageStartedAt : ms;
  const elapsed = (ms - since) / 1000;
  const put = (patch) => ({ ...state, backup: { ...state.backup, run: { ...run, ...patch } } });
  if (backupPausedReason(state))
    return put({ status: "failed", error: backupPausedReason(state), stageStartedAt: ms });
  if (run.status === "queued")
    return elapsed >= BACKUP_QUEUED_SECONDS ? put({ status: "starting", stageStartedAt: ms }) : state;
  if (run.status === "starting")
    return elapsed >= BACKUP_START_SECONDS ? put({ status: "running", progress: 1, stageStartedAt: ms }) : state;
  const progress = Math.min(100, (Number(run.progress) || 0) + BACKUP_STEP);
  const uploaded = Math.round((sample.uploaded * progress) / 100);
  const skipped = Math.round((sample.skipped * progress) / 100);
  if (progress < 100) return put({ progress, uploaded, skipped });
  const done = completeBackupRun(state, ms, sample);
  return {
    ...done,
    backup: {
      ...done.backup,
      run: { ...run, status: "completed", progress: 100, uploaded, skipped, stageStartedAt: ms },
    },
  };
}

export function backupPausedReason(state) {
  if (!state.backup.configured) return "Cloud backup is not set up.";
  if (state.backup.keyMode === "own-memory" && !state.backup.keyLoaded)
    return "Key not loaded — backups are paused until you unlock them.";
  if (state.link.status !== "linked" && state.backup.target === "managed")
    return "This server is not linked, so managed backups are paused.";
  return null;
}

export function turnOffBackup(state) {
  return { ...state, backup: { ...createCloudState().backup } };
}

// ------------------------------------------------------------ personal link

/** A local account links its own Frameleaf account; needs the server to be linked. */
export function linkUserAccount(state, userId, email, now = Date.now()) {
  if (state.link.status !== "linked")
    throw new Error("Your administrator needs to link this server to Frameleaf first.");
  const address = typeof email === "string" ? email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Enter your Frameleaf account email.");
  const taken = Object.entries(state.userLinks || {}).find(
    ([id, link]) => id !== userId && link.email.toLowerCase() === address.toLowerCase(),
  );
  if (taken) throw new Error("That Frameleaf account is already linked to another account on this server.");
  return {
    ...state,
    userLinks: {
      ...(state.userLinks || {}),
      [userId]: { email: address, linkedAt: new Date(nowMs(now)).toISOString() },
    },
  };
}

export function unlinkUserAccount(state, userId) {
  const next = { ...(state.userLinks || {}) };
  delete next[userId];
  return { ...state, userLinks: next };
}

/** One-line status for the Overview glance tile. */
export function cloudSummary(state, now = Date.now()) {
  const license = licenseStatus(state.license, now);
  const parts = [
    state.link.status === "linked" ? "Linked" : state.link.status === "pending" ? "Linking" : "Not linked",
    state.remote.enabled ? "Remote on" : "Remote off",
    {
      none: "No plan",
      supporter: "Supporter",
      active: "Plan active",
      grace: "Plan in grace period",
      expired: "Plan expired",
    }[license.state],
    `${formatUsd(walletAvailable(state.wallet))} AI credit`,
  ];
  const attention =
    license.state === "grace" ||
    license.state === "expired" ||
    (state.backup.keyMode === "own-memory" && state.backup.configured && !state.backup.keyLoaded);
  return { text: parts.join(" · "), attention };
}

// ------------------------------------------------------------- where ML work runs

/** Turn a hardware-check result into the worker shape routing uses. */
export function workerFromHardware(sampleId, extra = {}) {
  const sample = hardwareSampleById(sampleId);
  const gpus = containerGpus(sample);
  return Object.freeze({
    id: "local",
    name: "Home workstation",
    sample: sample.id,
    gpu: gpus.ml?.name ?? "No usable GPU",
    memoryGb: gpus.ml?.vramGb ?? 0,
    backend: gpus.ml?.backend ?? "CPU",
    profile: gpus.ml?.profile ?? null,
    cpuProfile: sample.cpuProfile,
    serverGpu: gpus.server?.name ?? "No usable GPU",
    serverMemoryGb: gpus.server?.vramGb ?? 0,
    serverBackend: gpus.server?.backend ?? "CPU",
    serverProfile: gpus.server?.profile ?? null,
    ...extra,
  });
}

/** The default sample for this server's ML worker (before any hardware check). */
export const localWorker = workerFromHardware(DEFAULT_HARDWARE_SAMPLE);

/** This server's worker as detected by Hardware & GPU (follows the chosen preview state). */
export function detectedWorker(state) {
  return workerFromHardware(state?.hardware?.sample ?? DEFAULT_HARDWARE_SAMPLE);
}

/** A render worker elsewhere on the home network (Studio offers it). */
export const lanWorker = Object.freeze({
  id: "lan",
  name: "LAN worker · render.home.arpa",
  gpu: "GeForce RTX 3060",
  memoryGb: 12,
  backend: "CUDA",
  profile: "rtx3060_12",
  cpuProfile: "cpu8",
  serverGpu: "GeForce RTX 3060",
  serverMemoryGb: 12,
  serverBackend: "NVENC",
  serverProfile: "rtx3060_12",
});

/** The GPU a worker offers a workload, in the catalogue's shape (null = processor only). */
export function workerGpu(worker, workloadId) {
  if (!worker) return null;
  const server = workloadUnits[workloadId]?.container === "server";
  const memory = server ? worker.serverMemoryGb : worker.memoryGb;
  if (!(memory > 0)) return null;
  return {
    name: server ? worker.serverGpu : worker.gpu,
    vramGb: memory,
    backend: server ? worker.serverBackend : worker.backend,
    profile: server ? worker.serverProfile : worker.profile,
  };
}

/** Set the hardware-check result (a preview sample in the prototype). */
export function setHardwareSample(state, sampleId, now = Date.now()) {
  const sample = hardwareSampleById(sampleId);
  return {
    ...state,
    hardware: {
      ...(state.hardware ?? {}),
      sample: sample.id,
      checkedAt: new Date(nowMs(now)).toISOString(),
      benchmark: state.hardware?.benchmark?.sample === sample.id ? state.hardware.benchmark : null,
    },
  };
}

/** Benchmark factors apply only to the hardware they were measured on. */
export function hardwareBenchmark(state) {
  const hardware = state?.hardware;
  return hardware?.benchmark && hardware.benchmark.sample === (hardware.sample ?? DEFAULT_HARDWARE_SAMPLE)
    ? hardware.benchmark
    : null;
}

export const routingModes = Object.freeze([
  { id: "local", label: "This server", short: "Local only" },
  { id: "both", label: "Both", short: "Both" },
  { id: "cloud", label: "Frameleaf Cloud", short: "Cloud only" },
]);

/**
 * Every kind of work that uses the ML service. Cloud-capable kinds can be
 * routed; the rest stay on this server by design.
 */
export const mlWorkloads = Object.freeze([
  {
    id: "search",
    name: "Smart search",
    use: "Finds photos by what is in them.",
    cloud: false,
    localGb: 2,
    why: "Search runs on this server so results always match your own index.",
  },
  {
    id: "faces",
    name: "Face recognition",
    use: "Groups people in People.",
    cloud: false,
    localGb: 2,
    why: "Faces never leave this server.",
  },
  {
    id: "ocr",
    name: "Text in photos",
    use: "Makes signs, receipts and documents searchable.",
    cloud: false,
    localGb: 2,
    why: "Runs quickly on this server.",
  },
  {
    id: "descriptions",
    name: "Descriptions & tags",
    use: "Captions, tags and moments for Library care.",
    cloud: true,
    localGb: 8,
  },
  {
    id: "upscale",
    name: "Enhance & upscale",
    use: "Sharper, larger photos from the editor.",
    cloud: true,
    localGb: 6,
  },
  {
    id: "restoration",
    name: "Video restoration",
    use: "Faithful and Creative restoration in the editor and Studio.",
    cloud: true,
    localGb: 12,
  },
  {
    id: "studio",
    name: "Transcripts & captions",
    use: "Studio transcription and captions.",
    cloud: true,
    localGb: 4,
  },
  {
    id: "interpolation",
    name: "Smooth motion",
    use: "Higher frame rates and smooth slow motion for videos.",
    cloud: true,
    localGb: 2,
  },
  {
    id: "render",
    name: "Studio export",
    use: "Rendering finished videos from Studio.",
    cloud: false,
    localGb: 0,
    why: "Exports render on this server or another computer on your home network.",
  },
]);

export function workloadById(id) {
  return mlWorkloads.find((item) => item.id === id) ?? null;
}

/**
 * Whether a worker can run the workload itself; with the reason when not.
 * Workloads with a model ladder can run locally when any position fits the
 * worker's GPU or has a processor path.
 */
export function localCapability(workloadId, worker = localWorker) {
  const workload = workloadById(workloadId);
  if (!workload) return { ok: false, reason: "Unknown kind of work." };
  if (!worker) return { ok: false, reason: "No local ML worker is connected." };
  const gpu = workerGpu(worker, workloadId);
  const label = gpu ? `${gpu.name} (${gpu.vramGb} GB)` : "the processor";
  if (LADDER_WORKLOADS.includes(workloadId)) {
    const ladder = ladderFor(workloadId);
    const fits = ladder.filter((item) => ["gpu", "cpu"].includes(bandFor(item, gpu, worker.cpuProfile)));
    if (fits.length) return { ok: true, reason: `Runs on ${label}: up to ${fits[fits.length - 1].name}.` };
    const needs = Math.min(...ladder.map(minVramGb).filter((value) => value !== null));
    return {
      ok: false,
      reason: gpu
        ? `Needs about ${needs} GB of GPU memory; ${gpu.name} has ${gpu.vramGb} GB.`
        : `Needs a GPU with about ${needs} GB of memory; this server has no usable GPU.`,
    };
  }
  if (gpu && gpu.vramGb >= workload.localGb) return { ok: true, reason: `Fits on ${label}.` };
  return gpu
    ? { ok: false, reason: `Needs ${workload.localGb} GB of GPU memory; ${gpu.name} has ${gpu.vramGb} GB.` }
    : { ok: true, reason: "Runs on the processor; a GPU makes it faster." };
}

/** The smallest GPU memory any position of the workload needs (for short labels). */
export function localGbNeeded(workloadId) {
  const workload = workloadById(workloadId);
  if (!LADDER_WORKLOADS.includes(workloadId)) return workload?.localGb ?? 0;
  const values = ladderFor(workloadId).map(minVramGb).filter((value) => value !== null);
  return values.length ? Math.min(...values) : 0;
}

export function workloadRoute(state, workloadId) {
  const workload = workloadById(workloadId);
  if (!workload?.cloud) return "local";
  const value = state?.processing?.routing?.[workloadId];
  return routingModes.some((mode) => mode.id === value) ? value : "local";
}

export function setWorkloadRoute(state, workloadId, mode) {
  const workload = workloadById(workloadId);
  if (!workload) throw new Error("Unknown kind of work.");
  if (!routingModes.some((item) => item.id === mode)) throw new Error("Choose where this work runs.");
  if (!workload.cloud && mode !== "local") throw new Error(workload.why);
  return {
    ...state,
    processing: {
      ...state.processing,
      routing: { ...(state.processing.routing ?? {}), [workloadId]: mode },
    },
  };
}

/**
 * The destinations a single job may offer, in order: each local or home-network
 * worker, then Frameleaf Cloud. A destination that is not allowed or cannot run
 * stays listed with its reason, and a job never moves between them on its own.
 */
export function jobDestinations(state, workloadId, workers = [detectedWorker(state)]) {
  const route = workloadRoute(state, workloadId);
  const cloudRefusal = cloudAdmission(state, null);
  return [
    ...workers.map((worker) => {
      const fit = localCapability(workloadId, worker);
      return {
        id: worker.id,
        name: worker.id === "local" ? `${worker.name} · this server` : worker.name,
        available: route !== "cloud" && fit.ok,
        reason: route === "cloud" ? "Set to Frameleaf Cloud only for this kind of work." : fit.reason,
      };
    }),
    {
      id: "cloud",
      name: "Frameleaf Cloud",
      available: route !== "local" && !cloudRefusal,
      reason:
        route === "local"
          ? "Set to this server only for this kind of work."
          : cloudRefusal || "Pay per job from your AI Wallet. You confirm the cost first.",
    },
  ];
}

/** The destination to preselect: the saved preference when it is available, else the first that is. */
export function preferredDestination(state, workloadId, preferred = "local", workers = [detectedWorker(state)]) {
  const options = jobDestinations(state, workloadId, workers).filter((item) => item.available);
  return (options.find((item) => item.id === preferred) ?? options[0])?.id ?? null;
}

export function routeSummary(state, workloadId, worker = detectedWorker(state)) {
  const route = workloadRoute(state, workloadId);
  const local = localCapability(workloadId, worker);
  if (route === "local" && !local.ok)
    return { tone: "warning", text: `${local.reason} Allow Frameleaf Cloud to run this work.` };
  if (route === "both")
    return {
      tone: "ok",
      text: local.ok
        ? "Each job lets you pick this server or Frameleaf Cloud."
        : "This server can’t run it, so jobs offer Frameleaf Cloud.",
    };
  if (route === "cloud") return { tone: "ok", text: "Jobs run on Frameleaf Cloud and show the cost first." };
  return { tone: "ok", text: local.reason };
}

// ---------------------------------------------------------------- restore

/** A replaced file is moved here, relative to the media folder. Nothing is deleted. */
export const RESTORE_REPLACED_PATH = "frameleaf/restore/replaced";

export const restoreDetailsOptions = Object.freeze([
  {
    id: "keep",
    title: "Keep current details",
    detail: "Only the file comes back. Favourites, albums, people and edits stay as they are.",
  },
  {
    id: "fill",
    title: "Fill in missing details",
    detail: "Values from the backup fill empty fields. Anything already set is kept.",
  },
  {
    id: "replace",
    title: "Replace current details",
    detail: "Fields that differ go back to the backup’s values.",
  },
]);

export const libraryRestoreSteps = Object.freeze([
  { id: "database", title: "Database", detail: "The paired nightly database backup, through maintenance restore." },
  { id: "files", title: "Files", detail: "Every original and sidecar the database references." },
  { id: "verify", title: "Verify", detail: "Each file is checked against its fingerprint." },
  { id: "thumbnails", title: "Rebuild thumbnails", detail: "Thumbnails, previews and video transcodes are regenerated." },
]);

/** Kept backups that hold a file, newest first. The newest one listed is where the file first appears. */
export function manifestsWithFile(newestId, since = null) {
  const start = backupManifests.findIndex((item) => item.id === newestId);
  if (start < 0) return [];
  const kept = backupManifests.slice(start);
  return since ? kept.filter((item) => item.createdAt >= since) : kept;
}

/**
 * Deleted items can come back for as long as the oldest kept manifest lists them.
 * Retention keeps 7 daily, 4 weekly and 12 monthly manifests, so about a year.
 */
export const recoverableSince = () => backupManifests[backupManifests.length - 1]?.createdAt ?? null;

/** Sample contents of the kept backups for Settings › Backup › Restore. */
export const restoreSampleItems = Object.freeze([
  { id: "ri-1", name: "IMG_2041.HEIC", ownerId: "taylor", owner: "Taylor", takenAt: "2026-08-14T09:12:00Z", bytes: 3.2e6, inLibrary: false, deletedAt: "2026-09-24T18:40:00Z", newest: "m-2026-09-24" },
  { id: "ri-2", name: "Lake morning.mov", ownerId: "taylor", owner: "Taylor", takenAt: "2026-08-15T06:48:00Z", bytes: 412e6, inLibrary: true, newest: "m-2026-09-25" },
  { id: "ri-3", name: "Campfire evening.jpg", ownerId: "taylor", owner: "Taylor", takenAt: "2026-07-22T21:05:00Z", bytes: 5.1e6, inLibrary: false, deletedAt: "2026-09-06T11:02:00Z", newest: "m-2026-09-01" },
  { id: "ri-4", name: "Hiking with Jamie.jpg", ownerId: "jamie", owner: "Jamie", takenAt: "2025-09-13T15:30:00Z", bytes: 4.4e6, inLibrary: false, deletedAt: "2026-09-24T20:15:00Z", newest: "m-2026-09-24" },
  { id: "ri-5", name: "DSC_2210.NEF", ownerId: "taylor", owner: "Taylor", takenAt: "2026-07-03T17:44:00Z", bytes: 24.8e6, inLibrary: true, newest: "m-2026-09-25" },
  { id: "ri-7", name: "PANO_0018.jpg", ownerId: "taylor", owner: "Taylor", takenAt: "2024-10-12T16:20:00Z", bytes: 18.6e6, inLibrary: false, deletedAt: "2025-11-03T19:05:00Z", newest: "m-2025-10-01" },
  { id: "ri-6", name: "Skating.mp4", ownerId: "jamie", owner: "Jamie", takenAt: "2025-12-28T14:02:00Z", bytes: 188e6, inLibrary: true, newest: "m-2026-09-25" },
]);

export const restoreSampleAlbums = Object.freeze([
  { id: "ra-1", name: "Lake house weekend", ownerId: "taylor", items: 84, status: "deleted", deletedAt: "2026-09-24T21:10:00Z", newest: "m-2026-09-24" },
  { id: "ra-2", name: "Moraine Lake", ownerId: "taylor", items: 212, status: "damaged", missing: 3, corrupt: 1, newest: "m-2026-09-25" },
  { id: "ra-3", name: "Winter 2025", ownerId: "jamie", items: 57, status: "deleted", deletedAt: "2026-09-12T09:30:00Z", newest: "m-2026-09-01" },
]);

/**
 * Items in the chosen backup. filter: "all" | "deleted" | "in-library".
 * ownerId limits a non-admin to their own items; a restore never touches another user's items.
 */
export function searchRestoreItems({ manifestId, query = "", filter = "all", ownerId = null } = {}) {
  const chosen = backupManifests.find((item) => item.id === manifestId) ?? backupManifests[0];
  const text = String(query).trim().toLowerCase();
  return restoreSampleItems.filter(
    (item) =>
      manifestsWithFile(item.newest, item.takenAt).some((manifest) => manifest.id === chosen.id) &&
      (!ownerId || item.ownerId === ownerId) &&
      (filter === "all" || (filter === "deleted" ? !item.inLibrary : item.inLibrary)) &&
      (!text || item.name.toLowerCase().includes(text)),
  );
}

export const RESTORE_RUN_ACTIVE = Object.freeze(["queued", "running"]);
export const restoreRunActive = (state) => RESTORE_RUN_ACTIVE.includes(state?.backup?.restoreRun?.status);

/** Queue a restore. It runs as a media operation with progress in Activity. */
export function startRestoreRun(state, { title, files = 1, steps = null, details = "keep" } = {}, now = Date.now()) {
  if (restoreRunActive(state)) throw new Error("A restore is already running. Wait for it to finish.");
  const ms = nowMs(now);
  return {
    ...state,
    backup: {
      ...state.backup,
      restoreRun: {
        status: "queued",
        title: String(title || "Restore from backup"),
        files: Math.max(1, Number(files) || 1),
        steps: Array.isArray(steps) ? steps : null,
        // How the item's details come back: "keep" | "fill" | "replace".
        details: restoreDetailsOptions.some((option) => option.id === details) ? details : "keep",
        progress: 0,
        startedAt: new Date(ms).toISOString(),
        stageStartedAt: ms,
      },
    },
  };
}

/** One simulated second of a restore. Returns the same state when nothing moved. */
export function advanceRestoreRun(state, now = Date.now()) {
  const run = state?.backup?.restoreRun;
  if (!run || !RESTORE_RUN_ACTIVE.includes(run.status)) return state;
  const ms = nowMs(now);
  const put = (patch) => ({ ...state, backup: { ...state.backup, restoreRun: { ...run, ...patch } } });
  if (run.status === "queued")
    return (ms - (run.stageStartedAt ?? ms)) / 1000 >= 2 ? put({ status: "running", progress: 1, stageStartedAt: ms }) : state;
  const progress = Math.min(100, (Number(run.progress) || 0) + (run.steps ? 5 : 20));
  return put(progress < 100 ? { progress } : { status: "completed", progress: 100, stageStartedAt: ms });
}

/** "Step 2 of 4 · Files" for a whole-library restore, or the file count otherwise. */
export function restoreRunStage(run) {
  if (!run) return "";
  if (!run.steps?.length) return `${run.files.toLocaleString("en-US")} ${run.files === 1 ? "file" : "files"}`;
  const index = Math.min(run.steps.length - 1, Math.floor(((Number(run.progress) || 0) / 100) * run.steps.length));
  return `Step ${index + 1} of ${run.steps.length} · ${run.steps[index]}`;
}
