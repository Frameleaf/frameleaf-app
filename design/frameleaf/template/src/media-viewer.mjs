// Source references: AssetViewerNavBar.svelte, asset.service.ts, slideshow.store.ts,
// detail-panel.svelte and change-date / change-location dialogs.
// Callers supply their accessible collection; this layer also fails closed on explicit privacy flags.
import { classifyLocked } from "./locked-content.mjs";

export const VIEWER_PREFERENCES_KEY = "frameleaf:viewer:v1";
export const VIEWER_ACTIONS = Object.freeze([
  "download",
  "download-original",
  "add-to-album",
  "remove-from-album",
  "archive",
  "unarchive",
  "lock",
  "unlock",
  "add-to-stack",
  "unstack",
  "stack-keep-this",
  "stack-set-primary",
  "set-album-cover",
  "set-person-featured",
  "set-profile-picture",
  "restore",
  "delete-permanently",
  "refresh-faces",
  "refresh-metadata",
  "refresh-thumbnails",
  "refresh-encoded",
  "cast",
  "copy-image",
  "view-in-timeline",
  "find-similar",
  "view-on-map",
  "open-folder",
  "open-album",
  "search-camera",
  "open-person",
  "transcode",
  "accept-description",
  "rerun-description",
  "rerun-sensitive",
]);
const LEGACY_ACTION_ALIASES = { stack: "add-to-stack" };

export const viewerCanShare = (asset) =>
  !!asset && asset.canShare !== false && !classifyLocked(asset);

/** allowTrashed opts a trash-screen viewer into trashed rows; deleted rows never show. */
export function viewerAssets(
  assets,
  { allowLocked = false, allowTrashed = false } = {},
) {
  const rows = Array.isArray(assets) ? assets : [];
  const counts = new Map();
  for (const asset of rows)
    if (asset?.id != null)
      counts.set(String(asset.id), (counts.get(String(asset.id)) || 0) + 1);
  return rows.filter(
    (asset) =>
      asset &&
      typeof asset.id === "string" &&
      asset.id &&
      counts.get(asset.id) === 1 &&
      asset.canView !== false &&
      asset.accessible !== false &&
      !asset.hidden &&
      (allowLocked || (!asset.locked && !asset.isLocked)) &&
      (allowTrashed || (!asset.isTrashed && !asset.trashed)) &&
      ![
        ...(allowLocked ? [] : ["locked"]),
        ...(allowTrashed ? [] : ["trash", "trashed"]),
        "hidden",
      ].includes(String(asset.visibility || "").toLowerCase()) &&
      !["Deleted", ...(allowTrashed ? [] : ["Trashed"])].includes(asset.status),
  );
}
export function safeMediaSource(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f]/.test(value)
  )
    return null;
  const source = value.trim();
  if (source.startsWith("/") && !source.startsWith("//")) return source;
  if (/^blob:https?:\/\//i.test(source)) return source;
  if (/^data:image\/(png|jpeg|webp|avif|gif);base64,/i.test(source))
    return source;
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? source
      : null;
  } catch {
    return null;
  }
}
const playableSource = (candidate) =>
  candidate &&
  !/^data:image\//i.test(candidate) &&
  !/\.(png|jpe?g|webp|avif|gif|svg)(?:[?#]|$)/i.test(candidate)
    ? candidate
    : null;
export function viewerMedia(asset) {
  if (!asset) return { isVideo: false, image: null, video: null };
  const isVideo =
    String(asset.type || asset.mediaType || "").toLowerCase() === "video";
  const image =
    [asset.fullSrc, asset.src, asset.image, asset.thumbnailUrl]
      .map(safeMediaSource)
      .find(Boolean) || null;
  const video = isVideo
    ? playableSource(safeMediaSource(asset.mediaSrc || asset.videoSrc))
    : null;
  return { isVideo, image, video };
}
/** Original and encoded playback sources; the encoded rendition falls back to the original. */
export function videoSources(asset) {
  const original = viewerMedia(asset).video;
  const encoded =
    playableSource(safeMediaSource(asset?.encodedVideoSrc)) || original;
  return { original, encoded, hasEncoded: !!original && encoded !== original };
}
export function livePhotoSource(asset) {
  return asset?.isLivePhoto
    ? playableSource(safeMediaSource(asset.livePhotoVideo))
    : null;
}
export const SLIDESHOW_ORDERS = Object.freeze([
  "ascending",
  "descending",
  "shuffle",
]);
export function slideshowOrder(
  ids,
  currentId,
  mode = "ascending",
  random = Math.random,
) {
  const unique = [...new Set(ids)];
  const order = mode === true ? "shuffle" : mode === false ? "ascending" : mode;
  if (order === "descending") return unique.reverse();
  if (order !== "shuffle") return unique;
  const others = unique.filter((id) => id !== currentId);
  for (let i = others.length - 1; i > 0; i--) {
    const value = random();
    const j = Math.max(
      0,
      Math.min(i, Math.floor((Number.isFinite(value) ? value : 0) * (i + 1))),
    );
    [others[i], others[j]] = [others[j], others[i]];
  }
  return unique.includes(currentId) ? [currentId, ...others] : others;
}
export function slideshowNeighbor(
  order,
  currentId,
  direction = 1,
  repeat = false,
) {
  const index = order.indexOf(currentId);
  if (index < 0 || order.length < 2) return null;
  const next = index + (direction < 0 ? -1 : 1);
  if (next >= 0 && next < order.length) return order[next];
  return repeat ? order[(next + order.length) % order.length] : null;
}
export function fitDimensions(width, height, viewportWidth, viewportHeight) {
  if (
    ![width, height, viewportWidth, viewportHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const scale = Math.min(1, viewportWidth / width, viewportHeight / height);
  return { width: width * scale, height: height * scale, scale };
}
export function clampPan(pan, dimensions, viewport, zoom) {
  if (!dimensions || zoom <= 1) return { x: 0, y: 0 };
  const x = Math.max(0, (dimensions.width * zoom - viewport.width) / 2);
  const y = Math.max(0, (dimensions.height * zoom - viewport.height) / 2);
  return {
    x: Math.max(-x, Math.min(x, pan.x || 0)),
    y: Math.max(-y, Math.min(y, pan.y || 0)),
  };
}
/** Panorama look-around: the strip is as tall as the stage and scrolls sideways. */
export function panoramaLayout(natural, viewport) {
  if (
    ![natural?.width, natural?.height, viewport?.width, viewport?.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const width = (natural.width / natural.height) * viewport.height;
  return {
    width,
    height: viewport.height,
    maxOffset: Math.max(0, width - viewport.width),
  };
}
export const clampPanorama = (offset, layout) =>
  !layout ? 0 : Math.max(0, Math.min(layout.maxOffset, Number(offset) || 0));
export function panoramaWindow(offset, layout, viewport) {
  if (!layout || !viewport?.width) return { left: 0, width: 1 };
  const width = Math.min(1, viewport.width / layout.width);
  return {
    left: Math.max(
      0,
      Math.min(1 - width, clampPanorama(offset, layout) / layout.width),
    ),
    width,
  };
}
export const formatFileSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.round(bytes)} B`;
};
export function megapixels(width, height) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    return null;
  const value = (width * height) / 1e6;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MP`;
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds),
    hours = Math.floor(whole / 3600),
    minutes = Math.floor((whole % 3600) / 60),
    rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}
export const dimensionsLabel = (asset) =>
  Number.isFinite(asset?.width) && Number.isFinite(asset?.height)
    ? `${asset.width.toLocaleString()} × ${asset.height.toLocaleString()}`
    : null;
export const cameraLabel = (asset) =>
  [asset?.make, asset?.model].filter(Boolean).join(" ") || null;
const exposureSeconds = (value) =>
  typeof value === "number"
    ? value >= 1
      ? `${value} s`
      : `1/${Math.round(1 / value)} s`
    : typeof value === "string" && value
      ? /s$/.test(value)
        ? value
        : `${value} s`
      : null;
export function exposureParts(asset) {
  if (!asset) return [];
  return [
    asset.fNumber ? `ƒ/${asset.fNumber}` : null,
    exposureSeconds(asset.exposureTime),
    asset.iso ? `ISO ${asset.iso}` : null,
    asset.focalLength ? `${asset.focalLength} mm` : null,
  ].filter(Boolean);
}
/** The short technical line under the file name, in the production viewer's order. */
export function viewerHeadline(asset) {
  if (!asset) return [];
  const video = viewerMedia(asset).isVideo;
  return [
    cameraLabel(asset),
    asset.lensModel || null,
    ...(video ? [] : exposureParts(asset)),
    dimensionsLabel(asset),
    video && asset.frameRate ? `${asset.frameRate} fps` : null,
    video ? formatDuration(asset.duration) : null,
    formatFileSize(asset.fileSizeInBytes),
  ].filter(Boolean);
}
export const folderOf = (path) =>
  typeof path === "string" && path.includes("/")
    ? path.slice(0, path.lastIndexOf("/")) || "/"
    : null;
export function viewerMetadata(asset) {
  const items = [
    ["Captured", asset.takenAt || asset.date || asset.localDateTime],
    ["Camera", [asset.make, asset.model].filter(Boolean).join(" · ")],
    ["Lens", asset.lensModel],
    ["Dimensions", dimensionsLabel(asset)],
    [
      "Location",
      [asset.city, asset.state, asset.country].filter(Boolean).join(", "),
    ],
    [
      "Exposure",
      [
        asset.fNumber ? `ƒ/${asset.fNumber}` : null,
        asset.exposureTime,
        asset.iso ? `ISO ${asset.iso}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ["File", asset.originalFileName || asset.name],
    ["Folder", folderOf(asset.originalPath)],
  ];
  return items
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    )
    .map(([label, value]) => ({ label, value: String(value) }));
}
export const locationLabel = (asset) =>
  [asset?.city, asset?.state, asset?.country].filter(Boolean).join(", ") ||
  null;
export function validCoordinate(value, limit) {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" &&
    Number.isFinite(number) &&
    Math.abs(number) <= limit &&
    !(typeof value === "string" && !value.trim())
    ? number
    : null;
}
export function osmLink(latitude, longitude) {
  const lat = validCoordinate(latitude, 90),
    lon = validCoordinate(longitude, 180);
  if (lat === null || lon === null) return null;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
}
/* ---------- Date and time ---------- */
export function splitDateTime(value) {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?/.exec(
      String(value || ""),
    );
  return match
    ? { date: match[1], time: match[2] || "00:00" }
    : { date: "", time: "" };
}
export const joinDateTime = (date, time) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
    ? `${date}T${time}:00`
    : null;
const wallClock = (value) => {
  const { date, time } = splitDateTime(value);
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number),
    [hh, mm] = time.split(":").map(Number);
  const result = new Date(y, m - 1, d, hh, mm);
  return Number.isNaN(result.getTime()) ? null : result;
};
export function formatCaptureDate(value, locale = "en-CA") {
  const date = wallClock(value);
  if (!date) return { date: null, time: null };
  return {
    date: new Intl.DateTimeFormat(locale, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  };
}
export function timezoneOffsetLabel(zone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value;
    return name === "GMT" ? "UTC+00:00" : (name || "").replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
}
export const COMMON_TIMEZONES = Object.freeze([
  "UTC",
  "America/St_Johns",
  "America/Halifax",
  "America/Toronto",
  "America/New_York",
  "America/Winnipeg",
  "America/Chicago",
  "America/Edmonton",
  "America/Denver",
  "America/Phoenix",
  "America/Vancouver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Athens",
  "Europe/Moscow",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
]);
export function timezoneOptions(current, at = new Date()) {
  const zones = [...COMMON_TIMEZONES];
  if (current && !zones.includes(current)) zones.unshift(current);
  return zones
    .map((zone) => ({ value: zone, offset: timezoneOffsetLabel(zone, at) }))
    .filter((option) => option.offset)
    .map((option) => ({
      ...option,
      label: `${option.offset} · ${option.value.replace(/_/g, " ")}`,
    }));
}
/* ---------- People ---------- */
export function ageAtCapture(birthday, takenAt) {
  const born = wallClock(birthday),
    at = wallClock(takenAt);
  if (!born || !at || at < born) return null;
  let age = at.getFullYear() - born.getFullYear();
  if (
    at.getMonth() < born.getMonth() ||
    (at.getMonth() === born.getMonth() && at.getDate() < born.getDate())
  )
    age--;
  return age;
}
export function personChipLabel(person, takenAt) {
  const name = person?.name?.trim() || "Unnamed person";
  const age = ageAtCapture(person?.birthday || person?.birthDate, takenAt);
  return age === null ? name : `${name} · ${age}`;
}
const validBox = (box) =>
  box &&
  ["x", "y", "width", "height"].every((key) => Number.isFinite(box[key])) &&
  box.width > 0 &&
  box.height > 0
    ? box
    : null;
/** Merge detected faces with the asset's people list into the chips the panel shows. */
export function peopleChips({
  faces = [],
  people = [],
  personIds = [],
  showHidden = false,
} = {}) {
  const byId = new Map(
    (people || []).filter((person) => person?.id).map((p) => [p.id, p]),
  );
  const byName = new Map(
    (people || [])
      .filter((person) => person?.name)
      .map((p) => [p.name.toLocaleLowerCase(), p]),
  );
  const chips = [];
  const covered = new Set();
  for (const face of Array.isArray(faces) ? faces : []) {
    if (!face || typeof face.id !== "string") continue;
    const person = face.personId ? byId.get(face.personId) || null : null;
    if (person) covered.add(person.id);
    chips.push({
      key: `face:${face.id}`,
      faceId: face.id,
      person,
      name: person?.name || "Unnamed person",
      hidden: !!person?.hidden,
      box: validBox(face.box),
    });
  }
  for (const id of Array.isArray(personIds) ? personIds : []) {
    const person =
      byId.get(id) || byName.get(String(id).toLocaleLowerCase()) || null;
    if (!person) {
      chips.push({
        key: `person:${id}`,
        faceId: null,
        person: null,
        name: String(id),
        hidden: false,
        box: null,
      });
      continue;
    }
    if (covered.has(person.id)) continue;
    covered.add(person.id);
    chips.push({
      key: `person:${person.id}`,
      faceId: null,
      person,
      name: person.name,
      hidden: !!person.hidden,
      box: validBox(person.faceBox),
    });
  }
  const hiddenCount = chips.filter((chip) => chip.hidden).length;
  return {
    chips: showHidden ? chips : chips.filter((chip) => !chip.hidden),
    hiddenCount,
  };
}
/* ---------- Stacks ---------- */
const timeKey = (asset) => asset.takenAt || asset.date || "";
export function stackMembers(assets, asset) {
  if (!asset?.stackId || !Array.isArray(assets)) return [];
  return assets
    .filter((item) => item && item.stackId === asset.stackId)
    .sort(
      (a, b) =>
        Number(!!b.stackPrimary) - Number(!!a.stackPrimary) ||
        timeKey(a).localeCompare(timeKey(b)) ||
        String(a.id).localeCompare(String(b.id)),
    );
}
export function stackNeighbor(members, currentId, direction = 1) {
  const index = members.findIndex((item) => item.id === currentId);
  if (index < 0) return null;
  const next = index + (direction < 0 ? -1 : 1);
  return next >= 0 && next < members.length ? members[next].id : null;
}
/* ---------- Ownership, enrichment, OCR ---------- */
const titleCase = (value) =>
  String(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + part.slice(1))
    .join(" ");
export function ownerLine(asset, currentUserId = "taylor", users = []) {
  if (!asset) return null;
  const nameOf = (id) =>
    users.find((user) => user?.id === id)?.name ||
    (typeof id === "string" && id ? titleCase(id) : null);
  if (asset.sharedBy) {
    const name =
      typeof asset.sharedBy === "string"
        ? nameOf(asset.sharedBy)
        : asset.sharedBy.name || nameOf(asset.sharedBy.id);
    return name ? `Shared by ${name}` : null;
  }
  if (asset.ownerId && asset.ownerId !== currentUserId)
    return `Owned by ${nameOf(asset.ownerId)}`;
  return null;
}
export function sensitivityReview(asset) {
  const review = asset?.enrichment?.sensitive;
  if (!review || typeof review !== "object") return null;
  const score = Number.isFinite(review.score) ? review.score : null;
  const predicted = score !== null ? score >= 0.5 : null;
  const marked = asset.isSensitive === true || asset.isLocked === true;
  const status =
    review.status === "needs-review"
      ? "Needs review"
      : review.status === "overridden" ||
          (predicted !== null && predicted !== marked)
        ? "Overridden"
        : "Reviewed";
  return { score, status, marked };
}
export function descriptionReview(asset) {
  const review = asset?.enrichment?.description;
  if (!review || typeof review !== "object") return null;
  return {
    status: review.status === "manual" ? "Manual" : "Generated",
    generated: review.status !== "manual",
    model: review.model || null,
    confidence: Number.isFinite(review.confidence)
      ? Math.round(review.confidence * 100)
      : null,
  };
}
/** Plausible, deterministic text regions for sample OCR output (one box per line). */
export function ocrRegions(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const height = 0.07,
    gap = 0.03,
    total = lines.length * height + Math.max(0, lines.length - 1) * gap,
    top = Math.max(0.05, 0.5 - total / 2);
  return lines.map((line, index) => {
    const width = Math.min(0.86, Math.max(0.12, line.length * 0.022));
    const shift = (((index * 37) % 11) - 5) / 100;
    return {
      id: `ocr-${index}`,
      text: line,
      x: Number((0.5 - width / 2 + shift).toFixed(4)),
      y: Number((top + index * (height + gap)).toFixed(4)),
      width: Number(width.toFixed(4)),
      height,
    };
  });
}
export const ratingValue = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 5 ? number : 0;
};
export function albumsForAsset(albums, asset) {
  const ids = new Set(Array.isArray(asset?.albumIds) ? asset.albumIds : []);
  return (Array.isArray(albums) ? albums : []).filter(
    (album) => album && ids.has(album.id),
  );
}
/* ---------- Preferences ---------- */
export const VIEWER_DEFAULTS = Object.freeze({
  interval: 5,
  look: "fit",
  caption: "description",
  order: "ascending",
  repeat: false,
  transition: "fade",
  progress: true,
  filmstrip: false,
});
const oneOf = (value, options, fallback) =>
  options.includes(value) ? value : fallback;
export function parseViewerPreferences(raw) {
  let data = null;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ...VIEWER_DEFAULTS };
  return {
    interval: oneOf(data.interval, [2, 3, 5, 10, 15, 30], 5),
    look: oneOf(data.look, ["fit", "fill", "blur"], "fit"),
    caption: oneOf(
      data.caption,
      ["off", "description", "details"],
      "description",
    ),
    order: oneOf(data.order, SLIDESHOW_ORDERS, "ascending"),
    repeat: data.repeat === true,
    transition: oneOf(
      data.transition,
      SLIDESHOW_TRANSITIONS.map(([id]) => id),
      VIEWER_DEFAULTS.transition,
    ),
    progress: data.progress !== false,
    filmstrip: data.filmstrip === true,
  };
}
/* ---------- More menu ---------- */
export function normalizeAvailableActions(list) {
  if (!Array.isArray(list)) return [...VIEWER_ACTIONS];
  return [
    ...new Set(
      list
        .map((id) => LEGACY_ACTION_ALIASES[id] || id)
        .filter((id) => VIEWER_ACTIONS.includes(id)),
    ),
  ];
}
export function viewerActionGroups(
  asset,
  {
    available = VIEWER_ACTIONS,
    trash = false,
    albumId = null,
    albumCount = 0,
    peopleCount = 0,
    readOnly = false,
  } = {},
) {
  if (!asset) return [];
  const video = viewerMedia(asset).isVideo,
    archived = asset.visibility === "archive" || asset.isArchived === true,
    locked = classifyLocked(asset),
    inAlbum = !!albumId && (asset.albumIds || []).includes(albumId),
    canDownload = asset.canDownload !== false;
  const groups = [
    {
      id: "download",
      label: "Download",
      items: [
        canDownload && {
          id: "download",
          label: "Download",
          icon: "mdiDownloadOutline",
        },
        canDownload &&
          asset.isEdited && {
            id: "download-original",
            label: "Download original",
            icon: "mdiFileDownloadOutline",
          },
        !video && {
          id: "copy-image",
          label: "Copy image",
          icon: "mdiContentCopy",
        },
      ],
    },
    trash
      ? {
          id: "trash",
          label: "Trash",
          items: [
            !readOnly && {
              id: "restore",
              label: "Restore",
              icon: "mdiDeleteRestore",
            },
            !readOnly && {
              id: "delete-permanently",
              label: "Delete permanently",
              icon: "mdiDeleteForeverOutline",
              danger: true,
            },
          ],
        }
      : {
          id: "organize",
          label: "Organize",
          items: [
            !readOnly && {
              id: "add-to-album",
              label: "Add to album",
              icon: "mdiImageAlbum",
            },
            !readOnly &&
              inAlbum && {
                id: "remove-from-album",
                label: "Remove from album",
                icon: "mdiPlaylistRemove",
                payload: { albumId },
              },
            !readOnly &&
              !locked && {
                id: archived ? "unarchive" : "archive",
                label: archived ? "Unarchive" : "Archive",
                icon: "mdiArchiveOutline",
              },
            !readOnly && {
              id: locked ? "unlock" : "lock",
              label: locked ? "Unmark Sensitive" : "Mark Sensitive",
              icon: locked
                ? "mdiLockOpenVariantOutline"
                : "mdiShieldLockOutline",
            },
          ],
        },
    !trash && {
      id: "stack",
      label: "Stack",
      items: [
        !readOnly &&
          !asset.stackId && {
            id: "add-to-stack",
            label: "Add to stack",
            icon: "mdiLayersPlus",
          },
        !readOnly &&
          asset.stackId && {
            id: "unstack",
            label: "Unstack",
            icon: "mdiLayersOutline",
          },
        !readOnly &&
          asset.stackId && {
            id: "stack-keep-this",
            label: "Keep this, remove the rest",
            icon: "mdiCheckDecagramOutline",
          },
        !readOnly &&
          asset.stackId &&
          !asset.stackPrimary && {
            id: "stack-set-primary",
            label: "Set as stack primary",
            icon: "mdiCrownOutline",
          },
      ],
    },
    !trash && {
      id: "set-as",
      label: "Set as",
      items: [
        !readOnly &&
          !video &&
          (inAlbum || albumCount > 0) && {
            id: "set-album-cover",
            label: "Album cover",
            icon: "mdiImageAlbum",
            ...(inAlbum ? { payload: { albumId } } : { chooser: "album" }),
          },
        !readOnly &&
          !video &&
          peopleCount > 0 && {
            id: "set-person-featured",
            label: "Featured photo for person",
            icon: "mdiAccountCircleOutline",
            chooser: "person",
          },
        !video && {
          id: "set-profile-picture",
          label: "Profile picture",
          icon: "mdiAccountEditOutline",
        },
      ],
    },
    !trash && {
      id: "navigate",
      label: "Go to",
      items: [
        {
          id: "view-in-timeline",
          label: "View in timeline",
          icon: "mdiTimelineClockOutline",
        },
        {
          id: "find-similar",
          label: "Find similar",
          icon: "mdiImageSearchOutline",
        },
        (asset.city || asset.latitude != null) && {
          id: "view-on-map",
          label: "View on map",
          icon: "mdiMapMarkerOutline",
        },
        asset.originalPath && {
          id: "open-folder",
          label: "Show in folder",
          icon: "mdiFolderOpenOutline",
        },
      ],
    },
    !trash &&
      !readOnly && {
        id: "jobs",
        label: "Jobs",
        items: [
          !video && {
            id: "refresh-faces",
            label: "Refresh faces",
            icon: "mdiFaceRecognition",
          },
          {
            id: "refresh-metadata",
            label: "Refresh metadata",
            icon: "mdiDatabaseRefreshOutline",
          },
          {
            id: "refresh-thumbnails",
            label: "Refresh thumbnails",
            icon: "mdiImageMultipleOutline",
          },
          video && {
            id: "refresh-encoded",
            label: "Refresh encoded video",
            icon: "mdiVideoOutline",
          },
          video && {
            id: "transcode",
            label: "Transcode video",
            icon: "mdiMovieOpenOutline",
          },
        ],
      },
  ];
  return groups
    .filter(Boolean)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item && available.includes(item.id)),
    }))
    .filter((group) => group.items.length > 0);
}

/** Slideshow transitions. Fade stays the default; Ken Burns and Memories add slow pan and zoom. */
export const SLIDESHOW_TRANSITIONS = Object.freeze([
  ["none", "None"],
  ["fade", "Fade"],
  ["slide", "Slide"],
  ["ken-burns", "Ken Burns"],
  ["memories", "Memories"],
]);
/** Reduce Motion keeps the pacing but swaps moving transitions for a fade. */
export function effectiveTransition(transition, reducedMotion = false) {
  const known = SLIDESHOW_TRANSITIONS.some(([id]) => id === transition)
    ? transition
    : VIEWER_DEFAULTS.transition;
  return reducedMotion && ["slide", "ken-burns", "memories"].includes(known)
    ? "fade"
    : known;
}

const kenBurnsMoves = [
  { from: "scale(1) translate(0, 0)", to: "scale(1.14) translate(-3%, -2%)" },
  { from: "scale(1.14) translate(3%, 2%)", to: "scale(1.02) translate(0, 0)" },
  { from: "scale(1.1) translate(-4%, 0)", to: "scale(1.1) translate(4%, 0)" },
  { from: "scale(1.08) translate(0, 3%)", to: "scale(1.16) translate(0, -3%)" },
];
/** Deterministic pan/zoom per asset so the same photo always moves the same way. */
export function kenBurnsMove(assetId) {
  let hash = 0;
  for (const character of String(assetId ?? ""))
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return kenBurnsMoves[hash % kenBurnsMoves.length];
}
