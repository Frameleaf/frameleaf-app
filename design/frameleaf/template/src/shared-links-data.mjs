// Shared links: pure state helpers and defensive persistence.
// A link exposes an album or a hand-picked set of items at
// `?screen=public&link=<id or slug>`. Passwords are never persisted; only a
// `hasPassword` flag is stored and the sample password lives in memory.

export const SHARED_LINKS_KEY = "frameleaf:shared-links:v1";
export const SHARED_LINK_TYPES = Object.freeze(["album", "individual"]);
export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 48;
export const MAX_LINKS = 200;
export const MAX_UPLOADS = 200;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const EXPIRY_PRESETS = Object.freeze([
  { id: "30m", label: "30 minutes", ms: 30 * MINUTE },
  { id: "1h", label: "1 hour", ms: HOUR },
  { id: "6h", label: "6 hours", ms: 6 * HOUR },
  { id: "1d", label: "1 day", ms: DAY },
  { id: "7d", label: "7 days", ms: 7 * DAY },
  { id: "30d", label: "30 days", ms: 30 * DAY },
  { id: "3mo", label: "3 months", ms: 90 * DAY },
  { id: "1y", label: "1 year", ms: 365 * DAY },
  { id: "never", label: "Never", ms: null },
]);

const SEED_PASSWORDS = Object.freeze({ "sl-grandma": "lakeside" });

const clean = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u001f\u007f]/.test(value);
const idLike = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isoTime = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const millis = (value) =>
  value instanceof Date ? value.getTime() : Number(value) || Date.now();
const iso = (value) => new Date(millis(value)).toISOString();
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

let counter = 0;
export function newLinkId() {
  counter += 1;
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `sl-${random}${counter.toString(36)}`;
}

export function normalizeSlug(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug);
}

/** Live availability for the custom address field. */
export function slugAvailability(slug, links = [], excludeId = null) {
  const value = String(slug ?? "").trim();
  if (!value) return { status: "empty", message: "Optional. Leave blank for a generated address." };
  if (!isValidSlug(value))
    return {
      status: "invalid",
      message: `Use ${SLUG_MIN}–${SLUG_MAX} lowercase letters, numbers or dashes.`,
    };
  const taken = links.some(
    (link) => link.id !== excludeId && (link.slug === value || link.id === value),
  );
  return taken
    ? { status: "taken", message: "Already used by another link." }
    : { status: "available", message: "Available." };
}

export function expiryFromPreset(presetId, now = Date.now()) {
  const preset = EXPIRY_PRESETS.find((entry) => entry.id === presetId);
  if (!preset || preset.ms === null) return null;
  return iso(millis(now) + preset.ms);
}

export function isExpired(link, now = Date.now()) {
  if (!link?.expiresAt) return false;
  const at = Date.parse(link.expiresAt);
  return Number.isFinite(at) && at <= millis(now);
}

/** Human duration such as "3 days" or "45 minutes" for a millisecond span. */
export function relativeDuration(ms) {
  const span = Math.max(0, Math.abs(ms));
  const unit = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (span < HOUR) return unit(Math.max(1, Math.round(span / MINUTE)), "minute");
  if (span < DAY) return unit(Math.round(span / HOUR), "hour");
  if (span < 60 * DAY) return unit(Math.round(span / DAY), "day");
  if (span < 365 * DAY) return unit(Math.round(span / (30 * DAY)), "month");
  return unit(Math.round(span / (365 * DAY)), "year");
}

export function expiryLabel(link, now = Date.now()) {
  if (!link?.expiresAt) return "Never expires";
  const delta = Date.parse(link.expiresAt) - millis(now);
  return delta <= 0
    ? `Expired ${relativeDuration(delta)} ago`
    : `Expires in ${relativeDuration(delta)}`;
}

export function linkUrl(link) {
  return `?screen=public&link=${encodeURIComponent(link?.slug || link?.id || "")}`;
}

export function absoluteLinkUrl(link, base) {
  const origin =
    base ??
    (typeof location === "object" && location
      ? `${location.origin}${location.pathname}`
      : "https://frameleaf.local/");
  return `${origin}${linkUrl(link)}`;
}

export function checkPassword(link, entered) {
  if (!link?.hasPassword) return true;
  return typeof link.password === "string" && link.password === String(entered ?? "");
}

/** Public visibility: locked, hidden or sensitive items never leave the library. */
export function isShareable(asset) {
  return (
    !!asset &&
    !asset.isLocked &&
    !asset.isSensitive &&
    !asset.isSuppressed &&
    asset.visibility !== "locked"
  );
}

function uploadPlaceholder(upload) {
  return {
    id: upload.id,
    name: upload.name,
    type: upload.kind,
    placeholder: true,
    addedAt: upload.addedAt,
    date: upload.addedAt.slice(0, 10),
    fileSizeInBytes: upload.size,
  };
}

/** Assets a viewer of the link sees, including uploaded placeholders. */
export function linkAssets(link, assets = []) {
  if (!link) return [];
  const own =
    link.type === "album"
      ? assets.filter(
          (asset) => isShareable(asset) && (asset.albumIds || []).includes(link.albumId),
        )
      : link.assetIds
          .map((id) => assets.find((asset) => asset.id === id))
          .filter(isShareable);
  return [...own, ...(link.uploads || []).map(uploadPlaceholder)];
}

export function collectionName(collections, id) {
  if (!id) return "";
  if (Array.isArray(collections))
    return collections.find((entry) => entry?.id === id)?.name || id;
  if (record(collections)) return collections[id] || id;
  return id;
}

export function linkTitle(link, { collections, assets } = {}) {
  if (!link) return "";
  if (link.type === "album") return collectionName(collections, link.albumId);
  const count = link.assetIds.length;
  if (count === 1) {
    const asset = assets?.find((entry) => entry.id === link.assetIds[0]);
    if (asset?.name) return asset.name;
  }
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** Badges shown on a card and in the form preview, in display order. */
export function linkBadges(link, now = Date.now()) {
  const badges = [];
  if (isExpired(link, now)) badges.push({ id: "expired", label: "Expired", tone: "danger" });
  if (link.hasPassword) badges.push({ id: "password", label: "Password", icon: "mdiLockOutline" });
  if (link.allowDownload) badges.push({ id: "download", label: "Downloads", icon: "mdiDownloadOutline" });
  if (link.allowUpload) badges.push({ id: "upload", label: "Uploads", icon: "mdiUpload" });
  if (link.showMetadata) badges.push({ id: "metadata", label: "Metadata", icon: "mdiInformationOutline" });
  if (link.expiresAt && !isExpired(link, now))
    badges.push({ id: "expiry", label: expiryLabel(link, now), icon: "mdiClockOutline", tone: "info" });
  badges.push({
    id: "views",
    label: `${link.views} ${link.views === 1 ? "view" : "views"}`,
    icon: "mdiEyeOutline",
  });
  return badges;
}

export function validateLinkInput(input, links = [], excludeId = null) {
  const errors = [];
  if (!record(input)) return [{ field: "input", message: "Link details are required." }];
  if (!SHARED_LINK_TYPES.includes(input.type))
    errors.push({ field: "type", message: "Choose an album or individual items." });
  if (input.type === "album" && !idLike(input.albumId))
    errors.push({ field: "albumId", message: "Choose an album to share." });
  if (
    input.type === "individual" &&
    (!Array.isArray(input.assetIds) ||
      !input.assetIds.length ||
      input.assetIds.length > 500 ||
      !input.assetIds.every(idLike))
  )
    errors.push({ field: "assetIds", message: "Choose at least one item to share." });
  if (input.description !== undefined && !clean(input.description ?? "", 500))
    errors.push({ field: "description", message: "Keep the description under 500 characters." });
  if (input.slug) {
    const availability = slugAvailability(input.slug, links, excludeId);
    if (availability.status !== "available")
      errors.push({ field: "slug", message: availability.message });
  }
  if (input.password !== undefined && input.password !== null && !clean(input.password, 120))
    errors.push({ field: "password", message: "Keep the password under 120 characters." });
  if (input.expiresAt !== undefined && input.expiresAt !== null && !isoTime(input.expiresAt))
    errors.push({ field: "expiresAt", message: "Choose a valid expiry date and time." });
  return errors;
}

function buildLink(input, now, id) {
  const password =
    typeof input.password === "string" && input.password.length ? input.password : null;
  return {
    id,
    type: input.type,
    albumId: input.type === "album" ? input.albumId : null,
    assetIds: input.type === "individual" ? [...new Set(input.assetIds)] : [],
    description: (input.description ?? "").trim(),
    slug: input.slug ? String(input.slug).trim() : null,
    hasPassword: password !== null,
    password,
    allowDownload: input.allowDownload !== false,
    allowUpload: !!input.allowUpload,
    showMetadata: !!input.showMetadata,
    expiresAt: input.expiresAt ? iso(Date.parse(input.expiresAt)) : null,
    createdAt: iso(now),
    updatedAt: iso(now),
    lastViewedAt: null,
    views: 0,
    uploadedAssetIds: [],
    uploads: [],
  };
}

export function createLink(state, input, now = Date.now(), id = newLinkId()) {
  const errors = validateLinkInput(input, state.links);
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" "));
  if (state.links.length >= MAX_LINKS) throw new Error("Link limit reached.");
  if (state.links.some((link) => link.id === id)) throw new Error("Duplicate link id.");
  const link = buildLink(input, now, id);
  return { state: { ...state, links: [link, ...state.links] }, link };
}

export function updateLink(state, id, patch, now = Date.now()) {
  const current = state.links.find((link) => link.id === id);
  if (!current) throw new Error("Link not found.");
  const merged = {
    type: current.type,
    albumId: current.albumId,
    assetIds: current.assetIds,
    description: patch.description ?? current.description,
    slug: patch.slug === undefined ? current.slug : patch.slug || null,
    allowDownload: patch.allowDownload ?? current.allowDownload,
    allowUpload: patch.allowUpload ?? current.allowUpload,
    showMetadata: patch.showMetadata ?? current.showMetadata,
    expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
  };
  if (patch.assetIds !== undefined && current.type === "individual")
    merged.assetIds = patch.assetIds;
  const errors = validateLinkInput(
    { ...merged, password: patch.password },
    state.links,
    id,
  );
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" "));
  let { hasPassword, password } = current;
  if (patch.password === null || patch.password === "") {
    hasPassword = false;
    password = null;
  } else if (typeof patch.password === "string") {
    hasPassword = true;
    password = patch.password;
  }
  const link = {
    ...current,
    ...merged,
    assetIds: [...new Set(merged.assetIds)],
    description: merged.description.trim(),
    expiresAt: merged.expiresAt ? iso(Date.parse(merged.expiresAt)) : null,
    hasPassword,
    password,
    updatedAt: iso(now),
  };
  return {
    state: { ...state, links: state.links.map((entry) => (entry.id === id ? link : entry)) },
    link,
  };
}

export function deleteLink(state, id) {
  return { ...state, links: state.links.filter((link) => link.id !== id) };
}

/** Find a link by id or slug (slugs compare case-insensitively). */
export function resolveLink(state, keyOrSlug) {
  const key = String(keyOrSlug ?? "").trim();
  if (!key) return null;
  const links = Array.isArray(state) ? state : state?.links || [];
  return (
    links.find((link) => link.id === key) ||
    links.find((link) => link.slug && link.slug === key.toLowerCase()) ||
    null
  );
}

export function recordView(state, id, now = Date.now()) {
  return {
    ...state,
    links: state.links.map((link) =>
      link.id === id
        ? { ...link, views: Math.min(1e9, link.views + 1), lastViewedAt: iso(now) }
        : link,
    ),
  };
}

const uploadKind = (file) =>
  /^video\//.test(file?.type || "") || /\.(mov|mp4|m4v|webm)$/i.test(file?.name || "")
    ? "video"
    : "photo";

/** Append viewer uploads (File-like {name, type, size}) as placeholders. */
export function addUploads(state, id, files, now = Date.now()) {
  const current = state.links.find((link) => link.id === id);
  if (!current) throw new Error("Link not found.");
  if (!current.allowUpload) throw new Error("Uploads are not allowed for this link.");
  const stamp = iso(now);
  const uploads = [];
  for (const file of Array.from(files || [])) {
    if (current.uploads.length + uploads.length >= MAX_UPLOADS) break;
    const name = clean(file?.name, 160) && file.name.trim() ? file.name.trim() : "Upload";
    uploads.push({
      id: `up-${id}-${current.uploads.length + uploads.length + 1}`,
      name,
      kind: uploadKind(file),
      size: Number.isFinite(file?.size) && file.size >= 0 ? Math.floor(file.size) : 0,
      addedAt: stamp,
    });
  }
  const link = {
    ...current,
    uploads: [...current.uploads, ...uploads],
    uploadedAssetIds: [...current.uploadedAssetIds, ...uploads.map((upload) => upload.id)],
    updatedAt: stamp,
  };
  return {
    state: { ...state, links: state.links.map((entry) => (entry.id === id ? link : entry)) },
    uploads,
  };
}

export function seedSharedLinks(now = Date.now()) {
  const at = millis(now);
  const make = (input, id, createdMs, extra) => ({
    ...buildLink(input, createdMs, id),
    ...extra,
  });
  return {
    version: 1,
    links: [
      make(
        {
          type: "album",
          albumId: "summer-rockies",
          description: "Our week in the Rockies",
          slug: "rockies-2026",
          allowDownload: true,
          allowUpload: true,
          showMetadata: true,
          expiresAt: iso(at + 18 * DAY),
        },
        "sl-rockies",
        at - 12 * DAY,
        { views: 24, lastViewedAt: iso(at - 3 * HOUR) },
      ),
      make(
        {
          type: "individual",
          assetIds: ["2", "5", "9", "13"],
          description: "Lake photos for Grandma",
          slug: null,
          password: SEED_PASSWORDS["sl-grandma"],
          allowDownload: true,
          allowUpload: false,
          showMetadata: false,
          expiresAt: null,
        },
        "sl-grandma",
        at - 5 * DAY,
        { views: 6, lastViewedAt: iso(at - DAY) },
      ),
      make(
        {
          type: "album",
          albumId: "family",
          description: "Family album for the reunion",
          slug: "family-reunion",
          allowDownload: false,
          allowUpload: false,
          showMetadata: false,
          expiresAt: iso(at - 2 * DAY),
        },
        "sl-family",
        at - 40 * DAY,
        { views: 41, lastViewedAt: iso(at - 3 * DAY) },
      ),
    ],
  };
}

function parseUpload(value, linkId, index) {
  if (!record(value)) return null;
  const name = clean(value.name, 160) && value.name.trim() ? value.name.trim() : null;
  if (!name || !isoTime(value.addedAt)) return null;
  return {
    id: idLike(value.id) ? value.id : `up-${linkId}-${index + 1}`,
    name,
    kind: value.kind === "video" ? "video" : "photo",
    size: Number.isFinite(value.size) && value.size >= 0 ? Math.floor(value.size) : 0,
    addedAt: iso(Date.parse(value.addedAt)),
  };
}

function parseLink(value, { albumIds, assetIds }) {
  if (!record(value) || !idLike(value.id)) return null;
  if (!SHARED_LINK_TYPES.includes(value.type)) return null;
  if (!isoTime(value.createdAt)) return null;
  const link = {
    id: value.id,
    type: value.type,
    albumId: null,
    assetIds: [],
    description: clean(value.description, 500) ? value.description.trim() : "",
    slug: isValidSlug(value.slug) ? value.slug : null,
    hasPassword: value.hasPassword === true,
    password: null,
    allowDownload: value.allowDownload !== false,
    allowUpload: value.allowUpload === true,
    showMetadata: value.showMetadata === true,
    expiresAt: isoTime(value.expiresAt) ? iso(Date.parse(value.expiresAt)) : null,
    createdAt: iso(Date.parse(value.createdAt)),
    updatedAt: isoTime(value.updatedAt) ? iso(Date.parse(value.updatedAt)) : iso(Date.parse(value.createdAt)),
    lastViewedAt: isoTime(value.lastViewedAt) ? iso(Date.parse(value.lastViewedAt)) : null,
    views:
      Number.isInteger(value.views) && value.views >= 0 && value.views <= 1e9 ? value.views : 0,
    uploads: [],
    uploadedAssetIds: [],
  };
  if (link.type === "album") {
    if (!idLike(value.albumId)) return null;
    if (Array.isArray(albumIds) && !albumIds.includes(value.albumId)) return null;
    link.albumId = value.albumId;
  } else {
    if (!Array.isArray(value.assetIds)) return null;
    const ids = [...new Set(value.assetIds.filter(idLike))]
      .filter((id) => !Array.isArray(assetIds) || assetIds.includes(id))
      .slice(0, 500);
    if (!ids.length) return null;
    link.assetIds = ids;
  }
  if (Array.isArray(value.uploads)) {
    const seen = new Set();
    value.uploads.slice(0, MAX_UPLOADS).forEach((entry, index) => {
      const upload = parseUpload(entry, link.id, index);
      if (upload && !seen.has(upload.id)) {
        seen.add(upload.id);
        link.uploads.push(upload);
      }
    });
    link.uploadedAssetIds = link.uploads.map((upload) => upload.id);
  }
  if (link.hasPassword && SEED_PASSWORDS[link.id]) link.password = SEED_PASSWORDS[link.id];
  return link;
}

/** Parse persisted state; anything malformed falls back to the seeded links. */
export function parseSharedLinks(raw, options = {}) {
  const fallback = () => seedSharedLinks(options.now);
  if (raw === null || raw === undefined) return fallback();
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return fallback();
  }
  if (!record(data) || data.version !== 1 || !Array.isArray(data.links)) return fallback();
  const ids = new Set();
  const slugs = new Set();
  const links = [];
  for (const entry of data.links.slice(0, MAX_LINKS)) {
    const link = parseLink(entry, options);
    if (!link || ids.has(link.id) || slugs.has(link.id)) continue;
    if (link.slug && (slugs.has(link.slug) || ids.has(link.slug))) link.slug = null;
    ids.add(link.id);
    if (link.slug) slugs.add(link.slug);
    links.push(link);
  }
  return { version: 1, links };
}

/** Serializable form: passwords stay in memory only. */
export function serializeSharedLinks(state) {
  return JSON.stringify({
    version: 1,
    links: state.links.map(({ password, ...link }) => link),
  });
}

export function loadSharedLinks(storage = globalThis.localStorage, options = {}) {
  try {
    const raw = storage?.getItem(SHARED_LINKS_KEY);
    if (typeof raw === "string" && raw.length > 400_000) return seedSharedLinks(options.now);
    return parseSharedLinks(raw ?? null, options);
  } catch {
    return seedSharedLinks(options.now);
  }
}

export function saveSharedLinks(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SHARED_LINKS_KEY, serializeSharedLinks(state));
    return true;
  } catch {
    return false;
  }
}

/** Datetime-local input value (local time, minute precision) for an ISO stamp. */
export function toLocalInputValue(isoStamp) {
  if (!isoTime(isoStamp)) return "";
  const date = new Date(isoStamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInputValue(value) {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
