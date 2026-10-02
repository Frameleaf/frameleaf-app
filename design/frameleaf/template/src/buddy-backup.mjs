// Fictional, local-only design state. This module never contacts a server.
export const BUDDY_STORAGE_KEY = "frameleaf:buddy-design:v1";
export const BUDDY_SCENARIOS = {
  current: "Up to date",
  unpaired: "Not paired",
  initial: "Initial backup",
  incremental: "Incremental backup",
  offline: "Buddy offline",
  quota: "Waiting for quota",
  auth: "Cloud authorization needed",
  subscription: "Subscription expired",
  key: "Recovery key needed",
  stale: "Backup overdue",
  capacity: "Hosting disk nearly full",
  integrity: "Verification failed",
  window: "Outside backup window",
  ending: "30-day recovery window",
  blocked: "Security block",
};

export function createBuddyState() {
  return {
    version: 1,
    scenario: "current",
    paired: true,
    buddy: "Jamie’s home server",
    sendingPaused: false,
    receivingPaused: false,
    receivingActive: false,
    recoveryAttached: false,
    hasRecoveryPoint: true,
    lastVerified: "30 Sep, 14:32",
    escrow: false,
    connection: "direct",
    outgoingGB: 684.2,
    incomingGB: 412.8,
    outgoingQuotaGB: 1000,
    incomingQuotaGB: 750,
    controls: {
      sendMbps: 20,
      receiveMbps: 20,
      concurrent: 2,
      start: "02:00",
      end: "06:00",
      daily: 30,
      monthly: 12,
    },
  };
}

export function loadBuddyState(storage) {
  const initial = createBuddyState();
  try {
    const saved = JSON.parse(storage?.getItem(BUDDY_STORAGE_KEY) || "null");
    if (saved?.version !== 1 || !Object.hasOwn(BUDDY_SCENARIOS, saved.scenario))
      return initial;
    return {
      ...initial,
      ...saved,
      controls: { ...initial.controls, ...saved.controls },
    };
  } catch {
    return initial;
  }
}

export function previewBuddyScenario(state, scenario) {
  if (!Object.hasOwn(BUDDY_SCENARIOS, scenario)) return state;
  return {
    ...state,
    scenario,
    paired: scenario !== "unpaired",
    recoveryAttached: false,
    sendingPaused: false,
    ...(["unpaired", "initial"].includes(scenario)
      ? { lastVerified: null }
      : {}),
    hasRecoveryPoint: !["unpaired", "initial"].includes(scenario),
  };
}

export function validateBuddyAgreement({ outgoingQuotaGB, incomingQuotaGB }) {
  if (
    !Number.isFinite(Number(outgoingQuotaGB)) ||
    Number(outgoingQuotaGB) < 684.2
  )
    return "Your 684.2 GB library needs at least 684.2 GB at your buddy’s server.";
  if (Number(outgoingQuotaGB) > 1500)
    return "Your buddy can currently offer up to 1,500 GB.";
  if (
    !Number.isFinite(Number(incomingQuotaGB)) ||
    Number(incomingQuotaGB) < 412.8
  )
    return "Keep at least 412.8 GB for the encrypted data already hosted here.";
  if (Number(incomingQuotaGB) > 950)
    return "You can offer up to 950 GB: 1,200 GB free, less a 250 GB safety reserve.";
  return "";
}

export function validateBuddyControls(value) {
  if (
    ![value.sendMbps, value.receiveMbps].every(
      (n) => Number.isFinite(Number(n)) && Number(n) >= 1 && Number(n) <= 1000,
    )
  )
    return "Choose a send and receive limit between 1 and 1,000 Mbit/s.";
  if (![1, 2].includes(Number(value.concurrent)))
    return "Choose one or two concurrent transfers.";
  if (
    ![value.start, value.end].every((s) =>
      /^([01]\d|2[0-3]):[0-5]\d$/.test(s),
    ) ||
    value.start === value.end
  )
    return "Choose different start and end times for the backup window.";
  if (
    ![value.daily, value.monthly].every(
      (n) => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 365,
    )
  )
    return "Retention must keep between 1 and 365 daily and monthly recovery points.";
  return "";
}

export function buddyStatus(state) {
  const progress =
    state.scenario === "initial"
      ? 38
      : state.scenario === "incremental"
        ? 66
        : 100;
  const alerts = {
    offline: [
      "Buddy is offline",
      "Your last recovery point is kept. Sending resumes when Jamie’s server reconnects.",
      "Retry connection",
    ],
    quota: [
      "More space needed at your buddy",
      "The next backup would exceed your agreed quota. Keep the existing recovery points and request more space.",
      "Review agreement",
    ],
    auth: [
      "Reconnect Frameleaf Cloud",
      "Authorize your Cloud account to access this backup. Existing encrypted data is kept; an expired subscription does not prevent recovery.",
      "Review connection",
    ],
    subscription: [
      "Subscription expired · transfers paused",
      "New sending and hosting transfers need active subscriptions. You can still recover your existing backup with account authorization and your recovery kit.",
      "Restore my backup",
    ],
    key: [
      "Recovery key needed",
      "Unlock your key on this server to resume sending or restore your backup.",
      "Unlock recovery key",
    ],
    stale: [
      "No successful backup for 3 days",
      "Your latest recovery point is older than your daily schedule. Check the connection and run a backup.",
      "Run backup",
    ],
    capacity: [
      "Hosting disk nearly full",
      "Only 58 GB of usable space remains here. Receiving is waiting so your library keeps its safety reserve.",
      "Review hosting space",
    ],
    integrity: [
      "A restore verification did not match",
      "Your last known-good recovery point is kept. Check the affected backup before trusting a new one.",
      "Verify restore",
    ],
    window: [
      "Waiting for the backup window",
      `New transfers start at ${state.controls.start} in America/Edmonton. Incomplete work resumes without starting over.`,
      "Review schedule",
    ],
    ending: [
      "Partnership is ending",
      "Sending and receiving have stopped. Existing backups remain readable until 1 Nov 2026; move your backup before then.",
      "Restore my backup",
    ],
    blocked: [
      "Partnership blocked for security",
      "Read and write access are blocked immediately in both directions. Contact your buddy outside Frameleaf before reconnecting.",
      "Review partnership",
    ],
  };
  return {
    progress,
    recoveryPoint:
      state.scenario === "stale" ? "29 Sep 2026, 02:14" : "2 Oct 2026, 02:14",
    verification:
      state.scenario === "integrity"
        ? "Failed · 2 Oct, 12:10"
        : state.lastVerified || "Not verified yet",
    storedGB:
      state.scenario === "initial"
        ? Number(((state.outgoingGB * progress) / 100).toFixed(1))
        : state.outgoingGB,
    label:
      !state.paired && state.recoveryAttached
        ? "Recovery only"
        : state.sendingPaused
          ? "Sending paused"
          : BUDDY_SCENARIOS[state.scenario],
    receiving: !state.paired
      ? "Not hosting"
      : state.scenario === "blocked"
        ? "Access blocked"
        : state.scenario === "ending"
          ? "Read window only"
          : state.scenario === "subscription"
            ? "Subscription expired · receiving paused"
            : state.scenario === "auth"
              ? "Authorization required"
              : state.receivingPaused
                ? "Receiving paused"
                : state.scenario === "capacity"
                  ? "Waiting for free space"
                  : state.receivingActive
                    ? "Receiving encrypted data"
                    : "Ready to receive",
    alert: alerts[state.scenario] || null,
    canRestore:
      (state.paired || state.recoveryAttached) &&
      state.hasRecoveryPoint &&
      !["blocked", "key", "auth", "offline"].includes(state.scenario),
    canAttachRecovery: !["blocked", "auth", "offline"].includes(state.scenario),
    canReceive:
      state.paired &&
      ![
        "blocked",
        "ending",
        "auth",
        "subscription",
        "offline",
        "capacity",
      ].includes(state.scenario) &&
      !state.receivingPaused,
    canSend:
      state.paired &&
      ["current", "stale", "initial", "incremental"].includes(state.scenario) &&
      !state.sendingPaused,
  };
}

// Reading or checking a key must never restart a stopped partnership.
export function unlockBuddyKey(state) {
  return state.scenario === "key" ? { ...state, scenario: "current" } : state;
}

export function verifyBuddyRecovery(state, verifiedAt) {
  return buddyStatus(state).canRestore
    ? { ...state, lastVerified: verifiedAt }
    : state;
}

export function attachBuddyRecovery(
  state,
  { cloudAuthorized, verificationCode },
) {
  if (
    !buddyStatus(state).canAttachRecovery ||
    !cloudAuthorized ||
    verificationCode?.trim() !== SAMPLE_RECOVERY_KIT.verificationCode
  )
    return state;
  return {
    ...unlockBuddyKey(state),
    recoveryAttached: true,
    hasRecoveryPoint: true,
  };
}

// These are the source owner's items only. Hosting has no media catalogue.
export const OWN_BACKUP_ITEMS = [
  {
    id: "lake",
    name: "Lake morning.heic",
    detail: "14 Aug 2026 · 3.2 MB",
    state: "Deleted",
    album: "Lake house weekend",
  },
  {
    id: "film",
    name: "Summer on film.mov",
    detail: "15 Aug 2026 · 412 MB",
    state: "Damaged",
    album: "Lake house weekend",
  },
  {
    id: "raw",
    name: "DSC_2210.NEF",
    detail: "3 Jul 2026 · 24.8 MB",
    state: "In library",
    album: "Mountain mornings",
  },
];

export const SAMPLE_RECOVERY_KIT = {
  format: "frameleaf-buddy-design-kit",
  demoOnly: true,
  owner: "Taylor",
  verificationCode: "LEAF-4826",
  message:
    "Design sample only. Contains no encryption key and cannot recover real data.",
};
