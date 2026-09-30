import { DEVELOP_KEYS, clampParam, cssFilterFor, developDefaults, normalizeRect } from "./develop.mjs";
import { commit, createHistory } from "./studio-project.mjs";

// Design reference only: edits describe a CSS/canvas preview, never a RAW decode.
export const photographyStorageKey = (shoot) => `frameleaf.photography.v1:${String(shoot?.id || "workspace")}`;
export const CHANNELS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue"];
export const SYNC_GROUPS = {
  tone: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "curve"],
  colour: ["temperature", "tint", "vibrance", "saturation", "hsl", "preset", "presetStrength"],
  detail: ["sharpen", "noiseReduction", "clarity", "lens"],
  geometry: ["crop", "aspect", "rotation", "straighten"],
  masks: ["masks"],
};
export const PRESET_KEYS = ["tone", "colour", "detail"].flatMap((group) => SYNC_GROUPS[group]);
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const bounded = (value, min, max, fallback = 0) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
export const normalizePoint = (point) => ({ x: bounded(point?.x, 0, 1, 0.5), y: bounded(point?.y, 0, 1, 0.5) });
export const uid = (prefix = "edit") => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export const SAMPLE_PHOTOS = [
  { id: "photo-portrait", name: "DSC_1042.ARW", image: "/media/portrait.png", extension: "ARW", camera: "Sony α7 IV", raw: true, rating: 4 },
  { id: "photo-hiking", name: "DSC_1043.ARW", image: "/media/hiking.png", extension: "ARW", camera: "Sony α7 IV", raw: true, rating: 3 },
  { id: "photo-lake", name: "DSC_1044.ARW", image: "/media/lake.png", extension: "ARW", camera: "Sony α7 IV", raw: true, rating: 5 },
  { id: "photo-forest", name: "DSC_1045.ARW", image: "/media/forest.png", extension: "ARW", camera: "Sony α7 IV", raw: true, rating: 3 },
  { id: "photo-unsupported", name: "SDIM_1046.X3F", image: "/media/summit.png", extension: "X3F", camera: "Sigma SD Quattro", raw: true, rating: 2 },
];

export function normalizePhotos(photos) {
  const source = Array.isArray(photos) && photos.length ? photos : SAMPLE_PHOTOS;
  const seen = new Set();
  return source.filter((photo) => photo && typeof photo === "object").map((photo, index) => {
    const base = String(photo.id ?? `photo-${index}`);
    const id = seen.has(base) ? `${base}-${index}` : base;
    seen.add(id);
    const name = String(photo.name || `IMG_${String(index + 1).padStart(4, "0")}.DNG`);
    return { ...photo, id, name, image: photo.image || "/media/portrait.png", extension: String(photo.extension || name.split(".").at(-1) || "DNG").toUpperCase(), camera: photo.camera || "Camera metadata unavailable" };
  });
}

export const defaultEdit = () => ({
  ...developDefaults(), preset: "Original", presetStrength: 100,
  curve: [0, 0.25, 0.5, 0.75, 1],
  hsl: Object.fromEntries(CHANNELS.map((channel) => [channel, { hue: 0, saturation: 0, luminance: 0 }])),
  crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: "Original", rotation: 0, straighten: 0, lens: true, masks: [],
});

export function normalizeMask(mask) {
  if (!mask || typeof mask !== "object") return null;
  const type = ["brush", "radial", "gradient", "subject", "sky"].includes(mask.type) ? mask.type : "brush";
  return {
    id: String(mask.id || uid("mask")), name: String(mask.name || type), type,
    enabled: mask.enabled !== false, invert: !!mask.invert, feather: bounded(mask.feather, 0, 100, 35),
    exposure: bounded(mask.exposure, -2, 2, 0.35), center: normalizePoint(mask.center),
    radius: { x: bounded(mask.radius?.x, 0.02, 1, 0.22), y: bounded(mask.radius?.y, 0.02, 1, 0.3) },
    start: normalizePoint(mask.start || { x: 0.5, y: 0.15 }), end: normalizePoint(mask.end || { x: 0.5, y: 0.6 }),
    // ponytail: 2,000 points per stroke keep prototype recovery small; use raster tiles for production brushes.
    strokes: (Array.isArray(mask.strokes) ? mask.strokes : []).slice(-60).map((stroke) => ({
      mode: stroke.mode === "subtract" ? "subtract" : "add", size: bounded(stroke.size, 0.01, 0.4, 0.08),
      points: (Array.isArray(stroke.points) ? stroke.points : []).slice(0, 2000).map(normalizePoint),
    })).filter((stroke) => stroke.points.length),
  };
}

export function normalizePhotographyEdit(value) {
  const defaults = defaultEdit();
  const edit = value && typeof value === "object" ? value : {};
  return {
    ...defaults,
    ...Object.fromEntries(DEVELOP_KEYS.map((key) => [key, clampParam(key, edit[key] ?? defaults[key])])),
    preset: typeof edit.preset === "string" ? edit.preset : "Original", presetStrength: bounded(edit.presetStrength, 0, 100, 100),
    curve: Array.from({ length: 5 }, (_, i) => bounded(edit.curve?.[i], 0, 1, defaults.curve[i])),
    hsl: Object.fromEntries(CHANNELS.map((channel) => [channel, Object.fromEntries(["hue", "saturation", "luminance"].map((key) => [key, bounded(edit.hsl?.[channel]?.[key], -100, 100)]))])),
    crop: normalizeRect(edit.crop), aspect: ["Original", "Free", "1:1", "3:2", "4:5", "16:9"].includes(edit.aspect) ? edit.aspect : "Original",
    rotation: bounded(edit.rotation, -360, 360), straighten: bounded(edit.straighten, -20, 20), lens: edit.lens !== false,
    masks: (Array.isArray(edit.masks) ? edit.masks : []).slice(0, 20).map(normalizeMask).filter(Boolean),
  };
}

export function createSession(photos) {
  const sources = normalizePhotos(photos);
  return {
    schema: 1, activeId: sources[0]?.id, selected: sources.slice(0, Math.min(3, sources.length)).map((photo) => photo.id), presets: [],
    records: Object.fromEntries(sources.map((photo) => [photo.id, {
      rating: bounded(photo.rating, 0, 5), history: createHistory(defaultEdit()), versions: [],
    }])),
  };
}

export function recoverSession(photos, serialized) {
  const fresh = createSession(photos);
  const sources = normalizePhotos(photos);
  try {
    const saved = JSON.parse(serialized);
    if (saved?.schema !== 1 || !saved.records || typeof saved.records !== "object") return fresh;
    for (const id of Object.keys(fresh.records)) {
      const record = saved.records[id];
      if (!record || typeof record !== "object") continue;
      fresh.records[id] = {
        // Current shoot culling is authoritative; persisted edits must not replace a newer source rating.
        rating: Number.isFinite(sources.find((photo) => photo.id === id)?.rating) ? fresh.records[id].rating : bounded(record.rating, 0, 5), history: createHistory(normalizePhotographyEdit(record.history?.present)),
        versions: (Array.isArray(record.versions) ? record.versions : []).slice(-20).filter((version) => version && typeof version === "object").map((version) => ({
          id: String(version.id || uid("version")), name: String(version.name || "Saved version"), at: typeof version.at === "string" ? version.at : "", edit: normalizePhotographyEdit(version.edit),
        })),
      };
      // Undo/redo remain available after recovery; malformed persisted history is bounded and normalized.
      fresh.records[id].history.past = (Array.isArray(record.history?.past) ? record.history.past : []).slice(-30).map(normalizePhotographyEdit);
      fresh.records[id].history.future = (Array.isArray(record.history?.future) ? record.history.future : []).slice(0, 30).map(normalizePhotographyEdit);
    }
    fresh.activeId = saved.activeId in fresh.records ? saved.activeId : fresh.activeId;
    fresh.selected = Array.isArray(saved.selected) ? saved.selected.filter((id) => id in fresh.records) : fresh.selected;
    fresh.presets = (Array.isArray(saved.presets) ? saved.presets : []).slice(-20).filter((preset) => preset && typeof preset === "object").map((preset) => ({
      id: String(preset.id || uid("preset")), name: String(preset.name || "Saved preset"), edit: normalizePhotographyEdit(preset.edit),
    }));
    return fresh;
  } catch { return fresh; }
}

export function readSession(photos, storage, key) {
  try { return recoverSession(photos, storage?.getItem(key)); } catch { return createSession(photos); }
}
export function saveSession(storage, key, session) {
  try { storage?.setItem(key, JSON.stringify(session)); return !!storage; } catch { return false; }
}

export function updatePhoto(session, id, patch, { quiet = false } = {}) {
  const record = session.records[id];
  if (!record) return session;
  const next = normalizePhotographyEdit({ ...record.history.present, ...patch });
  if (JSON.stringify(next) === JSON.stringify(record.history.present)) return session;
  const history = quiet ? { ...record.history, present: next } : commit(record.history, next, 30);
  return { ...session, records: { ...session.records, [id]: { ...record, history } } };
}

export function syncEdits(session, fromId, targetIds, groups) {
  const edit = session.records[fromId]?.history.present;
  if (!edit) return session;
  const keys = new Set(groups.flatMap((group) => SYNC_GROUPS[group] || []));
  const patch = Object.fromEntries([...keys].map((key) => [key, clone(edit[key])]));
  return targetIds.filter((id) => id !== fromId).reduce((next, id) => updatePhoto(next, id, patch), session);
}

export function saveVersion(session, id, name) {
  const record = session.records[id];
  if (!record) return session;
  const version = { id: uid("version"), name: name?.trim() || `Version ${record.versions.length + 1}`, at: new Date().toISOString(), edit: clone(record.history.present) };
  return { ...session, records: { ...session.records, [id]: { ...record, versions: [...record.versions, version].slice(-20) } } };
}

export function makeMask(type, index = 0) {
  const names = { brush: "Brush", radial: "Radial", gradient: "Linear gradient", subject: "Suggested subject", sky: "Suggested sky" };
  return normalizeMask({ id: uid("mask"), type, name: `${names[type] || "Brush"} ${index + 1}`, center: { x: 0.5, y: 0.5 }, radius: { x: 0.22, y: 0.3 } });
}

/** HSL, curves, denoise and lens are deliberately approximate here, not sensor-space processing. */
export function previewFor(edit) {
  const preview = cssFilterFor(edit);
  const channels = Object.values(edit.hsl);
  const mean = (key) => channels.reduce((sum, channel) => sum + channel[key], 0) / channels.length;
  const midpoint = edit.curve[2] - 0.5;
  const curveContrast = Math.max(0.3, 1 + (edit.curve[3] - edit.curve[1] - 0.5) * 1.2);
  const layers = edit.lens ? preview.layers : [...preview.layers, { id: "lens-falloff", style: { background: "radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,.24) 100%)" } }];
  return { ...preview, layers, filter: `${preview.filter} brightness(${Math.max(0.2, 1 + midpoint * 0.8 + mean("luminance") / 250)}) contrast(${curveContrast}) saturate(${Math.max(0, 1 + mean("saturation") / 100)}) hue-rotate(${mean("hue")}deg)` };
}

export function createBatch(photos, ids, settings = {}) {
  const selected = normalizePhotos(photos).filter((photo) => ids.includes(photo.id));
  if (selected.length < 2 || selected.length > 5) throw new Error("Select 2–5 photos for the mock batch.");
  return {
    id: uid("batch"), status: "running", settings: { format: settings.format === "TIFF" ? "TIFF" : "JPEG", profile: ["sRGB", "Adobe RGB", "Display P3"].includes(settings.profile) ? settings.profile : "sRGB", bitDepth: settings.format === "TIFF" ? 16 : 8 },
    items: selected.map((photo, index) => ({ id: photo.id, name: photo.name, status: "queued", progress: 0, error: null, unsupported: !!photo.unsupported || photo.extension === "X3F" || (!!settings.simulateFailure && index === selected.length - 1), previewOnly: false })),
  };
}

export function tickBatch(queue) {
  if (!queue || queue.status !== "running") return queue;
  const index = queue.items.findIndex((item) => ["queued", "running"].includes(item.status));
  if (index < 0) return { ...queue, status: queue.items.some((item) => item.status === "failed") ? "issues" : "complete" };
  const items = queue.items.map((item, i) => {
    if (i !== index) return item;
    const progress = Math.min(100, item.progress + 20);
    if (progress < 100) return { ...item, status: "running", progress };
    return item.unsupported && !item.previewOnly
      ? { ...item, status: "failed", progress, error: "Unsupported RAW decoder in this simulation. Retry with the local JPEG preview." }
      : { ...item, status: "complete", progress, error: null };
  });
  const pending = items.some((item) => ["queued", "running"].includes(item.status));
  return { ...queue, items, status: pending ? "running" : items.some((item) => item.status === "failed") ? "issues" : "complete" };
}

export const cancelBatch = (queue) => !queue || queue.status !== "running" ? queue : ({
  ...queue, status: "cancelled", items: queue.items.map((item) => ["queued", "running"].includes(item.status) ? { ...item, status: "cancelled" } : item),
});

export function retryBatch(queue, id, { previewOnly = false } = {}) {
  if (!queue || !queue.items.some((item) => item.id === id && ["failed", "cancelled"].includes(item.status))) return queue;
  return { ...queue, status: "running", items: queue.items.map((item) => item.id === id && ["failed", "cancelled"].includes(item.status) ? { ...item, status: "queued", progress: 0, error: null, previewOnly } : item) };
}
