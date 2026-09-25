import {
  ASPECT_IDS,
  DEVELOP_PARAMS,
  PRESET_IDS,
  SPEEDS,
  TEXT_POSITIONS,
  clampParam,
  developDefaults,
  normalizeRect,
} from "./develop.mjs";

const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, fallback = "", limit = 4096) =>
  typeof value === "string" ? value.slice(0, limit) : fallback;
const number = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const choice = (value, choices, fallback) =>
  choices.includes(value) ? value : fallback;
/**
 * Videos carry a real duration (a video without one keeps the legacy 24 s
 * sample length). Photos have no timeline at all, so their duration is 0.
 */
export const durationFor = (asset) =>
  Number.isFinite(asset?.duration) && asset.duration > 0
    ? Math.max(0.1, asset.duration)
    : asset?.type === "video"
      ? 24
      : 0;
export const hasTimeline = (asset) => durationFor(asset) > 0;

export const EDIT_VERSION = 2;
export const CROP_ASPECTS = ASPECT_IDS;
const boolean = (value) => value === true;
const COLOR = /^#[0-9a-f]{6}$/i;
const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

export const initialEdit = {
  version: EDIT_VERSION,
  rotation: 0,
  ...developDefaults(),
  volume: 100,
  start: 0,
  end: 24,
  trim: "precise",
  crop: "Original",
  cropRect: { ...FULL_RECT },
  straighten: 0,
  flipH: false,
  flipV: false,
  preset: "Original",
  presetStrength: 100,
  speed: 1,
  speedSegments: [],
  textOverlays: [],
  stabilize: false,
  autoEnhance: false,
  title: "Summer in the Rockies",
  animation: "Fade in",
  caption: "",
  captionLanguage: "Auto detect",
  comment: "",
  commentTime: 0,
  restorationMode: "Faithful",
  exportFormat: "MP4 · H.265 Main10",
  exportColor: "Preserve source",
};

const normalizeSegments = (items, start, end) =>
  (Array.isArray(items) ? items : [])
    .filter(object)
    .slice(0, 20)
    .flatMap((item) => {
      const from = number(item.start, NaN, start, end);
      const to = number(item.end, NaN, start, end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
        return [];
      return [
        {
          start: from,
          end: to,
          speed: choice(item.speed, SPEEDS, 2),
        },
      ];
    })
    .sort((a, b) => a.start - b.start);

const normalizeOverlays = (items, duration) =>
  (Array.isArray(items) ? items : [])
    .filter(object)
    .slice(0, 20)
    .map((item, index) => {
      const start = number(item.start, 0, 0, duration);
      return {
        id: text(String(item.id ?? `text-${index + 1}`), `text-${index + 1}`, 64),
        text: text(item.text, "", 200),
        position: choice(item.position, TEXT_POSITIONS, "bottom"),
        start,
        end: number(item.end, duration, start, duration),
        fontSize: Math.round(number(item.fontSize, 32, 12, 96)),
        color: COLOR.test(item.color) ? item.color.toLowerCase() : "#ffffff",
        shadow: item.shadow !== false,
      };
    });

export function normalizeEdit(candidate, asset) {
  const value = object(candidate) ? candidate : {};
  const duration = durationFor(asset);
  const timeline = duration > 0;
  const start = timeline
    ? number(value.start, 0, 0, Math.max(0, duration - 0.1))
    : 0;
  const end = timeline ? number(value.end, duration, start + 0.1, duration) : 0;
  // Version 1 drafts stored saturation as a 0–150 percentage; centre it.
  const legacy = value.version !== EDIT_VERSION;
  const develop = Object.fromEntries(
    DEVELOP_PARAMS.map((item) => {
      let raw = value[item.id];
      if (item.id === "saturation" && legacy && Number.isFinite(raw))
        raw = raw - 100;
      return [item.id, clampParam(item.id, raw)];
    }),
  );
  return {
    version: EDIT_VERSION,
    rotation: (Math.round(number(value.rotation, 0, 0, 360) / 90) * 90) % 360,
    ...develop,
    volume: number(value.volume, 100, 0, 150),
    start,
    end,
    trim: choice(value.trim, ["precise", "fast"], "precise"),
    crop: choice(value.crop, ASPECT_IDS, "Original"),
    cropRect: normalizeRect(value.cropRect),
    straighten: number(value.straighten, 0, -45, 45),
    flipH: boolean(value.flipH),
    flipV: boolean(value.flipV),
    preset: choice(value.preset, PRESET_IDS, "Original"),
    presetStrength: Math.round(number(value.presetStrength, 100, 0, 100)),
    speed: choice(value.speed, SPEEDS, 1),
    speedSegments: timeline ? normalizeSegments(value.speedSegments, start, end) : [],
    textOverlays: normalizeOverlays(value.textOverlays, duration),
    stabilize: boolean(value.stabilize),
    autoEnhance: boolean(value.autoEnhance),
    title: text(value.title, initialEdit.title),
    animation: choice(
      value.animation,
      ["Fade in", "Rise", "Typewriter"],
      "Fade in",
    ),
    caption: text(value.caption),
    captionLanguage: choice(
      value.captionLanguage,
      ["Auto detect", "English", "French"],
      "Auto detect",
    ),
    comment: text(value.comment),
    commentTime: number(value.commentTime, 0, 0, duration),
    restorationMode: choice(
      value.restorationMode,
      ["Faithful", "Creative"],
      "Faithful",
    ),
    exportFormat: choice(
      value.exportFormat,
      ["MP4 · H.265 Main10", "MP4 · H.264", "WebM · AV1"],
      initialEdit.exportFormat,
    ),
    exportColor: choice(
      value.exportColor,
      ["Preserve source", "HDR10", "Dolby Vision · qualification required"],
      initialEdit.exportColor,
    ),
  };
}

export function normalizeDraft(candidate, asset) {
  const value = object(candidate) ? candidate : {};
  const history = (items) =>
    Array.isArray(items)
      ? items
          .filter(object)
          .slice(-200)
          .map((item) => normalizeEdit(item, asset))
      : [];
  return {
    edit: normalizeEdit(value.edit, asset),
    undo: history(value.undo),
    redo: history(value.redo),
  };
}

export function changeDraft(draft, patch, asset) {
  const edit = normalizeEdit({ ...draft.edit, ...patch }, asset);
  return JSON.stringify(edit) === JSON.stringify(draft.edit)
    ? draft
    : {
        edit,
        undo: [...draft.undo, draft.edit].slice(-200),
        redo: [],
      };
}

export function travelDraft(draft, direction, asset) {
  const source = direction === "undo" ? "undo" : "redo";
  const target = source === "undo" ? "redo" : "undo";
  if (!draft[source].length) return draft;
  return {
    edit: normalizeEdit(draft[source].at(-1), asset),
    [source]: draft[source].slice(0, -1),
    [target]: [...draft[target], draft.edit].slice(-200),
  };
}

export function parseSavedPrototype(raw, assets, readView) {
  let saved;
  try {
    saved = JSON.parse(raw || "{}");
  } catch {
    saved = {};
  }
  if (!object(saved)) saved = {};
  const ids = new Set(assets.map((asset) => asset.id));
  const validIds = (value) =>
    Array.isArray(value)
      ? [...new Set(value.filter((id) => ids.has(id)))]
      : null;
  const openAssetId = ids.has(saved.openAssetId)
    ? saved.openAssetId
    : assets[0].id;
  const active = assets.find((asset) => asset.id === openAssetId);
  const drafts = Object.fromEntries(
    assets.map((asset) => {
      const draft = object(saved.drafts) ? saved.drafts[asset.id] : undefined;
      const legacy =
        asset.id === openAssetId
          ? {
              edit: object(saved.edit)
                ? { ...saved.edit, note: text(saved.note) }
                : undefined,
              undo: saved.undo,
            }
          : {};
      return [asset.id, normalizeDraft(object(draft) ? draft : legacy, asset)];
    }),
  );
  const presets = (Array.isArray(saved.presets) ? saved.presets : [])
    .filter(object)
    .slice(0, 200)
    .flatMap((item) => {
      const state = readView(item.state);
      const kind = choice(
        item.kind,
        ["Smart album", "Album snapshot", "Filter preset"],
        null,
      );
      const snapshot = validIds(item.ids);
      if (
        !state ||
        !kind ||
        !text(item.name).trim() ||
        (kind === "Album snapshot" && !snapshot)
      )
        return [];
      return [
        {
          id: text(String(item.id)),
          name: text(item.name),
          kind,
          searchBy: choice(
            item.searchBy,
            ["semantic", "text", "filename", "description", "ocr", "fullPath"],
            "semantic",
          ),
          state,
          ...(kind === "Album snapshot" ? { ids: snapshot } : {}),
        },
      ];
    });
  const versions = (Array.isArray(saved.versions) ? saved.versions : [])
    .filter(object)
    .slice(-500)
    .flatMap((item) => {
      const asset = assets.find(
        (asset) => asset.id === (item.assetId || assets[0].id),
      );
      if (!asset || !object(item.edit)) return [];
      return [
        {
          id: text(String(item.id)),
          assetId: asset.id,
          name: text(item.name, "Saved version"),
          edit: normalizeEdit(item.edit, asset),
        },
      ];
    });
  const jobs = (Array.isArray(saved.jobs) ? saved.jobs : [])
    .filter(object)
    .slice(0, 200)
    .map((item) => ({
      id: text(String(item.id)),
      kind: text(item.kind, "Export"),
      name: text(item.name, "Sample media"),
      destination: choice(
        item.destination === "runpod" ? "cloud" : item.destination,
        ["local", "lan", "cloud"],
        "local",
      ),
      simulated: true,
      status: choice(
        item.status,
        [
          "queued",
          "preparing",
          "rendering",
          "validating",
          "paused",
          "completed",
          "cancelled",
          "failed",
        ],
        "paused",
      ),
      progress: number(item.progress, 0, 0, 100),
      // When the current stage began (ms), so Queued/Starting timers survive a reload.
      ...(Number.isFinite(item.stageStartedAt) && item.stageStartedAt > 0
        ? { stageStartedAt: Math.round(item.stageStartedAt) }
        : {}),
      ...(typeof item.error === "string" ? { error: text(item.error, "", 400) } : {}),
      ...(item.preview === true ? { preview: true } : {}),
      ...(object(item.estimate)
        ? {
            estimate: {
              seconds: number(item.estimate.seconds, 0, 0, 1e7),
              sizeBytes: number(item.estimate.sizeBytes, 0, 0, 1e13),
              ...(object(item.estimate.cloudCost)
                ? { cloudCost: structuredClone(item.estimate.cloudCost) }
                : {}),
            },
          }
        : {}),
      ...(object(item.settings)
        ? {
            settings: {
              ...structuredClone(item.settings),
              ...(item.settings.destination === "runpod" ? { destination: "cloud" } : {}),
            },
          }
        : {}),
      ...(object(item.cloud) ? { cloud: cloudJobMeta(item.cloud) } : {}),
      snapshot:
        object(item.snapshot) && ids.has(item.snapshot.assetId)
          ? {
              assetId: item.snapshot.assetId,
              edit: normalizeEdit(
                item.snapshot.edit,
                assets.find((asset) => asset.id === item.snapshot.assetId),
              ),
            }
          : null,
    }));
  return {
    openAssetId,
    drafts,
    versions,
    presets,
    jobs,
    notes: Object.fromEntries(
      assets.map((asset) => [
        asset.id,
        text(
          object(saved.notes)
            ? saved.notes[asset.id]
            : (saved.drafts?.[asset.id]?.edit?.note ??
                (asset.id === openAssetId ? saved.note : "")),
        ),
      ]),
    ),
    layout: choice(saved.layout, ["timeline", "browse", "work"], "browse"),
    railCollapsed: saved.railCollapsed === true,
    searchBy: choice(
      saved.searchBy,
      ["semantic", "text", "filename", "description", "ocr", "fullPath"],
      "semantic",
    ),
    view: readView(saved.view),
    recentSearches: (Array.isArray(saved.recentSearches)
      ? saved.recentSearches
      : []
    )
      .flatMap((item) => {
        const term =
          typeof item === "string" ? item : object(item) ? item.text : "";
        if (!text(term).trim()) return [];
        const mode = choice(
          item.mode,
          ["semantic", "text", "filename", "description", "ocr", "fullPath"],
          "semantic",
        );
        const state = object(item.query)
          ? readView({
              version: 1,
              scope: { kind: "library" },
              query: item.query,
              sort: "captured-desc",
              grouping: "all",
              view: "grid",
            })
          : null;
        return [
          {
            text: text(term, "", 500),
            mode,
            ...(state ? { query: state.query } : {}),
          },
        ];
      })
      .slice(0, 5),
    theme: saved.theme === "light" ? "light" : "dark",
    collection: text(saved.collection, "Summer in the Rockies"),
    destination:
      saved.destination === "cloud" || saved.destination === "runpod"
        ? "cloud"
        : "local",
    selection: validIds(saved.selection) ?? [assets[0].id],
    snapshotIds: validIds(saved.snapshotIds),
    ratings: Object.fromEntries(
      Object.entries(object(saved.ratings) ? saved.ratings : {}).filter(
        ([id, value]) =>
          ids.has(id) && Number.isInteger(value) && value >= -1 && value <= 5,
      ),
    ),
    playbackPosition: number(saved.playbackPosition, 0, 0, durationFor(active)),
    scroll: number(saved.scroll, 0, 0, 1e7),
    scrollAnchor:
      object(saved.scrollAnchor) && ids.has(saved.scrollAnchor.id)
        ? {
            id: saved.scrollAnchor.id,
            offset: number(saved.scrollAnchor.offset, 0, -1e5, 1e5),
          }
        : null,
  };
}

export function applyPreset(context, preset) {
  if (preset.kind === "Filter preset")
    return {
      ...context,
      state: {
        ...context.state,
        query: {
          ...context.state.query,
          filter: structuredClone(preset.state.query.filter),
        },
      },
    };
  return {
    collection: preset.name,
    snapshotIds: preset.ids ? [...preset.ids] : null,
    state: structuredClone(preset.state),
  };
}

/** Frameleaf Cloud cost facts kept with a job: estimate band, hold and settled charge. */
function cloudJobMeta(value) {
  const usd = (input) => number(input, 0, 0, 1e5);
  return {
    modelId: text(value.modelId, "", 80),
    modelName: text(value.modelName, "Frameleaf Cloud", 120),
    quantity: number(value.quantity, 0, 0, 1e7),
    quantityLabel: text(value.quantityLabel, "", 40),
    p50: usd(value.p50),
    p90: usd(value.p90),
    hold: usd(value.hold),
    gpuClass: text(value.gpuClass, "", 40),
    gpuClassLabel: text(value.gpuClassLabel, "", 80),
    rate: number(value.rate, 0, 0, 1),
    startFee: usd(value.startFee),
    workers: number(value.workers, 1, 1, 64),
    workSeconds: number(value.workSeconds, 0, 0, 1e7),
    disclosureVersion: text(value.disclosureVersion, "", 20),
    consentedAt: text(value.consentedAt, "", 40),
    settled: value.settled === true,
    chargedUsd: Number.isFinite(value.chargedUsd) ? usd(value.chargedUsd) : null,
  };
}

export function createSimulatedJob(kind, asset, edit, destination) {
  return {
    id: crypto.randomUUID(),
    kind,
    name: asset.name,
    destination,
    status: "queued",
    progress: 0,
    simulated: true,
    snapshot: {
      assetId: asset.id,
      edit: structuredClone(normalizeEdit(edit, asset)),
    },
  };
}

/** A shared search URL must never inherit membership from an unrelated local snapshot. */
export function restoredViewContext(saved, incoming) {
  const same =
    !incoming ||
    (saved.view && JSON.stringify(incoming) === JSON.stringify(saved.view));
  const view = incoming || saved.view;
  const names = {
    "summer-rockies": "Summer in the Rockies",
    "summer-in-the-rockies": "Summer in the Rockies",
    family: "Family",
    "family-space": "Family Space",
    everyday: "Everyday",
    "winter-2026": "Winter 2026",
  };
  return {
    view,
    snapshotIds: same ? saved.snapshotIds : null,
    collection: same
      ? saved.collection
      : names[incoming?.scope.id] ||
        (incoming?.scope.kind === "library" ? "Library" : "Collection"),
  };
}
