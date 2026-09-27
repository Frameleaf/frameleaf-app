// The linked-server tour: a short, skippable sheet an administrator lands on right
// after this server is linked to Frameleaf Cloud outside first-run setup. It shows
// what the link unlocks and links each part to its settings page. Pure data and
// rules only; CloudTour.jsx renders it. Proposed design, pending owner approval.

import {
  cloudPlans,
  formatUsd,
  licenseStatus,
  activeEntitlements,
  isLicensed,
  walletAvailable,
  LICENSED_DISCOUNT,
} from "./frameleaf-cloud-data.mjs";

export const CLOUD_TOUR_KEY = "frameleaf:cloud-tour:v1";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lowestPrice = () => Math.min(...cloudPlans.filter((plan) => plan.period === "month").map((plan) => plan.price));

/**
 * Each step: an icon tile, a title, a one-line summary, up to three points and the
 * settings pages it opens ({ area, section } as CommandCenter.navigate takes them).
 */
export const cloudTourSteps = Object.freeze([
  Object.freeze({
    id: "remote",
    icon: "mdiEarth",
    tile: "#0a84ff",
    title: "Reach your photos from anywhere",
    summary:
      "Open your library and the Frameleaf apps away from home, without opening ports or managing certificates.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiTransitConnectionVariant",
        title: "Relay",
        text: "Works behind any router. The relay carries encrypted traffic and never sees inside it.",
      }),
      Object.freeze({
        icon: "mdiLightningBolt",
        title: "Direct connection",
        text: "Faster, and free of the relay allowance. Frameleaf asks your router to open the port for you.",
      }),
      Object.freeze({
        icon: "mdiCellphone",
        title: "Frameleaf apps",
        text: "Sign in on iPhone, iPad or Android and this server appears automatically.",
      }),
    ]),
    links: Object.freeze([Object.freeze({ label: "Remote access", area: "cloud", section: "cloud-remote" })]),
  }),
  Object.freeze({
    id: "address",
    icon: "mdiWeb",
    tile: "#30b0c7",
    title: "An address of your own",
    summary:
      "Your server gets a private Frameleaf address with its own certificate. You can use a domain you own instead.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiLinkVariant",
        title: "Frameleaf address",
        text: "Ready as soon as remote access is on. Share it, or scan its QR code on a phone.",
      }),
      Object.freeze({
        icon: "mdiDns",
        title: "Your own domain",
        text: "Point a name such as photos.example.com at Frameleaf with one DNS record.",
      }),
      Object.freeze({
        icon: "mdiCertificateOutline",
        title: "Certificate on your server",
        text: "Renewed automatically. The private key never leaves this server.",
      }),
    ]),
    links: Object.freeze([Object.freeze({ label: "Addresses", area: "cloud", section: "cloud-remote" })]),
  }),
  Object.freeze({
    id: "signin",
    icon: "mdiShieldAccountOutline",
    tile: "#5856d6",
    title: "Sign in with Frameleaf",
    summary:
      "People can sign in with their Frameleaf account alongside passwords and your own sign-in provider.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiHomeOutline",
        title: "At home, nothing changes",
        text: "Everyone keeps signing in the way they do now.",
      }),
      Object.freeze({
        icon: "mdiEarth",
        title: "Away from home",
        text: "Remote visitors always sign in with a Frameleaf account linked to their account here.",
      }),
      Object.freeze({
        icon: "mdiAccountMultipleOutline",
        title: "Each person links their own",
        text: "From Your preferences → Frameleaf account. You never see their password.",
      }),
    ]),
    links: Object.freeze([
      Object.freeze({ label: "Sign in with Frameleaf", area: "security", section: "frameleaf-signin" }),
    ]),
  }),
  Object.freeze({
    id: "processing",
    icon: "mdiCloudSyncOutline",
    tile: "#5e5ce6",
    ai: true,
    title: "Cloud AI when you choose it",
    summary:
      "Send chosen jobs to Frameleaf Cloud's GPUs. Your own computers stay the default.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiTextBoxOutline",
        title: "Descriptions and restoration",
        text: "Richer descriptions and tags, enhancement, upscaling and video restoration.",
      }),
      Object.freeze({
        icon: "mdiWalletOutline",
        title: "AI Wallet, paid per job",
        text: "Prepaid credit in US dollars. Every job shows its model and price before it starts.",
      }),
      Object.freeze({
        icon: "mdiHandBackRightOutline",
        title: "Nothing goes without asking",
        text: "Turn it on and accept the processing terms first. Faces are always recognised here.",
      }),
    ]),
    links: Object.freeze([
      Object.freeze({ label: "Cloud processing", area: "cloud", section: "cloud-processing" }),
    ]),
  }),
  Object.freeze({
    id: "backup",
    icon: "mdiCloudUploadOutline",
    tile: "#30d158",
    title: "Encrypted off-site backup",
    summary:
      "Keep a copy of your originals and library off-site, encrypted with a key only you hold.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiContentDuplicate",
        title: "Only what changed uploads",
        text: "A photo you have twice is stored once.",
      }),
      Object.freeze({
        icon: "mdiBackupRestore",
        title: "Restore what you need",
        text: "One photo, an album, a person or the whole library, with its details and albums.",
      }),
      Object.freeze({
        icon: "mdiKeyOutline",
        title: "Your key, your recovery kit",
        text: "Frameleaf cannot read your backups. Keep the recovery kit somewhere safe.",
      }),
    ]),
    links: Object.freeze([Object.freeze({ label: "Cloud backup", area: "cloud", section: "cloud-backup" })]),
  }),
  Object.freeze({
    id: "plan",
    icon: "mdiCloudCheckOutline",
    tile: "#8e8e93",
    title: "Your plan, and where it all lives",
    summary:
      "Everything here is in Settings → Frameleaf Cloud. The overview shows its status at a glance.",
    points: Object.freeze([
      Object.freeze({
        icon: "mdiCreditCardOutline",
        title: "Plan",
        text: `Remote access and cloud backup come with a Frameleaf Cloud plan, from ${formatUsd(lowestPrice(), 0)} a month.`,
      }),
      Object.freeze({
        icon: "mdiCertificateOutline",
        title: "Licence",
        text: `Supporters activate a key or install a licence file. Licensed servers save ${Math.round(LICENSED_DISCOUNT * 100)}% on plans.`,
      }),
      Object.freeze({
        icon: "mdiViewDashboardOutline",
        title: "One place",
        text: "Account & link, plan, licence, remote access, processing and backup, side by side.",
      }),
    ]),
    links: Object.freeze([
      Object.freeze({ label: "Plan", area: "cloud", section: "cloud-plan" }),
      Object.freeze({ label: "Licence", area: "cloud", section: "cloud-license" }),
      Object.freeze({ label: "Frameleaf Cloud", area: "cloud", section: "" }),
    ]),
  }),
]);

/** Where each part stands right now, so the tour never promises what is not set up. */
export function cloudTourStatus(stepId, state, now = Date.now()) {
  const included = activeEntitlements(state.license, now);
  const needsPlan = { label: "Needs a plan", tone: "muted" };
  switch (stepId) {
    case "remote":
      if (!included.remoteAccess) return needsPlan;
      return state.remote.enabled ? { label: "On", tone: "ok" } : { label: "Ready to turn on", tone: "muted" };
    case "address":
      if (!included.remoteAccess) return needsPlan;
      if (state.remote.customHostnameStatus === "verified") return { label: "Own domain verified", tone: "ok" };
      return state.remote.enabled ? { label: "Frameleaf address ready", tone: "ok" } : { label: "Ready to turn on", tone: "muted" };
    case "signin":
      return { label: "Available", tone: "ok" };
    case "processing":
      return state.processing.enabled
        ? { label: `On · ${formatUsd(walletAvailable(state.wallet))} AI credit`, tone: "ok" }
        : { label: `Off · ${formatUsd(walletAvailable(state.wallet))} AI credit`, tone: "muted" };
    case "backup":
      if (!included.cloudBackup) return needsPlan;
      return state.backup.configured ? { label: "On", tone: "ok" } : { label: "Ready to set up", tone: "muted" };
    case "plan": {
      const status = licenseStatus(state.license, now);
      const plan = state.license.plan ? status.label : "No plan";
      return {
        label: isLicensed(state.license) ? `${plan} · Licensed` : plan,
        tone: status.state === "active" ? "ok" : status.state === "grace" || status.state === "expired" ? "warning" : "muted",
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- once per admin

export function createCloudTour() {
  return { version: 1, seenBy: {} };
}

export function loadCloudTour(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(CLOUD_TOUR_KEY) ?? "null");
    if (record(parsed) && parsed.version === 1 && record(parsed.seenBy)) {
      const seenBy = Object.fromEntries(
        Object.entries(parsed.seenBy).filter(
          ([, entry]) => record(entry) && typeof entry.at === "string" && typeof entry.how === "string",
        ),
      );
      return { version: 1, seenBy };
    }
  } catch {
    // Blocked storage: the tour may show again next time, which is harmless.
  }
  return createCloudTour();
}

export function saveCloudTour(tour, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CLOUD_TOUR_KEY, JSON.stringify(tour));
    return true;
  } catch {
    return false;
  }
}

/** How a tour ended for an admin: finished, skipped, left for a settings page, or covered by setup. */
export const TOUR_ENDINGS = Object.freeze(["finished", "skipped", "opened-settings", "setup"]);

export function markCloudTourSeen(tour, adminId, how, now = Date.now()) {
  if (!adminId) return tour;
  if (!TOUR_ENDINGS.includes(how)) throw new Error(`Unknown tour ending: ${how}`);
  if (tour.seenBy[adminId]) return tour;
  return {
    ...tour,
    seenBy: { ...tour.seenBy, [adminId]: { at: new Date(now).toISOString(), how } },
  };
}

/**
 * Offer the tour automatically when the server is linked, the viewer is an
 * administrator who has not seen it, and first-run setup is not running (setup has
 * its own summary and marks the tour as covered when it links). Everyone else can
 * still open it from Settings → Frameleaf Cloud → Account & link.
 */
export function shouldOfferCloudTour({ tour, adminId, isAdmin, linkStatus, inSetup = false }) {
  return Boolean(isAdmin && adminId && linkStatus === "linked" && !inSetup && !tour?.seenBy?.[adminId]);
}

/** Clamp a requested step (from ?tourStep= or the keyboard) into range. */
export function clampTourStep(value) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index)) return 0;
  return Math.min(cloudTourSteps.length - 1, Math.max(0, index));
}
