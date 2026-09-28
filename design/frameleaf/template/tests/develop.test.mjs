import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASPECTS,
  AUTO_TONE,
  DEVELOP_GROUPS,
  DEVELOP_KEYS,
  DEVELOP_PARAMS,
  PRESETS,
  SETTINGS_KEYS,
  SOCIAL_PRESETS,
  TEXT_POSITIONS,
  aspectRatioValue,
  autoToneApplied,
  clampParam,
  cssFilterFor,
  developDefaults,
  effectiveDevelop,
  filmstripTimes,
  fitCropRect,
  groupIsDefault,
  groupReset,
  histogramBins,
  normalizeRect,
  pickSettings,
  presetsFor,
  renderedDuration,
  resizeCropRect,
  speedAt,
  straightenScale,
  tonePixels,
} from "../src/develop.mjs";
import { initialEdit, normalizeEdit, parseSavedPrototype } from "../src/state.mjs";

const photo = { id: "p", name: "Photo.jpg", type: "photo", duration: 0 };
const video = { id: "v", name: "Clip.mov", type: "video", duration: 18 };

test("develop schema is complete, grouped and internally consistent", () => {
  const groups = new Set(DEVELOP_GROUPS.map((group) => group.id));
  assert.deepEqual([...groups], ["light", "color", "effects", "detail"]);
  const ids = DEVELOP_PARAMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
    "vibrance",
    "saturation",
    "clarity",
    "dehaze",
    "vignette",
    "grain",
    "sharpen",
    "noiseReduction",
  ]);
  for (const item of DEVELOP_PARAMS) {
    assert.ok(groups.has(item.group), `${item.id} has a known group`);
    assert.ok(item.label.trim().length > 0);
    assert.ok(item.min < item.max);
    assert.ok(item.default >= item.min && item.default <= item.max);
    assert.ok(item.step > 0);
    assert.equal(typeof item.unit, "string");
  }
  assert.deepEqual(Object.keys(developDefaults()), DEVELOP_KEYS);
  assert.deepEqual(SETTINGS_KEYS.slice(-2), ["preset", "presetStrength"]);
  for (const group of DEVELOP_GROUPS) {
    assert.ok(groupIsDefault(developDefaults(), group.id));
    assert.ok(Object.keys(groupReset(group.id)).length >= 2);
  }
  assert.ok(Object.keys(AUTO_TONE).every((key) => DEVELOP_KEYS.includes(key)));
  assert.equal(autoToneApplied({ ...developDefaults(), ...AUTO_TONE }), true);
  assert.equal(autoToneApplied(developDefaults()), false);
});

test("clampParam snaps to the schema range and step, and rejects junk", () => {
  assert.equal(clampParam("exposure", 9), 2);
  assert.equal(clampParam("exposure", -9), -2);
  assert.equal(clampParam("exposure", 0.33), 0.35);
  assert.equal(clampParam("contrast", 250), 100);
  assert.equal(clampParam("grain", -40), 0);
  assert.equal(clampParam("contrast", "12"), 0);
  assert.equal(clampParam("contrast", NaN), 0);
  assert.equal(clampParam("unknown", 5), 0);
});

test("presets scale with strength and clamp into the schema range", () => {
  const base = { ...developDefaults(), preset: "Vivid", presetStrength: 50 };
  const half = effectiveDevelop(base).params;
  assert.equal(half.vibrance, 15);
  assert.equal(half.contrast, 9);
  const full = effectiveDevelop({ ...base, presetStrength: 100 }).params;
  assert.equal(full.vibrance, 30);
  const capped = effectiveDevelop({
    ...base,
    contrast: 95,
    presetStrength: 100,
  }).params;
  assert.equal(capped.contrast, 100);
  assert.equal(effectiveDevelop({ preset: "Mono" }).look.grayscale, 100);
  assert.equal(
    effectiveDevelop({ preset: "Silvertone", presetStrength: 50 }).look.sepia,
    9,
  );
  assert.equal(effectiveDevelop({ preset: "Nope" }).look.grayscale, 0);
  const required = [
    "Original",
    "Vivid",
    "Natural",
    "Warm",
    "Cool",
    "Mono",
    "Silvertone",
    "Noir",
    "Fade",
    "B&W",
  ];
  assert.deepEqual(
    PRESETS.map((item) => item.id),
    required,
  );
  assert.ok(!presetsFor("photo").some((item) => item.id === "B&W"));
  assert.ok(presetsFor("video").some((item) => item.id === "B&W"));
  assert.deepEqual(
    SOCIAL_PRESETS.map((item) => item.aspect),
    ["4:5", "9:16", "16:9"],
  );
});

test("cssFilterFor maps the develop parameters to filter() and overlay layers", () => {
  const neutral = cssFilterFor(developDefaults());
  assert.equal(neutral.filter, "brightness(1) contrast(1) saturate(1)");
  assert.deepEqual(neutral.layers, []);
  const bright = cssFilterFor({ ...developDefaults(), exposure: 1 });
  assert.equal(bright.numeric.brightness, 2);
  assert.match(bright.filter, /^brightness\(2\)/);
  const punchy = cssFilterFor({
    ...developDefaults(),
    contrast: 100,
    saturation: -100,
    noiseReduction: 50,
  });
  assert.equal(punchy.numeric.contrast, 1.5);
  assert.equal(punchy.numeric.saturate, 0);
  assert.match(punchy.filter, /blur\(0\.3px\)/);
  const looked = cssFilterFor({
    ...developDefaults(),
    preset: "Silvertone",
    presetStrength: 100,
    temperature: 50,
    tint: -40,
    vignette: 60,
    grain: 30,
  });
  assert.match(looked.filter, /grayscale\(1\)/);
  assert.match(looked.filter, /sepia\(0\.18\)/);
  const ids = looked.layers.map((layer) => layer.id);
  assert.deepEqual(ids, ["temperature", "tint", "vignette", "grain"]);
  const temperature = looked.layers[0].style;
  assert.equal(temperature.background, "#ff9a3c");
  assert.equal(temperature.opacity, 0.2);
  assert.equal(looked.layers[1].style.background, "#4fff7a");
  assert.match(looked.layers[2].style.background, /radial-gradient/);
  assert.match(looked.layers[3].style.backgroundImage, /feTurbulence/);
  assert.equal(looked.layers[3].style.opacity, 0.18);
  const inverse = cssFilterFor({ ...developDefaults(), vignette: -50 });
  assert.match(inverse.layers[0].style.background, /255,255,255/);
  const garbage = cssFilterFor(null);
  assert.equal(garbage.filter, neutral.filter);
});

const synthetic = (pixels) => {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a = 255], i) => {
    data.set([r, g, b, a], i * 4);
  });
  return { data, width: pixels.length, height: 1 };
};

test("histogramBins counts channel and luminance values into 64 bins by default", () => {
  const image = synthetic([
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [128, 128, 128],
    [10, 10, 10, 0],
  ]);
  const bins = histogramBins(image);
  assert.equal(bins.bins, 64);
  assert.equal(bins.samples, 4);
  assert.equal(bins.luma[0], 1);
  assert.equal(bins.luma[63], 1);
  assert.equal(bins.luma[32], 1);
  assert.equal(bins.red[63], 2);
  assert.equal(bins.green[0], 2);
  assert.equal(bins.blue[0], 2);
  assert.equal(bins.max, 2);
  assert.equal(bins.clipped.shadows, 0.25);
  assert.equal(bins.clipped.highlights, 0.25);
  const sixteen = histogramBins(image, 16);
  assert.equal(sixteen.bins, 16);
  assert.equal(sixteen.luma.length, 16);
  assert.equal(sixteen.luma[8], 1);
  const empty = histogramBins(null);
  assert.equal(empty.samples, 0);
  assert.equal(empty.max, 0);
  assert.deepEqual(empty.clipped, { shadows: 0, highlights: 0 });
  assert.equal(histogramBins({ data: new Uint8ClampedArray(0) }, 0).bins, 64);
});

test("histogramBins subsamples very large images without dropping the extremes", () => {
  const width = 400;
  const height = 400;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 200, 200, 255], i);
  const bins = histogramBins({ data, width, height });
  assert.ok(bins.samples > 40000 && bins.samples <= width * height);
  assert.equal(bins.luma[Math.floor((200 / 256) * 64)], bins.samples);
});

test("tonePixels tracks the preview factors so histograms move with sliders", () => {
  const image = synthetic([[100, 100, 100]]);
  tonePixels(image.data, { brightness: 2 });
  assert.deepEqual([...image.data.slice(0, 3)], [200, 200, 200]);
  const contrasty = synthetic([[100, 100, 100]]);
  tonePixels(contrasty.data, { contrast: 2 });
  assert.deepEqual([...contrasty.data.slice(0, 3)], [72, 72, 72]);
  const gray = synthetic([[255, 0, 0]]);
  tonePixels(gray.data, { grayscale: 1 });
  assert.equal(gray.data[0], gray.data[1]);
  assert.equal(gray.data[1], gray.data[2]);
  const warm = synthetic([[100, 100, 100]]);
  tonePixels(warm.data, {}, { temperature: 100 });
  assert.ok(warm.data[0] > warm.data[2]);
  const clipped = synthetic([[250, 250, 250]]);
  tonePixels(clipped.data, { brightness: 4 });
  assert.equal(clipped.data[0], 255);
});

test("crop geometry: rects stay normalized and aspect fits are centred", () => {
  assert.deepEqual(normalizeRect(null), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(normalizeRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), {
    x: 0.5,
    y: 0.5,
    w: 0.5,
    h: 0.5,
  });
  assert.deepEqual(normalizeRect({ x: -1, y: 2, w: 0, h: 9 }), {
    x: 0,
    y: 0,
    w: 0.05,
    h: 1,
  });
  assert.equal(aspectRatioValue("Free"), null);
  assert.equal(aspectRatioValue("16:9"), 16 / 9);
  assert.equal(aspectRatioValue("Original", 1200, 800), 1.5);
  assert.deepEqual(fitCropRect(1, 1200, 800), { x: 0.1667, y: 0, w: 0.6667, h: 1 });
  const wide = fitCropRect(16 / 9, 1000, 1000);
  assert.equal(wide.x, 0);
  assert.equal(wide.w, 1);
  assert.equal(wide.h, 0.5625);
  assert.ok(Math.abs(wide.y - 0.21875) < 0.001);
  assert.deepEqual(fitCropRect(null, 10, 10), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(
    ASPECTS.map((item) => item.id),
    ["Free", "Original", "1:1", "16:9", "9:16", "4:3", "3:2", "4:5"],
  );
});

test("crop geometry: handles resize freely, keep ratios when locked, and moves stay inside", () => {
  const start = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const east = resizeCropRect(start, "e", 0.1, 0, {});
  assert.deepEqual(east, { x: 0.2, y: 0.2, w: 0.7, h: 0.6 });
  const north = resizeCropRect(start, "n", 0, -0.5, {});
  assert.deepEqual(north, { x: 0.2, y: 0, w: 0.6, h: 0.8 });
  const tiny = resizeCropRect(start, "se", -1, -1, {});
  assert.equal(tiny.w, 0.05);
  assert.equal(tiny.h, 0.05);
  const moved = resizeCropRect(start, "move", 0.5, -0.5, {});
  assert.deepEqual(moved, { x: 0.4, y: 0, w: 0.6, h: 0.6 });
  const square = { ratio: 1, frameWidth: 1000, frameHeight: 1000 };
  const locked = resizeCropRect(start, "se", 0.1, 0.3, square);
  assert.equal(locked.w, locked.h);
  assert.ok(locked.w > 0.6);
  const edge = resizeCropRect(start, "e", 0.15, 0, square);
  assert.equal(edge.w, edge.h);
  assert.ok(edge.x + edge.w <= 1 && edge.y + edge.h <= 1);
  const wide = { ratio: 2, frameWidth: 1000, frameHeight: 500 };
  const kept = resizeCropRect({ x: 0, y: 0, w: 0.5, h: 0.5 }, "se", 0.2, 0.2, wide);
  assert.equal(kept.w, kept.h);
  assert.equal(straightenScale(1600, 900, 0), 1);
  assert.ok(straightenScale(1600, 900, 10) > 1.2);
  assert.equal(straightenScale(0, 0, 45), 1);
});

test("video helpers: filmstrip timing, speed lookups and rendered duration", () => {
  assert.deepEqual(filmstripTimes(12, 4), [1.5, 4.5, 7.5, 10.5]);
  assert.deepEqual(filmstripTimes(0, 3), [0, 0, 0]);
  const edit = {
    start: 2,
    end: 12,
    speed: 2,
    speedSegments: [{ start: 4, end: 6, speed: 0.5 }],
  };
  assert.equal(speedAt(edit, 5), 0.5);
  assert.equal(speedAt(edit, 8), 2);
  assert.equal(speedAt({}, 1), 1);
  assert.equal(renderedDuration(edit), 1 + 4 + 3);
  assert.equal(renderedDuration({ start: 5, end: 5 }), 0);
  assert.equal(renderedDuration({ start: 0, end: 10, speed: 4 }), 2.5);
  assert.equal(TEXT_POSITIONS.length, 9);
});

test("pickSettings copies only develop values and the preset", () => {
  const edit = normalizeEdit(
    { exposure: 0.5, preset: "Warm", presetStrength: 40, start: 3, crop: "1:1" },
    video,
  );
  const settings = pickSettings(edit);
  assert.equal(settings.exposure, 0.5);
  assert.equal(settings.preset, "Warm");
  assert.equal(settings.presetStrength, 40);
  assert.equal("start" in settings, false);
  assert.equal("crop" in settings, false);
});

test("edit model clamps every new field and photos get no timeline", () => {
  const edit = normalizeEdit(
    {
      version: 2,
      exposure: 7,
      contrast: -400,
      grain: -5,
      temperature: "warm",
      crop: "Square",
      cropRect: { x: 0.8, y: -1, w: 0.6, h: 3 },
      straighten: 90,
      flipH: "yes",
      flipV: true,
      preset: "Sepia",
      presetStrength: 900,
      speed: 3,
      speedSegments: [{ start: 1, end: 5, speed: 2 }],
      textOverlays: [
        {
          id: 7,
          text: "x".repeat(400),
          position: "somewhere",
          start: -2,
          end: 99,
          fontSize: 4,
          color: "red",
          shadow: false,
        },
        "junk",
      ],
      stabilize: 1,
      autoEnhance: true,
      start: 4,
      end: 9,
    },
    photo,
  );
  assert.equal(edit.version, 2);
  assert.equal(edit.exposure, 2);
  assert.equal(edit.contrast, -100);
  assert.equal(edit.grain, 0);
  assert.equal(edit.temperature, 0);
  assert.equal(edit.crop, "Original");
  assert.deepEqual(edit.cropRect, { x: 0.4, y: 0, w: 0.6, h: 1 });
  assert.equal(edit.straighten, 45);
  assert.equal(edit.flipH, false);
  assert.equal(edit.flipV, true);
  assert.equal(edit.preset, "Original");
  assert.equal(edit.presetStrength, 100);
  assert.equal(edit.speed, 1);
  assert.deepEqual(edit.speedSegments, []);
  assert.equal(edit.textOverlays.length, 1);
  assert.equal(edit.textOverlays[0].id, "7");
  assert.equal(edit.textOverlays[0].text.length, 200);
  assert.equal(edit.textOverlays[0].position, "bottom");
  assert.equal(edit.textOverlays[0].start, 0);
  assert.equal(edit.textOverlays[0].end, 0);
  assert.equal(edit.textOverlays[0].fontSize, 12);
  assert.equal(edit.textOverlays[0].color, "#ffffff");
  assert.equal(edit.textOverlays[0].shadow, false);
  assert.equal(edit.stabilize, false);
  assert.equal(edit.autoEnhance, true);
  assert.equal(edit.start, 0);
  assert.equal(edit.end, 0);
});

test("video edits keep segments and overlays inside the trimmed clip", () => {
  const edit = normalizeEdit(
    {
      start: 2,
      end: 40,
      speed: 0.5,
      speedSegments: [
        { start: 10, end: 4, speed: 2 },
        { start: 12, end: 16, speed: 99 },
        { start: 3, end: 5, speed: 4 },
        null,
      ],
      textOverlays: [{ text: "Hello", position: "top-right", start: 5, end: 3, color: "#FF00AA" }],
    },
    video,
  );
  assert.equal(edit.end, 18);
  assert.equal(edit.speed, 0.5);
  assert.deepEqual(edit.speedSegments, [
    { start: 3, end: 5, speed: 4 },
    { start: 12, end: 16, speed: 2 },
  ]);
  assert.equal(edit.textOverlays[0].end, 5);
  assert.equal(edit.textOverlays[0].color, "#ff00aa");
  assert.equal(edit.textOverlays[0].position, "top-right");
});

test("version 1 drafts migrate percentage saturation and stay stable afterwards", () => {
  const migrated = normalizeEdit({ saturation: 150, exposure: 1 }, video);
  assert.equal(migrated.saturation, 50);
  assert.equal(migrated.exposure, 1);
  const again = normalizeEdit(migrated, video);
  assert.deepEqual(again, migrated);
  assert.equal(normalizeEdit({ saturation: 100 }, video).saturation, 0);
  assert.equal(normalizeEdit({ version: 2, saturation: 100 }, video).saturation, 100);
  assert.equal(normalizeEdit(initialEdit, photo).saturation, 0);
});

test("the extended model round-trips through parseSavedPrototype", () => {
  const readView = () => null;
  const assets = [photo, video];
  const edit = normalizeEdit(
    {
      ...initialEdit,
      exposure: 0.4,
      clarity: 22,
      preset: "Noir",
      presetStrength: 70,
      crop: "16:9",
      cropRect: { x: 0.1, y: 0.1, w: 0.8, h: 0.45 },
      straighten: -3.5,
      flipH: true,
      speed: 2,
      speedSegments: [{ start: 1, end: 2, speed: 0.25 }],
      textOverlays: [{ id: "a", text: "Lake", position: "center", start: 0, end: 4 }],
      stabilize: true,
      autoEnhance: true,
    },
    video,
  );
  const saved = parseSavedPrototype(
    JSON.stringify({
      openAssetId: "v",
      drafts: { v: { edit, undo: [edit], redo: [] } },
      versions: [{ id: 1, name: "Look", assetId: "v", edit }],
      jobs: [{ id: 1, snapshot: { assetId: "v", edit } }],
    }),
    assets,
    readView,
  );
  assert.deepEqual(saved.drafts.v.edit, edit);
  assert.deepEqual(saved.drafts.v.undo[0], edit);
  assert.deepEqual(saved.versions[0].edit, edit);
  assert.deepEqual(saved.jobs[0].snapshot.edit, edit);
  assert.equal(saved.drafts.p.edit.end, 0);
  assert.equal(saved.playbackPosition, 0);
});
