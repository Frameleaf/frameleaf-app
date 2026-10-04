/**
 * Develop module: the parameter schema behind Adjust, the preset looks, the
 * CSS approximation used for live previews, histogram sampling, and the pure
 * crop geometry used by the editing surface. Everything here is deterministic
 * and runs in node for tests.
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

export const DEVELOP_GROUPS = [
  { id: "light", label: "Light" },
  { id: "color", label: "Color" },
  { id: "effects", label: "Effects" },
  { id: "detail", label: "Detail" },
];

const param = (id, label, group, options = {}) => ({
  id,
  label,
  group,
  min: -100,
  max: 100,
  default: 0,
  step: 1,
  unit: "",
  ...options,
});

export const DEVELOP_PARAMS = [
  param("exposure", "Exposure", "light", {
    min: -2,
    max: 2,
    step: 0.05,
    unit: "EV",
  }),
  param("contrast", "Contrast", "light"),
  param("highlights", "Highlights", "light"),
  param("shadows", "Shadows", "light"),
  param("whites", "Whites", "light"),
  param("blacks", "Blacks", "light"),
  param("temperature", "Temperature", "color"),
  param("tint", "Tint", "color"),
  param("vibrance", "Vibrance", "color"),
  param("saturation", "Saturation", "color"),
  param("clarity", "Clarity", "effects"),
  param("dehaze", "Dehaze", "effects"),
  param("vignette", "Vignette", "effects"),
  param("grain", "Grain", "effects", { min: 0 }),
  param("sharpen", "Sharpen", "detail", { min: 0 }),
  param("noiseReduction", "Noise reduction", "detail", { min: 0 }),
];

export const DEVELOP_KEYS = DEVELOP_PARAMS.map((item) => item.id);
const paramsById = Object.fromEntries(
  DEVELOP_PARAMS.map((item) => [item.id, item]),
);

export const paramFor = (id) => paramsById[id];

export const developDefaults = () =>
  Object.fromEntries(DEVELOP_PARAMS.map((item) => [item.id, item.default]));

export function clampParam(id, value) {
  const spec = paramsById[id];
  if (!spec) return 0;
  if (!Number.isFinite(value)) return spec.default;
  const stepped = Math.round(value / spec.step) * spec.step;
  return round(clamp(stepped, spec.min, spec.max), 3);
}

export const paramsInGroup = (group) =>
  DEVELOP_PARAMS.filter((item) => item.group === group);

export const groupIsDefault = (edit, group) =>
  paramsInGroup(group).every(
    (item) => finite(edit?.[item.id], item.default) === item.default,
  );

export const groupReset = (group) =>
  Object.fromEntries(
    paramsInGroup(group).map((item) => [item.id, item.default]),
  );

/** A gentle, image-agnostic tone recipe used by the Auto button. */
export const AUTO_TONE = {
  exposure: 0.15,
  contrast: 12,
  highlights: -22,
  shadows: 18,
  whites: 8,
  blacks: -6,
  vibrance: 14,
  clarity: 6,
};

export const autoToneApplied = (edit) =>
  Object.entries(AUTO_TONE).every(
    ([key, value]) => finite(edit?.[key]) === value,
  );

/** Looks. `params` nudge develop sliders; `look` adds grayscale/sepia mixes. */
export const PRESETS = [
  { id: "Original", label: "Original", params: {} },
  {
    id: "Vivid",
    label: "Vivid",
    params: { contrast: 18, vibrance: 30, saturation: 12, clarity: 10 },
  },
  {
    id: "Natural",
    label: "Natural",
    params: { contrast: 6, highlights: -12, shadows: 10, vibrance: 8 },
  },
  {
    id: "Warm",
    label: "Warm",
    params: { temperature: 32, tint: 6, vibrance: 8 },
  },
  {
    id: "Cool",
    label: "Cool",
    params: { temperature: -30, tint: -4, contrast: 6 },
  },
  {
    id: "Mono",
    label: "Mono",
    params: { contrast: 8 },
    look: { grayscale: 100 },
  },
  {
    id: "Silvertone",
    label: "Silvertone",
    params: { contrast: 14, highlights: -8, clarity: 8 },
    look: { grayscale: 100, sepia: 18 },
  },
  {
    id: "Noir",
    label: "Noir",
    params: { contrast: 36, blacks: -24, vignette: 40, grain: 20 },
    look: { grayscale: 100 },
  },
  {
    id: "Fade",
    label: "Fade",
    params: { contrast: -18, blacks: 26, saturation: -18, whites: -10 },
  },
  {
    id: "B&W",
    label: "B&W",
    scope: "video",
    params: { contrast: 24 },
    look: { grayscale: 100 },
  },
];
export const PRESET_IDS = PRESETS.map((item) => item.id);
export const presetFor = (id) =>
  PRESETS.find((item) => item.id === id) || PRESETS[0];
export const presetsFor = (kind) =>
  PRESETS.filter((item) => !item.scope || item.scope === kind);

/** Keys copied by Copy settings / Paste settings. Geometry and trims stay put. */
export const SETTINGS_KEYS = [...DEVELOP_KEYS, "preset", "presetStrength"];

export const pickSettings = (edit) =>
  Object.fromEntries(
    SETTINGS_KEYS.filter((key) => edit && key in edit).map((key) => [
      key,
      edit[key],
    ]),
  );

/** Manual sliders plus the chosen preset scaled by its strength. */
export function effectiveDevelop(edit) {
  const preset = presetFor(edit?.preset);
  const strength = clamp(finite(edit?.presetStrength, 100), 0, 100) / 100;
  const params = {};
  for (const item of DEVELOP_PARAMS) {
    const base = clamp(
      finite(edit?.[item.id], item.default),
      item.min,
      item.max,
    );
    const nudge = finite(preset.params?.[item.id]) * strength;
    params[item.id] = round(clamp(base + nudge, item.min, item.max), 3);
  }
  const look = {
    grayscale: round(finite(preset.look?.grayscale) * strength, 3),
    sepia: round(finite(preset.look?.sepia) * strength, 3),
  };
  return { params, look };
}

const GRAIN_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
);

/**
 * CSS approximation of the develop state: a filter() string, the numeric
 * factors behind it, and overlay layers for the effects filter() cannot do.
 */
export function cssFilterFor(edit) {
  const { params: p, look } = effectiveDevelop(edit);
  const brightness =
    2 ** p.exposure *
    (1 + (p.whites / 100) * 0.12) *
    (1 + (p.shadows / 100) * 0.06) *
    (1 + (p.highlights / 100) * 0.05) *
    (1 - (p.dehaze / 100) * 0.04);
  const contrast =
    (1 + (p.contrast / 100) * 0.5) *
    (1 + (p.clarity / 100) * 0.2) *
    (1 + (p.dehaze / 100) * 0.25) *
    (1 - (p.blacks / 100) * 0.12) *
    (1 - (p.shadows / 100) * 0.1) *
    (1 - (p.highlights / 100) * 0.06) *
    (1 + (p.sharpen / 100) * 0.08);
  const saturate =
    (1 + p.saturation / 100) *
    (1 + (p.vibrance / 100) * 0.5) *
    (1 + (p.dehaze / 100) * 0.08);
  const numeric = {
    brightness: round(Math.max(0, brightness)),
    contrast: round(Math.max(0, contrast)),
    saturate: round(Math.max(0, saturate)),
    grayscale: round(clamp(look.grayscale / 100, 0, 1)),
    sepia: round(clamp(look.sepia / 100, 0, 1)),
    blur: round((p.noiseReduction / 100) * 0.6),
  };
  const parts = [
    `brightness(${numeric.brightness})`,
    `contrast(${numeric.contrast})`,
    `saturate(${numeric.saturate})`,
  ];
  if (numeric.grayscale > 0) parts.push(`grayscale(${numeric.grayscale})`);
  if (numeric.sepia > 0) parts.push(`sepia(${numeric.sepia})`);
  if (numeric.blur > 0) parts.push(`blur(${numeric.blur}px)`);
  const layers = [];
  if (p.temperature !== 0)
    layers.push({
      id: "temperature",
      style: {
        background: p.temperature > 0 ? "#ff9a3c" : "#3c8bff",
        mixBlendMode: "overlay",
        opacity: round((Math.abs(p.temperature) / 100) * 0.4),
      },
    });
  if (p.tint !== 0)
    layers.push({
      id: "tint",
      style: {
        background: p.tint > 0 ? "#ff4fd8" : "#4fff7a",
        mixBlendMode: "overlay",
        opacity: round((Math.abs(p.tint) / 100) * 0.3),
      },
    });
  if (p.vignette !== 0) {
    const edge = p.vignette > 0 ? "0,0,0" : "255,255,255";
    const alpha = round((Math.abs(p.vignette) / 100) * 0.9);
    layers.push({
      id: "vignette",
      style: {
        background: `radial-gradient(ellipse at center, rgba(${edge},0) 42%, rgba(${edge},${alpha}) 100%)`,
      },
    });
  }
  if (p.grain > 0)
    layers.push({
      id: "grain",
      style: {
        backgroundImage: `url("data:image/svg+xml,${GRAIN_SVG}")`,
        backgroundSize: "180px 180px",
        mixBlendMode: "overlay",
        opacity: round((p.grain / 100) * 0.6),
      },
    });
  return { filter: parts.join(" "), numeric, layers, params: p, look };
}

/**
 * Applies the numeric filter factors (plus temperature/tint casts) to RGBA
 * bytes in place, so histograms match the preview in every browser.
 */
export function tonePixels(data, numeric, params = {}) {
  const {
    brightness = 1,
    contrast = 1,
    saturate = 1,
    grayscale = 0,
    sepia = 0,
  } = numeric || {};
  const warm = (finite(params.temperature) / 100) * 28;
  const tint = (finite(params.tint) / 100) * 22;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * brightness;
    let g = data[i + 1] * brightness;
    let b = data[i + 2] * brightness;
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturate;
    g = luma + (g - luma) * saturate;
    b = luma + (b - luma) * saturate;
    if (grayscale > 0) {
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r += (gray - r) * grayscale;
      g += (gray - g) * grayscale;
      b += (gray - b) * grayscale;
    }
    if (sepia > 0) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * sepia;
      g += (sg - g) * sepia;
      b += (sb - b) * sepia;
    }
    r += warm;
    b -= warm;
    r += tint * 0.6;
    g -= tint;
    b += tint * 0.6;
    data[i] = clamp(Math.round(r), 0, 255);
    data[i + 1] = clamp(Math.round(g), 0, 255);
    data[i + 2] = clamp(Math.round(b), 0, 255);
  }
  return data;
}

/** Per-channel and luminance histograms from an ImageData-like object. */
export function histogramBins(imageData, bins = 64) {
  const count = Math.max(1, Math.min(256, Math.floor(bins) || 64));
  const red = new Array(count).fill(0);
  const green = new Array(count).fill(0);
  const blue = new Array(count).fill(0);
  const luma = new Array(count).fill(0);
  const data = imageData?.data;
  const length = data?.length ?? 0;
  const pixels = Math.floor(length / 4);
  const stride = Math.max(1, Math.floor(pixels / 60000));
  let samples = 0;
  let max = 0;
  const scale = count / 256;
  for (let i = 0; i + 3 < length; i += 4 * stride) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    red[Math.min(count - 1, Math.floor(r * scale))] += 1;
    green[Math.min(count - 1, Math.floor(g * scale))] += 1;
    blue[Math.min(count - 1, Math.floor(b * scale))] += 1;
    const bin = Math.min(count - 1, Math.floor(l * scale));
    luma[bin] += 1;
    samples += 1;
  }
  for (let i = 0; i < count; i += 1)
    max = Math.max(max, red[i], green[i], blue[i], luma[i]);
  const clipped = samples
    ? {
        shadows: round(luma[0] / samples),
        highlights: round(luma[count - 1] / samples),
      }
    : { shadows: 0, highlights: 0 };
  return { bins: count, red, green, blue, luma, max, samples, clipped };
}

/* Crop geometry ---------------------------------------------------------- */

export const ASPECTS = [
  { id: "Free", label: "Free" },
  { id: "Original", label: "Original" },
  { id: "1:1", label: "Square" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "4:3", label: "4:3" },
  { id: "3:2", label: "3:2" },
  { id: "4:5", label: "4:5" },
];
export const ASPECT_IDS = ASPECTS.map((item) => item.id);

export const SOCIAL_PRESETS = [
  { id: "portrait", label: "Portrait 4:5", aspect: "4:5", note: "Feed" },
  { id: "shorts", label: "Shorts 9:16", aspect: "9:16", note: "Vertical" },
  { id: "wide", label: "Wide 16:9", aspect: "16:9", note: "Landscape" },
];

/** Display ratio (width / height) for an aspect id; null means free. */
export function aspectRatioValue(id, frameWidth, frameHeight) {
  if (id === "Original")
    return frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : null;
  const match = /^(\d+):(\d+)$/.exec(id || "");
  if (!match) return null;
  return Number(match[1]) / Number(match[2]);
}

const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_CROP = 0.05;

export function normalizeRect(candidate) {
  const value = candidate && typeof candidate === "object" ? candidate : {};
  const w = round(clamp(finite(value.w, 1), MIN_CROP, 1), 4);
  const h = round(clamp(finite(value.h, 1), MIN_CROP, 1), 4);
  const x = round(clamp(finite(value.x, 0), 0, 1 - w), 4);
  const y = round(clamp(finite(value.y, 0), 0, 1 - h), 4);
  return { x, y, w, h };
}

export const isFullRect = (rect) =>
  !rect || (rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1);

/** Largest centred normalized rect with the given display ratio. */
export function fitCropRect(ratio, frameWidth, frameHeight) {
  if (!ratio || !(frameWidth > 0) || !(frameHeight > 0))
    return { ...FULL_RECT };
  let h = 1;
  let w = (ratio * frameHeight) / frameWidth;
  if (w > 1) {
    w = 1;
    h = frameWidth / (ratio * frameHeight);
  }
  return normalizeRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

/**
 * Resizes a normalized crop rect by dragging one of eight handles
 * ("n","s","e","w","ne","nw","se","sw") or moving it ("move"). dx/dy are
 * normalized deltas. When a ratio is given the rect keeps that display ratio.
 */
export function resizeCropRect(rect, handle, dx, dy, options = {}) {
  const { ratio = null, frameWidth = 1, frameHeight = 1 } = options;
  const current = normalizeRect(rect);
  if (handle === "move")
    return normalizeRect({
      ...current,
      x: clamp(current.x + dx, 0, 1 - current.w),
      y: clamp(current.y + dy, 0, 1 - current.h),
    });
  let left = current.x;
  let top = current.y;
  let right = current.x + current.w;
  let bottom = current.y + current.h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  if (ratio) {
    // normalized width per normalized height for this display ratio
    const k = (ratio * frameHeight) / frameWidth;
    let w = right - left;
    let h = bottom - top;
    const horizontalOnly = handle === "e" || handle === "w";
    const verticalOnly = handle === "n" || handle === "s";
    if (horizontalOnly) h = w / k;
    else if (verticalOnly) w = h * k;
    else if (w / k > h) w = h * k;
    else h = w / k;
    if (handle.includes("w")) left = right - w;
    else right = left + w;
    if (handle.includes("n")) top = bottom - h;
    else bottom = top + h;
    if (verticalOnly) {
      const centre = (current.x + current.x + current.w) / 2;
      left = centre - w / 2;
      right = centre + w / 2;
    }
    if (horizontalOnly) {
      const centre = (current.y + current.y + current.h) / 2;
      top = centre - h / 2;
      bottom = centre + h / 2;
    }
    // keep the rect inside the frame without breaking the ratio
    if (left < 0) {
      right -= left;
      left = 0;
    }
    if (top < 0) {
      bottom -= top;
      top = 0;
    }
    if (right > 1) {
      const overflow = right - 1;
      right = 1;
      left = Math.max(0, left - overflow);
      w = right - left;
      h = w / k;
      if (handle.includes("n")) top = bottom - h;
      else bottom = top + h;
    }
    if (bottom > 1) {
      const overflow = bottom - 1;
      bottom = 1;
      top = Math.max(0, top - overflow);
      h = bottom - top;
      w = h * k;
      if (handle.includes("w")) left = right - w;
      else right = left + w;
    }
    if (right - left < MIN_CROP || bottom - top < MIN_CROP) return current;
  }
  return normalizeRect({
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  });
}

/** Scale that keeps a straightened image covering its own frame. */
export function straightenScale(width, height, degrees) {
  if (!(width > 0) || !(height > 0)) return 1;
  const theta = (Math.abs(finite(degrees)) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return round(
    Math.max(
      (width * cos + height * sin) / width,
      (width * sin + height * cos) / height,
    ),
    4,
  );
}

/** Text overlay anchors, a 3 × 3 grid. */
export const TEXT_POSITIONS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
];

export const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Evenly spaced sample times inside a clip, used for filmstrips. */
export function filmstripTimes(duration, count = 12) {
  const frames = Math.max(1, Math.floor(count));
  if (!(duration > 0)) return new Array(frames).fill(0);
  return Array.from({ length: frames }, (_, i) =>
    round(((i + 0.5) / frames) * duration, 3),
  );
}

/** Playback rate at a clip time, honouring segment overrides. */
export function speedAt(edit, time) {
  const segment = (edit?.speedSegments || []).find(
    (item) => time >= item.start && time < item.end,
  );
  return segment ? segment.speed : finite(edit?.speed, 1) || 1;
}

/** Output duration after whole-clip speed and segment overrides. */
export function renderedDuration(edit) {
  const start = finite(edit?.start);
  const end = finite(edit?.end);
  if (end <= start) return 0;
  const base = finite(edit?.speed, 1) || 1;
  let total = 0;
  let cursor = start;
  const segments = [...(edit?.speedSegments || [])]
    .filter((item) => item.end > start && item.start < end)
    .sort((a, b) => a.start - b.start);
  for (const segment of segments) {
    const from = Math.max(cursor, segment.start);
    const to = Math.min(end, segment.end);
    if (from > cursor) total += (from - cursor) / base;
    if (to > from) total += (to - from) / segment.speed;
    cursor = Math.max(cursor, to);
  }
  if (end > cursor) total += (end - cursor) / base;
  return round(total, 3);
}

/**
 * Hold-to-compare keys for the photo editor. Backslash is the primary key:
 * Apple Photos uses M, but M already means "Group by month" in the library
 * shortcuts, and backslash is Lightroom's before/after key. Y stays as the
 * earlier binding. A press with a command modifier is never a compare, but a
 * release always is, so a held original can't get stuck.
 */
export function isCompareKey(event, { release = false } = {}) {
  if (!event) return false;
  if (!release && (event.metaKey || event.ctrlKey || event.altKey))
    return false;
  return (
    event.key === "\\" ||
    event.code === "Backslash" ||
    String(event.key || "").toLowerCase() === "y"
  );
}
