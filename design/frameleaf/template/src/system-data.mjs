// Pure state for the surfaces outside the library: notifications, upload and
// download simulation, onboarding, supporter keys, maintenance, password rules
// and the About information. No DOM access; storage is injected for tests.

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 512) =>
  typeof value === "string" && value.length <= max;
const isoDate = (value) => text(value, 64) && !Number.isNaN(Date.parse(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const nowIso = (now) =>
  (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "file";

function readStorage(key, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}
function writeStorage(key, value, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function parseJson(raw) {
  if (typeof raw !== "string" || raw.length > 200_000) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** Calm relative time for lists: "Just now", "5 min ago", "Yesterday", "12 Sep". */
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, +new Date(now) - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(then);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function validateEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
  );
}

// ---------------------------------------------------------------- notifications

export const NOTIFICATIONS_KEY = "frameleaf:notifications:v1";
export const notificationTypes = Object.freeze({
  "album-invite": {
    icon: "mdiAccountMultiplePlusOutline",
    tone: "info",
    label: "Album invitation",
  },
  "album-update": {
    icon: "mdiImageMultipleOutline",
    tone: "info",
    label: "Album update",
  },
  "job-done": {
    icon: "mdiCheckCircleOutline",
    tone: "success",
    label: "Job finished",
  },
  "storage-warning": {
    icon: "mdiHarddisk",
    tone: "warning",
    label: "Storage",
  },
  "new-version": { icon: "mdiUpdate", tone: "info", label: "New version" },
  system: { icon: "mdiInformationOutline", tone: "info", label: "System" },
});
const SAMPLE_NOTIFICATIONS = Object.freeze([
  {
    id: "notice-invite-lake",
    type: "album-invite",
    title: "Jamie invited you to “Summer in the Rockies”",
    body: "12 photos and 2 videos are waiting for you.",
    minutesAgo: 14,
    read: false,
    target: { kind: "album", id: "summer-rockies", label: "Summer in the Rockies" },
  },
  {
    id: "notice-update-family",
    type: "album-update",
    title: "Emma added 8 photos to “Family”",
    body: "Three are from the cabin weekend.",
    minutesAgo: 3 * 60 + 10,
    read: false,
    target: { kind: "album", id: "family", label: "Family" },
  },
  {
    id: "notice-job-search",
    type: "job-done",
    title: "Smart search finished",
    body: "1,284 photos are ready for natural-language search.",
    minutesAgo: 7 * 60,
    read: false,
    target: { kind: "jobs", label: "Jobs" },
  },
  {
    id: "notice-storage",
    type: "storage-warning",
    title: "Storage is 85% full",
    body: "About 120 GB remain on the photos volume.",
    minutesAgo: 26 * 60,
    read: true,
    target: { kind: "storage", label: "Storage" },
  },
  {
    id: "notice-version",
    type: "new-version",
    title: "Frameleaf 2026.9 is available",
    body: "Faster timeline scrolling and improved face grouping.",
    minutesAgo: 3 * 24 * 60,
    read: true,
    target: { kind: "about", label: "About Frameleaf" },
  },
]);

export function sampleNotifications(now = Date.now()) {
  const base = +new Date(now);
  return SAMPLE_NOTIFICATIONS.map(({ minutesAgo, read, ...item }) => {
    const createdAt = new Date(base - minutesAgo * 60_000).toISOString();
    return {
      ...item,
      target: { ...item.target },
      createdAt,
      readAt: read ? new Date(base - (minutesAgo - 5) * 60_000).toISOString() : null,
    };
  });
}

function validNotification(item) {
  return (
    record(item) &&
    text(item.id, 80) &&
    item.id.trim() &&
    Object.hasOwn(notificationTypes, item.type) &&
    text(item.title, 200) &&
    text(item.body ?? "", 600) &&
    isoDate(item.createdAt) &&
    (item.readAt === null || isoDate(item.readAt)) &&
    (item.target === null || (record(item.target) && text(item.target.kind, 40)))
  );
}
/** Returns the stored list or null when the shape is untrusted. */
export function parseNotifications(raw) {
  const source = parseJson(raw);
  if (!record(source) || source.version !== 1 || !Array.isArray(source.items))
    return null;
  if (source.items.length > 200 || !source.items.every(validNotification))
    return null;
  const ids = new Set(source.items.map((item) => item.id));
  if (ids.size !== source.items.length) return null;
  return source.items.map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body ?? "",
    createdAt: item.createdAt,
    readAt: item.readAt,
    target: item.target
      ? {
          kind: item.target.kind,
          ...(text(item.target.id, 120) ? { id: item.target.id } : {}),
          ...(text(item.target.label, 120) ? { label: item.target.label } : {}),
        }
      : null,
  }));
}
export function loadNotifications(storage, now = Date.now()) {
  return (
    parseNotifications(readStorage(NOTIFICATIONS_KEY, storage)) ??
    sampleNotifications(now)
  );
}
export function saveNotifications(items, storage) {
  return writeStorage(
    NOTIFICATIONS_KEY,
    { version: 1, items: Array.isArray(items) ? items : [] },
    storage,
  );
}
export function sortNotifications(items) {
  return [...(Array.isArray(items) ? items : [])].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
export function unreadCount(items) {
  return (Array.isArray(items) ? items : []).filter((item) => !item.readAt)
    .length;
}
export function markRead(items, id, now = Date.now()) {
  const stamp = nowIso(now);
  return (Array.isArray(items) ? items : []).map((item) =>
    item.id === id && !item.readAt ? { ...item, readAt: stamp } : item,
  );
}
export function markAllRead(items, now = Date.now()) {
  const stamp = nowIso(now);
  return (Array.isArray(items) ? items : []).map((item) =>
    item.readAt ? item : { ...item, readAt: stamp },
  );
}
export function dismissNotification(items, id) {
  return (Array.isArray(items) ? items : []).filter((item) => item.id !== id);
}

// ---------------------------------------------------------------------- uploads

export const UPLOAD_RATE_BYTES_PER_SECOND = 3 * 1024 * 1024;
export const UPLOAD_ERROR_REASONS = Object.freeze([
  "The connection dropped before the file finished",
  "This file is larger than your remaining storage",
  "The file could not be read from disk",
]);
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|cr[23]|nef|arw|raf|orf|rw2|svg)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts)$/i;
export function guessMediaType(name) {
  if (IMAGE_EXT.test(name)) return "image/*";
  if (VIDEO_EXT.test(name)) return "video/*";
  return "";
}
export function isSupportedUpload(type, name = "") {
  const kind = typeof type === "string" && type ? type : guessMediaType(name);
  return kind.startsWith("image/") || kind.startsWith("video/");
}

/** Builds queued upload rows from File-like objects. Only names, sizes and types
 * are read; thumbnailUrl is an optional object URL the caller created. */
export function createUploads(files, { albumId = null, offset = 0, now } = {}) {
  if (!files || typeof files.length !== "number") return [];
  const createdAt = nowIso(now);
  const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const items = [];
  for (const file of Array.from(files)) {
    if (!record(file)) continue;
    const name = typeof file.name === "string" ? file.name.trim() : "";
    if (!name) continue;
    const seq = start + items.length + 1;
    const size =
      Number.isFinite(file.size) && file.size >= 0 ? Math.round(file.size) : 0;
    const type =
      typeof file.type === "string" && file.type ? file.type : guessMediaType(name);
    const supported = isSupportedUpload(type, name);
    const outcome = !supported
      ? "unsupported"
      : seq % 9 === 0
        ? "error"
        : seq % 6 === 0
          ? "duplicate"
          : "done";
    items.push({
      id: `upload-${seq}-${slug(name)}`,
      seq,
      name,
      size,
      type,
      progress: 0,
      status: "queued",
      error: null,
      thumbnailUrl:
        typeof file.thumbnailUrl === "string" ? file.thumbnailUrl : null,
      albumId: typeof albumId === "string" && albumId ? albumId : null,
      outcome,
      attempts: 0,
      createdAt,
    });
  }
  return items;
}

/** One timer tick of the upload state machine. Pure: returns a new list. */
export function advanceUploads(items, concurrency = 3, tick = 250) {
  if (!Array.isArray(items)) return [];
  const limit = clamp(Math.round(Number(concurrency) || 1), 1, 10);
  const ms = clamp(Number(tick) || 250, 16, 5000);
  const bytesPerTick = (UPLOAD_RATE_BYTES_PER_SECOND * ms) / 1000;
  let active = items.filter((item) => item.status === "uploading").length;
  return items.map((item) => {
    if (item.status === "queued") {
      if (active >= limit) return item;
      active += 1;
      if (item.outcome === "unsupported")
        return {
          ...item,
          status: "error",
          progress: 0,
          error: "This file type is not supported",
        };
      return { ...item, status: "uploading" };
    }
    if (item.status !== "uploading") return item;
    const step =
      item.size > 0 ? clamp((bytesPerTick / item.size) * 100, 3, 40) : 100;
    const progress = Math.min(100, item.progress + step);
    if (item.outcome === "duplicate" && progress >= 30)
      return { ...item, progress: 100, status: "duplicate" };
    if (item.outcome === "error" && progress >= 65)
      return {
        ...item,
        progress: Math.round(progress),
        status: "error",
        error: UPLOAD_ERROR_REASONS[item.seq % UPLOAD_ERROR_REASONS.length],
      };
    if (progress >= 100) return { ...item, progress: 100, status: "done" };
    return { ...item, progress: Math.round(progress * 10) / 10 };
  });
}
export function retryUploads(items) {
  return (Array.isArray(items) ? items : []).map((item) =>
    item.status === "error" && item.outcome !== "unsupported"
      ? {
          ...item,
          status: "queued",
          progress: 0,
          error: null,
          attempts: item.attempts + 1,
          outcome: "done",
        }
      : item,
  );
}
export function dismissUploadErrors(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => item.status !== "error",
  );
}
export function cancelUploads(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => item.status !== "queued" && item.status !== "uploading",
  );
}
export function clearFinishedUploads(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => item.status !== "done" && item.status !== "duplicate",
  );
}
export function uploadSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const count = (status) => list.filter((item) => item.status === status).length;
  const total = list.length;
  const done = count("done");
  const duplicates = count("duplicate");
  const errors = count("error");
  const uploading = count("uploading");
  const queued = count("queued");
  const finished = done + duplicates + errors;
  const bytes = list.reduce((sum, item) => sum + item.size, 0);
  const weighted = list.reduce(
    (sum, item) =>
      sum +
      (item.status === "queued" || item.status === "uploading"
        ? item.progress
        : 100) *
        item.size,
    0,
  );
  const percent =
    total === 0
      ? 0
      : bytes > 0
        ? Math.round(weighted / bytes)
        : Math.round((finished / total) * 100);
  const active = uploading + queued > 0;
  let label = "No uploads";
  if (total && active)
    label = `Uploading ${Math.min(total, finished + 1)} of ${total}`;
  else if (errors)
    label = `${errors} ${errors === 1 ? "upload needs" : "uploads need"} attention`;
  else if (total) label = "Upload complete";
  return {
    total,
    done,
    duplicates,
    errors,
    uploading,
    queued,
    finished,
    percent,
    active,
    label,
    bytes,
  };
}

// -------------------------------------------------------------------- downloads

export const AVERAGE_ASSET_BYTES = 4.2 * 1024 * 1024;
export const ZIP_RATE_BYTES_PER_SECOND = 24 * 1024 * 1024;
export function createDownload(name, assetIds, { now } = {}) {
  const ids = Array.isArray(assetIds)
    ? assetIds.filter((id) => typeof id === "string" && id)
    : [];
  const base =
    typeof name === "string" && name.trim() ? name.trim() : "frameleaf-download";
  const fileName = /\.zip$/i.test(base) ? base : `${base}.zip`;
  const stamp = nowIso(now);
  return {
    id: `download-${slug(base)}-${Date.parse(stamp)}`,
    name: fileName,
    assetIds: ids,
    count: ids.length,
    bytes: Math.round(ids.length * AVERAGE_ASSET_BYTES),
    progress: 0,
    status: ids.length ? "preparing" : "error",
    error: ids.length ? null : "Nothing was selected to download",
    createdAt: stamp,
  };
}
export function advanceDownloads(list, tick = 250) {
  if (!Array.isArray(list)) return [];
  const ms = clamp(Number(tick) || 250, 16, 5000);
  const bytesPerTick = (ZIP_RATE_BYTES_PER_SECOND * ms) / 1000;
  return list.map((item) => {
    if (item.status !== "preparing") return item;
    const step =
      item.bytes > 0 ? clamp((bytesPerTick / item.bytes) * 100, 2, 50) : 100;
    const progress = Math.min(100, item.progress + step);
    return progress >= 100
      ? { ...item, progress: 100, status: "ready" }
      : { ...item, progress: Math.round(progress * 10) / 10 };
  });
}
export function cancelDownload(list, id) {
  return (Array.isArray(list) ? list : []).filter((item) => item.id !== id);
}
export function downloadSummary(list) {
  const items = Array.isArray(list) ? list : [];
  const preparing = items.filter((item) => item.status === "preparing").length;
  const ready = items.filter((item) => item.status === "ready").length;
  return { total: items.length, preparing, ready, active: preparing > 0 };
}

// ------------------------------------------------------------------- onboarding

export const ONBOARDING_KEY = "frameleaf:onboarding:v1";
export const onboardingSteps = Object.freeze([
  { id: "hello", title: "Welcome", short: "Welcome" },
  { id: "language", title: "Choose your language", short: "Language" },
  { id: "theme", title: "Pick a theme", short: "Theme" },
  { id: "server-privacy", title: "Server privacy", short: "Server privacy" },
  { id: "user-privacy", title: "Your privacy", short: "Your privacy" },
  { id: "storage-template", title: "Storage template", short: "Storage" },
  { id: "frameleaf-account", title: "Frameleaf account", short: "Account", optional: true },
  { id: "plan", title: "Plan & licence", short: "Plan", optional: true },
  { id: "backup", title: "Back up your phone", short: "Backup" },
  { id: "mobile", title: "Get the mobile app", short: "Mobile app" },
  { id: "done", title: "You're all set", short: "Done" },
]);
export const languages = Object.freeze([
  { code: "en", label: "English" },
  { code: "en-GB", label: "English (UK)" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "ja", label: "日本語" },
  { code: "zh-Hans", label: "中文（简体）" },
]);
export const storageSample = Object.freeze({
  storageLabel: "taylor",
  y: "2026",
  yy: "26",
  MMMM: "September",
  MMM: "Sep",
  MM: "09",
  M: "9",
  dd: "14",
  d: "14",
  hh: "16",
  mm: "42",
  ss: "07",
  filename: "IMG_4021",
  ext: "jpg",
  filetype: "IMG",
  filetypefull: "IMAGE",
  assetId: "6f1c2a9e",
  album: "Summer in the Rockies",
  make: "Apple",
  model: "iPhone 16 Pro",
});
export const storageTemplateVariables = Object.freeze([
  { token: "{{y}}", label: "Year", sample: storageSample.y },
  { token: "{{MM}}", label: "Month", sample: storageSample.MM },
  { token: "{{MMM}}", label: "Month name", sample: storageSample.MMM },
  { token: "{{dd}}", label: "Day", sample: storageSample.dd },
  { token: "{{filename}}", label: "File name", sample: storageSample.filename },
  { token: "{{album}}", label: "Album", sample: storageSample.album },
  { token: "{{filetype}}", label: "File type", sample: storageSample.filetype },
  { token: "{{make}}", label: "Camera make", sample: storageSample.make },
  { token: "{{model}}", label: "Camera model", sample: storageSample.model },
  { token: "{{assetId}}", label: "Asset id", sample: storageSample.assetId },
]);
export const storageTemplatePresets = Object.freeze([
  { id: "date", label: "By date", pattern: "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}" },
  { id: "month", label: "By month", pattern: "{{y}}/{{MMM}}/{{filename}}" },
  { id: "album", label: "By album", pattern: "{{album}}/{{y}}/{{filename}}" },
  { id: "camera", label: "By camera", pattern: "{{make}} {{model}}/{{y}}/{{filename}}" },
]);
export const DEFAULT_STORAGE_TEMPLATE = storageTemplatePresets[0].pattern;
/** Expands a storage template against the sample asset for a live preview. */
export function renderStorageTemplate(pattern, sample = storageSample) {
  const unknown = [];
  const source = typeof pattern === "string" ? pattern.slice(0, 200) : "";
  const body = source.replace(/{{\s*([A-Za-z]+)\s*}}/g, (match, key) => {
    if (Object.hasOwn(sample, key) && key !== "storageLabel" && key !== "ext")
      return sample[key];
    unknown.push(key);
    return match;
  });
  const clean = body.replace(/\/+/g, "/").replace(/^\/|\/$/g, "").trim();
  const valid = clean.length > 0 && unknown.length === 0 && !/\.\./.test(clean);
  return {
    path: `library/${sample.storageLabel}/${clean || "…"}.${sample.ext}`,
    unknown,
    valid,
  };
}
export function createOnboarding() {
  return {
    version: 1,
    step: 0,
    completed: false,
    choices: {
      language: "en",
      theme: "system",
      server: { versionCheck: true, map: true, cast: true },
      user: { mapLocations: true, memories: true, sharedInTimeline: true },
      storageTemplate: { enabled: true, pattern: DEFAULT_STORAGE_TEMPLATE },
      cloud: { account: "skip", plan: "self-hosted" },
    },
  };
}
/** Plan choices offered during setup; paid plans are finished on frameleaf.cloud. */
export const onboardingPlanChoices = Object.freeze([
  "self-hosted",
  "cloud-monthly",
  "cloud-annual",
  "supporter-key",
]);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
export function parseOnboarding(raw) {
  const source = parseJson(raw);
  const base = createOnboarding();
  if (!record(source) || source.version !== 1) return null;
  const step = Number.isInteger(source.step)
    ? clamp(source.step, 0, onboardingSteps.length - 1)
    : 0;
  const choices = record(source.choices) ? source.choices : {};
  const server = record(choices.server) ? choices.server : {};
  const user = record(choices.user) ? choices.user : {};
  const template = record(choices.storageTemplate) ? choices.storageTemplate : {};
  const cloud = record(choices.cloud) ? choices.cloud : {};
  return {
    version: 1,
    step,
    completed: bool(source.completed, false),
    choices: {
      language: languages.some((entry) => entry.code === choices.language)
        ? choices.language
        : base.choices.language,
      theme: ["light", "dark", "system"].includes(choices.theme)
        ? choices.theme
        : base.choices.theme,
      server: {
        versionCheck: bool(server.versionCheck, true),
        map: bool(server.map, true),
        cast: bool(server.cast, true),
      },
      user: {
        mapLocations: bool(user.mapLocations, true),
        memories: bool(user.memories, true),
        sharedInTimeline: bool(user.sharedInTimeline, true),
      },
      storageTemplate: {
        enabled: bool(template.enabled, true),
        pattern:
          text(template.pattern, 200) && template.pattern.trim()
            ? template.pattern
            : DEFAULT_STORAGE_TEMPLATE,
      },
      cloud: {
        account: cloud.account === "linked" ? "linked" : "skip",
        plan: onboardingPlanChoices.includes(cloud.plan) ? cloud.plan : "self-hosted",
      },
    },
  };
}
export function loadOnboarding(storage) {
  return parseOnboarding(readStorage(ONBOARDING_KEY, storage)) ?? createOnboarding();
}
export function saveOnboarding(state, storage) {
  return writeStorage(ONBOARDING_KEY, state, storage);
}
export function onboardingStepIndex(id) {
  return Math.max(
    0,
    onboardingSteps.findIndex((step) => step.id === id),
  );
}

// -------------------------------------------------------------------- supporter

export const SUPPORTER_KEY = "frameleaf:supporter:v1";
export const supporterProducts = Object.freeze([
  {
    id: "server",
    title: "Server",
    price: 100,
    currency: "USD",
    period: "one-time",
    description: "Support Frameleaf for everyone on this server.",
    features: [
      "Covers every account on this server",
      "Supporter badge for all members",
      "Lifetime key, no renewals",
    ],
    keyPrefix: "S",
    recommended: true,
  },
  {
    id: "individual",
    title: "Individual",
    price: 25,
    currency: "USD",
    period: "one-time",
    description: "Support Frameleaf with a key for your own account.",
    features: [
      "Covers one account on any server",
      "Personal supporter badge",
      "Lifetime key, no renewals",
    ],
    keyPrefix: "I",
    recommended: false,
  },
]);
export function formatPrice(product) {
  if (!record(product) || !Number.isFinite(product.price)) return "";
  const symbol = product.currency === "USD" ? "$" : `${product.currency} `;
  return `${symbol}${product.price}`;
}
/** Uppercases, strips separators and re-hyphenates into FL-XXXX-XXXX-XXXX. */
export function normalizeProductKey(input) {
  const raw = typeof input === "string" ? input.toUpperCase() : "";
  const compact = raw.replace(/[^A-Z0-9]/g, "").slice(0, 14);
  const groups = [compact.slice(0, 2), compact.slice(2, 6), compact.slice(6, 10), compact.slice(10, 14)];
  return groups.filter(Boolean).join("-");
}
export function validateProductKey(input) {
  const key = normalizeProductKey(input);
  if (!key) return { valid: false, key, kind: null, message: "Enter your product key" };
  if (!/^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key))
    return {
      valid: false,
      key,
      kind: null,
      message: "Keys look like FL-XXXX-XXXX-XXXX",
    };
  const product = supporterProducts.find(
    (entry) => key.charAt(3) === entry.keyPrefix,
  );
  if (!product)
    return {
      valid: false,
      key,
      kind: null,
      message: "This key does not belong to a Frameleaf product",
    };
  return { valid: true, key, kind: product.id, message: "" };
}
export function createSupporter() {
  return {
    version: 1,
    activated: false,
    kind: null,
    keyHint: null,
    activatedAt: null,
    hideBadge: false,
  };
}
export function parseSupporter(raw) {
  const source = parseJson(raw);
  if (!record(source) || source.version !== 1) return null;
  const activated = source.activated === true;
  const kind = supporterProducts.some((product) => product.id === source.kind)
    ? source.kind
    : null;
  if (activated && (!kind || !isoDate(source.activatedAt))) return null;
  return {
    version: 1,
    activated,
    kind: activated ? kind : null,
    keyHint: activated && text(source.keyHint, 8) ? source.keyHint : null,
    activatedAt: activated ? source.activatedAt : null,
    hideBadge: source.hideBadge === true,
  };
}
export function loadSupporter(storage) {
  return parseSupporter(readStorage(SUPPORTER_KEY, storage)) ?? createSupporter();
}
export function saveSupporter(state, storage) {
  return writeStorage(SUPPORTER_KEY, state, storage);
}
export function activateSupporter(state, input, now = Date.now()) {
  const result = validateProductKey(input);
  if (!result.valid) throw new Error(result.message);
  return {
    ...(record(state) ? state : createSupporter()),
    version: 1,
    activated: true,
    kind: result.kind,
    keyHint: result.key.slice(-4),
    activatedAt: nowIso(now),
  };
}
export function removeSupporter(state) {
  return { ...createSupporter(), hideBadge: state?.hideBadge === true };
}
export function setSupporterBadgeHidden(state, hidden) {
  return { ...(record(state) ? state : createSupporter()), hideBadge: hidden === true };
}

// ------------------------------------------------------------------ maintenance

const MAINTENANCE_TASKS = Object.freeze([
  {
    id: "backup",
    title: "Database backup",
    detail: "Saving a restore point before anything changes",
    durationMs: 6000,
  },
  {
    id: "migrations",
    title: "Database migrations",
    detail: "Applying 3 schema updates",
    durationMs: 9000,
  },
  {
    id: "restore-check",
    title: "Restore check",
    detail: "Confirming the backup can be restored",
    durationMs: 5000,
  },
]);
export function createMaintenance() {
  return [
    ...MAINTENANCE_TASKS.map((task, index) => ({
      ...task,
      progress: 0,
      status: index === 0 ? "running" : "queued",
    })),
    {
      id: "rollback",
      title: "Rollback",
      detail: "Ready if any step fails",
      durationMs: 4000,
      progress: 0,
      status: "standby",
    },
  ];
}
export function advanceMaintenance(tasks, tick = 500) {
  if (!Array.isArray(tasks)) return [];
  const ms = clamp(Number(tick) || 500, 16, 5000);
  const next = tasks.map((task) => ({ ...task }));
  const running = next.find((task) => task.status === "running");
  if (running) {
    running.progress = Math.min(
      100,
      running.progress + clamp((ms / running.durationMs) * 100, 1, 100),
    );
    if (running.progress >= 100) running.status = "done";
  }
  if (!next.some((task) => task.status === "running")) {
    const queued = next.find((task) => task.status === "queued");
    if (queued) queued.status = "running";
    else {
      const standby = next.find((task) => task.status === "standby");
      if (standby) standby.status = "skipped";
    }
  }
  return next;
}
export function maintenanceSummary(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counted = list.filter((task) => task.status !== "standby" && task.status !== "skipped");
  const percent = counted.length
    ? Math.round(
        counted.reduce((sum, task) => sum + task.progress, 0) / counted.length,
      )
    : 0;
  const complete =
    counted.length > 0 && counted.every((task) => task.status === "done");
  const current = list.find((task) => task.status === "running");
  return { percent, complete, currentTitle: current?.title ?? null };
}

// ---------------------------------------------------------------- credentials

export const passwordRequirements = Object.freeze([
  { id: "length", label: "At least 8 characters", test: (pw) => pw.length >= 8 },
  { id: "lower", label: "A lowercase letter", test: (pw) => /[a-z]/.test(pw) },
  { id: "upper", label: "An uppercase letter", test: (pw) => /[A-Z]/.test(pw) },
  { id: "number", label: "A number", test: (pw) => /\d/.test(pw) },
  { id: "symbol", label: "A symbol", test: (pw) => /[^A-Za-z0-9\s]/.test(pw) },
]);
export function passwordChecks(password) {
  const value = typeof password === "string" ? password : "";
  return Object.fromEntries(
    passwordRequirements.map((rule) => [rule.id, rule.test(value)]),
  );
}
const STRENGTH_LABELS = ["Enter a password", "Weak", "Fair", "Good", "Strong"];
export function passwordStrength(password) {
  const value = typeof password === "string" ? password : "";
  const checks = passwordChecks(value);
  const passed = Object.values(checks).filter(Boolean).length;
  let score = 0;
  if (value.length > 0) {
    score = checks.length ? clamp(passed - 1, 1, 4) : 1;
    if (checks.length && value.length >= 14) score = clamp(score + 1, 1, 4);
  }
  return {
    score,
    label: STRENGTH_LABELS[score],
    passed,
    total: passwordRequirements.length,
    checks,
    acceptable: checks.length && passed >= 3,
  };
}
export const validPin = (value) => typeof value === "string" && /^\d{6}$/.test(value);

// ------------------------------------------------------------------------ about

export const aboutInfo = Object.freeze({
  product: "Frameleaf",
  version: "Development",
  channel: "development",
  basedOn: "2026.9",
  build: "4d62e8082c5e",
  buildDate: "2026-09-19",
  server: {
    name: "frameleaf.local",
    url: "https://frameleaf.local",
    runtime: "Node 22.12",
    platform: "Linux x86_64",
    database: "PostgreSQL 16",
  },
  licence: "AGPL-3.0",
  upstream: {
    name: "Immich",
    version: "v2.4.0",
    url: "https://github.com/immich-app/immich",
    licence: "AGPL-3.0",
  },
  links: {
    documentation: "https://docs.frameleaf.example/",
    community: "https://chat.frameleaf.example/",
    issues: "https://issues.frameleaf.example/new/problem",
    features: "https://issues.frameleaf.example/new/feature",
    source: "https://source.frameleaf.example/frameleaf",
    appStore: "https://get.frameleaf.example/ios",
    googlePlay: "https://get.frameleaf.example/android",
    obtainium: "https://get.frameleaf.example/obtainium",
  },
  thirdParty: [
    { name: "Immich", licence: "AGPL-3.0", role: "Photo library server and clients" },
    { name: "React", licence: "MIT", role: "Interface runtime" },
    { name: "Vite", licence: "MIT", role: "Build tooling" },
    { name: "Material Design Icons", licence: "Apache-2.0", role: "Icons" },
    { name: "Inter", licence: "SIL OFL 1.1", role: "Interface typeface" },
    { name: "Chart.js", licence: "MIT", role: "Analytics charts" },
  ],
});
export const versionHistory = Object.freeze([
  {
    version: "2026.9",
    date: "2026-09-02",
    notes: [
      "Faster timeline scrolling on large libraries",
      "Improved face grouping and merge suggestions",
      "Locked content rules with a session-only unlock",
    ],
  },
  {
    version: "2026.8",
    date: "2026-08-05",
    notes: [
      "Studio hand-off from quick edits",
      "Workflow designer with run history",
      "Storage template preview in onboarding",
    ],
  },
  {
    version: "2026.7",
    date: "2026-07-08",
    notes: [
      "Notifications for album invitations and finished jobs",
      "Drag and drop uploads with duplicate detection",
    ],
  },
]);
/** Simulated update check against this product's own release feed. */
export function checkForUpdates(info = aboutInfo, now = Date.now()) {
  const latest = versionHistory[0];
  const current =
    info?.channel === "development" ||
    info?.version === latest.version ||
    info?.basedOn === latest.version;
  return {
    checkedAt: nowIso(now),
    status: current ? "current" : "available",
    latest: { version: latest.version, date: latest.date },
    message: current
      ? "You're running the latest version."
      : `Frameleaf ${latest.version} is available.`,
  };
}
