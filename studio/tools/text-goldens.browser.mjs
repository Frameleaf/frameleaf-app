// Drives the real engine's text layout, 2-D text renderer, animated-style resolver and text-motion
// evaluator over the cases of text-goldens.mjs and writes studio/spec/goldens/text.json, the numeric
// half of studio/spec/text.md. Needs the prepared engine served by Vite:
//   npm --prefix studio/engine run dev -- --host 127.0.0.1 --port 5186 --strictPort
//   GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
//     node studio/tools/text-goldens.browser.mjs --write
// Without --write it is a drift gate: synthetic-measurer cases must equal the committed values,
// platform cases are re-captured on this machine and must equal the prose reference fed with the
// re-captured measurements (as the ASCII atlas is), and image cases must meet their tolerances.
// In both modes the prose reference of text-goldens.mjs must reproduce every numeric engine value.
// The platform cases load the bundled title fonts (server/src/utils/studio-fonts.generated.ts) from the
// installed @fontsource packages, never from the network or the system; the goldens record each file
// and its sha256. TEXT_GOLDENS_FONT_DIR names the directory holding `@fontsource` if it is elsewhere.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeBuffer, decodeBuffer, sha256, deriveTolerance, compareCase } from './render-goldens.mjs';
import {
  TEXT_GOLDENS_FORMAT, TEXT_GOLDENS_VERSION, SINE_TOLERANCE, SINE_PRESETS, IMAGE_SIZE, ANIMATED_STYLE_FIELDS,
  syntheticMeasurer, recordedMeasurer, plain, validateTextGoldens, bundledTitleFonts, bundledFontRecords,
  layoutCases, autoHeightCases, paintCases, styleScaleCases, motionCases, slotCases, unitCases, imageCases,
  referenceLayout, referenceAutoHeight, referencePaint, referenceAnimatedStyle, referenceMotionState, referenceCoarseSlot, referenceUnits,
} from './text-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(studio, '..');
const goldensPath = path.join(studio, 'spec/goldens/text.json');

const SOURCE_ROOTS = [
  'src/shared/typography', 'src/features/export/utils/canvas-item-renderer/text.ts', 'src/features/keyframes/utils/animated-text-item.ts',
  'src/runtime/composition-runtime/utils/text-layout.ts', 'src/shared/utils/text-item-spans.ts',
];
async function sourceDigest() {
  const files = [];
  const walk = async (rel) => {
    if (rel.endsWith('.ts')) { files.push(rel); return; }
    for (const entry of await readdir(path.join(studio, 'engine', rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(child);
    }
  };
  for (const root of SOURCE_ROOTS) await walk(root);
  files.sort();
  const parts = [];
  for (const file of files) parts.push(`${file}\0${sha256(await readFile(path.join(studio, 'engine', file)))}`);
  return { files: files.length, sha256: sha256(parts.join('\n')) };
}

const SUBSET_RANGES = {
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
};
/**
 * The bundled title fonts (server/src/utils/studio-fonts.generated.ts), read from the installed
 * @fontsource packages and checked against the recorded hashes. TEXT_GOLDENS_FONT_DIR names the
 * directory that holds `@fontsource` when it is not server/node_modules.
 */
async function loadFontFiles() {
  const root = path.resolve(process.env.TEXT_GOLDENS_FONT_DIR || path.join(repository, 'server/node_modules'));
  const fonts = [];
  for (const record of bundledFontRecords(await bundledTitleFonts(repository))) {
    const bytes = await readFile(path.join(root, record.file));
    assert.equal(sha256(bytes), record.sha256, `${record.file} is not the bundled file`);
    fonts.push({ ...record, base64: bytes.toString('base64') });
  }
  assert(fonts.length > 0, 'no bundled title fonts are listed');
  return fonts;
}

const PAGE = `<title>Text goldens</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`;

async function collect(origin, args, fonts, lists) {
  const require = createRequire(path.join(studio, 'engine/package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('page error:', error.message));
    await page.route(`${origin}/text-goldens`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${origin}/text-goldens`);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    return await page.evaluate(async ({ lists, fonts, ranges, measurerSource, size, styleFields }) => {
      const { layoutTextBlock } = await import('/src/shared/typography/text-block-layout.ts');
      const { createCanvasTextMeasurer } = await import('/src/shared/typography/text-measurer.ts');
      const { evaluateGlyphMotion, getActiveTextMotionSlot, isTextMotionActive, segmentTextUnits } = await import('/src/shared/typography/text-motion/index.ts');
      const { renderTextItem } = await import('/src/features/export/utils/canvas-item-renderer/text.ts');
      const { TextMeasurementCache } = await import('/src/features/export/utils/canvas-pool.ts');
      const { expandTextTransformToFitContent } = await import('/src/runtime/composition-runtime/utils/text-layout.ts');
      const { resolveAnimatedTextItem } = await import('/src/features/keyframes/utils/animated-text-item.ts');
      const synthetic = (0, eval)(`(${measurerSource})`)();

      // The title fonts of the platform cases come from the named files, never from the network.
      // Latin then Latin Extended is a fallback chain per family, weight and style: a later-added face
      // has priority where ranges overlap, so the Latin Extended faces are added first.
      for (const font of [...fonts.filter((f) => f.subset !== 'latin'), ...fonts.filter((f) => f.subset === 'latin')]) {
        const bytes = Uint8Array.from(atob(font.base64), (c) => c.charCodeAt(0));
        const face = new FontFace(font.family, bytes.buffer, { weight: String(font.weight), style: font.style, unicodeRange: ranges[font.subset] });
        document.fonts.add(await face.load());
      }
      for (const font of fonts) await document.fonts.load(`${font.style} ${font.weight} 32px "${font.family}"`, 'Hg');
      const environment = { userAgent: navigator.userAgent, fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').length };

      const textItem = (item) => ({ id: 'title', type: 'text', trackId: 'track', from: 0, durationInFrames: 90, label: 'Title', ...item });
      const lineOf = (line) => ({
        text: line.text, font: line.cssFont, fontSize: line.fontSize, color: line.color, letterSpacing: line.letterSpacing, underline: line.underline,
        width: line.width, lineHeight: line.lineHeightPx, top: line.top, baseline: line.baselineY, start: line.startX,
        ...(line.runs ? { runs: line.runs.map((run) => ({ text: run.text, color: run.color, underline: run.underline, offset: run.offsetX, width: run.width })) } : {}),
      });
      const layoutOf = (layout) => ({ lines: layout.lines.map(lineOf), totalHeight: layout.totalHeight, ...(layout.background ? { background: layout.background } : {}) });

      // A measurer that records everything the platform answered: the input of the platform cases.
      const recording = () => {
        const real = createCanvasTextMeasurer(new OffscreenCanvas(1, 1).getContext('2d'));
        const widths = new Map();
        const metrics = new Map();
        return {
          measurer: {
            measure(text, font, spacing) {
              const width = real.measure(text, font, spacing);
              widths.set(`${font}\n${spacing}\n${text}`, [font, spacing, text, width]);
              return width;
            },
            fontMetrics(font) {
              const found = real.fontMetrics(font);
              metrics.set(font, [font, found.ascent, found.descent]);
              return found;
            },
          },
          taken: () => ({ widths: [...widths.values()], metrics: [...metrics.values()] }),
        };
      };

      const layout = lists.layout.map((c) => {
        if (c.measurer === 'synthetic') return { expected: layoutOf(layoutTextBlock(textItem(c.item), c.box.width, c.box.height, synthetic)) };
        const record = recording();
        const expected = layoutOf(layoutTextBlock(textItem(c.item), c.box.width, c.box.height, record.measurer));
        return { expected, platformMeasurements: record.taken() };
      });

      const autoHeight = lists.autoHeight.map((c) => {
        const record = recording();
        layoutTextBlock(textItem(c.item), c.box.width, 0, record.measurer);
        const grown = expandTextTransformToFitContent(textItem(c.item),
          { x: 0, y: 0, width: c.box.width, height: c.box.height, rotation: 0, opacity: 1, anchorX: c.box.width / 2, anchorY: c.box.height / 2, cornerRadius: 0 });
        return { expected: { height: grown.height }, platformMeasurements: record.taken() };
      });

      // A recording 2-D surface: it keeps the drawing state and writes down every draw, measuring
      // with the synthetic measurer. It rasterises nothing.
      const recorder = () => {
        const ops = [];
        const saved = [];
        let path = [];
        let state = {
          globalAlpha: 1, filter: 'none', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineJoin: 'miter', font: '10px sans-serif',
          letterSpacing: '0px', fontKerning: 'auto', textBaseline: 'alphabetic', textAlign: 'start',
          shadowColor: null, shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, transforms: [],
        };
        const drawn = () => {
          const t = state.transforms;
          let motion = null;
          if (t.length > 0) {
            const middle = t.slice(2, -1);
            const last = t.at(-1);
            if (t.length < 3 || t[0][0] !== 'translate' || t[1][0] !== 'translate' || last[0] !== 'translate' || last[1] !== -t[1][1] || last[2] !== -t[1][2]
              || middle.some((call) => call[0] === 'translate') || middle.length > 2) throw new Error(`unexpected transform ${JSON.stringify(t)}`);
            const rotate = middle.find((call) => call[0] === 'rotate');
            const scale = middle.find((call) => call[0] === 'scale');
            if (scale && scale[1] !== scale[2]) throw new Error('non-uniform scale');
            if (rotate && scale && middle[0] !== rotate) throw new Error('scale before rotate');
            motion = { dx: t[0][1], dy: t[0][2], pivotX: t[1][1], pivotY: t[1][2], rotation: rotate ? rotate[1] : 0, scale: scale ? scale[1] : 1 };
          }
          const blur = state.filter === 'none' ? 0 : Number(/^blur\((.+)px\)$/.exec(state.filter)[1]);
          const shadow = state.shadowColor === null ? null : { color: state.shadowColor, blur: state.shadowBlur, offsetX: state.shadowOffsetX, offsetY: state.shadowOffsetY };
          return { shadow, alpha: state.globalAlpha, blur, motion };
        };
        const text = (op, string, x, y, extra) => {
          if (state.textBaseline !== 'alphabetic' || state.textAlign !== 'left') throw new Error('text must be drawn left-aligned on the alphabetic baseline');
          ops.push({ op, text: string, x, y, font: state.font, letterSpacing: parseFloat(state.letterSpacing), ...extra, ...drawn() });
        };
        const methods = {
          save() { saved.push({ ...state, transforms: [...state.transforms] }); },
          restore() { state = saved.pop(); },
          beginPath() { path = []; },
          rect(x, y, width, height) { path.push(['rect', x, y, width, height]); },
          roundRect(x, y, width, height, radius) { path.push(['roundRect', x, y, width, height, radius]); },
          moveTo(x, y) { path.push(['moveTo', x, y]); },
          lineTo(x, y) { path.push(['lineTo', x, y]); },
          clip() {
            if (path.length !== 1 || path[0][0] !== 'rect') throw new Error('unexpected clip path');
            ops.push({ op: 'clip', x: path[0][1], y: path[0][2], width: path[0][3], height: path[0][4] });
          },
          fill() {
            if (path.length !== 1 || path[0][0] !== 'roundRect') throw new Error('unexpected fill path');
            const [, x, y, width, height, radius] = path[0];
            ops.push({ op: 'background', x, y, width, height, radius, color: state.fillStyle, shadow: drawn().shadow });
          },
          fillRect(x, y, width, height) { ops.push({ op: 'background', x, y, width, height, radius: 0, color: state.fillStyle, shadow: drawn().shadow }); },
          stroke() {
            if (path.length !== 2 || path[0][0] !== 'moveTo' || path[1][0] !== 'lineTo' || path[0][2] !== path[1][2]) throw new Error('unexpected stroke path');
            ops.push({ op: 'underline', x1: path[0][1], x2: path[1][1], y: path[0][2], thickness: state.lineWidth, color: state.strokeStyle, ...drawn() });
          },
          fillText(string, x, y) { text('fill', string, x, y, { color: state.fillStyle }); },
          strokeText(string, x, y) { text('stroke', string, x, y, { color: state.strokeStyle, lineWidth: state.lineWidth, join: state.lineJoin }); },
          translate(x, y) { state.transforms.push(['translate', x, y]); },
          rotate(angle) { state.transforms.push(['rotate', angle]); },
          scale(x, y) { state.transforms.push(['scale', x, y]); },
          measureText(string) {
            const found = synthetic.fontMetrics(state.font);
            return { width: synthetic.measure(string, state.font, parseFloat(state.letterSpacing)), fontBoundingBoxAscent: found.ascent, fontBoundingBoxDescent: found.descent };
          },
        };
        const surface = new Proxy({}, {
          get: (_, key) => (Object.hasOwn(methods, key) ? methods[key] : state[key]),
          set: (_, key, value) => { state[key] = value; return true; },
          has: (_, key) => Object.hasOwn(methods, key) || Object.hasOwn(state, key),
        });
        return { surface, ops };
      };
      const motionFor = (item, frame) => (item.textMotion && isTextMotionActive(item.textMotion, frame, 30, item.durationInFrames)
        ? { relativeFrame: frame, fps: 30, durationInFrames: item.durationInFrames } : undefined);
      const renderContext = (canvas) => ({ canvasSettings: { width: canvas.width, height: canvas.height, fps: 30 }, textMeasureCache: new TextMeasurementCache(), renderMode: 'export' });

      const paint = lists.paint.map((c) => {
        const item = textItem(c.item);
        const { surface, ops } = recorder();
        renderTextItem(surface, item, c.transform, renderContext(c.canvas), motionFor(item, c.frame));
        return { expected: ops };
      });

      const styleScale = lists.styleScale.map((c) => {
        const keyframes = { itemId: 'title', properties: Object.entries(c.animated).map(([property, value]) => ({ property, keyframes: [{ id: `k-${property}`, frame: 0, value, easing: 'linear' }] })) };
        const resolved = resolveAnimatedTextItem(textItem(c.item), keyframes, 5, c.canvas);
        return { expected: Object.fromEntries(styleFields.map((key) => [key, resolved[key]])) };
      });

      const motion = lists.motion.map((c) => {
        const samples = [];
        for (const frame of c.frames) {
          for (let unit = 0; unit < Math.max(1, c.context.unitCount); unit++) {
            const s = evaluateGlyphMotion(c.spec, { relativeFrame: frame, fps: 30, durationInFrames: c.context.length, unitIndex: unit, unitCount: c.context.unitCount,
              fontSize: c.context.fontSize, boxWidth: c.context.boxWidth, boxHeight: 200 });
            samples.push(s ? [frame, unit, s.dx, s.dy, s.scale, s.rotation, s.alpha, s.soften] : [frame, unit, 0, 0, 1, 0, 1, 0]);
          }
        }
        return { samples };
      });
      const slot = lists.slot.map((c) => ({ slots: c.frames.map((frame) => getActiveTextMotionSlot(c.spec, frame, c.length)) }));
      const units = lists.units.map((c) => {
        const found = segmentTextUnits(c.lines, c.unit);
        return { indices: found.lineUnitIndices, unitCount: found.unitCount };
      });

      // Image cases: the real 2-D canvas draws; only measuring is replaced by the synthetic measurer,
      // and the text is no-break spaces, so no glyph ink (the platform's part) enters the frame.
      const image = lists.image.map((c) => {
        const canvas = new OffscreenCanvas(size.width, size.height);
        const real = canvas.getContext('2d', { willReadFrequently: true });
        let font = real.font;
        let spacing = 0;
        const surface = new Proxy(real, {
          get(target, key) {
            if (key === 'measureText') {
              return (string) => {
                const found = synthetic.fontMetrics(font);
                return { width: synthetic.measure(string, font, spacing), fontBoundingBoxAscent: found.ascent, fontBoundingBoxDescent: found.descent };
              };
            }
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, key, value) {
            if (key === 'font') font = value;
            if (key === 'letterSpacing') spacing = parseFloat(value);
            target[key] = value;
            return true;
          },
          has: (target, key) => key in target,
        });
        const item = textItem(c.item);
        renderTextItem(surface, item, c.transform, renderContext(size), motionFor(item, 0));
        const pixels = Array.from(real.getImageData(0, 0, size.width, size.height).data, (v) => v / 255);
        if (!pixels.some((v) => v > 0)) throw new Error(`image/${c.name}: the engine drew nothing: ${JSON.stringify({ item, transform: c.transform, font: real.font, spacing })}`);
        return { pixels };
      });

      return { environment, layout, autoHeight, paint, styleScale, motion, slot, units, image };
    }, { lists, fonts, ranges: SUBSET_RANGES, measurerSource: syntheticMeasurer.toString(), size: IMAGE_SIZE, styleFields: ANIMATED_STYLE_FIELDS });
  } finally {
    await browser.close();
  }
}

/** The prose reference must reproduce what the engine just produced. Returns the number of values checked. */
function checkReference(lists, results, catalogue) {
  const synthetic = syntheticMeasurer();
  lists.layout.forEach((c, i) => {
    const measurer = c.measurer === 'synthetic' ? synthetic : recordedMeasurer(results.layout[i].platformMeasurements);
    assert.deepEqual(plain(referenceLayout(c.item, c.box.width, c.box.height, measurer)), plain(results.layout[i].expected), `layout/${c.name}: prose reference differs from the engine`);
  });
  lists.autoHeight.forEach((c, i) => {
    const height = referenceAutoHeight(c.item, c.box.width, c.box.height, recordedMeasurer(results.autoHeight[i].platformMeasurements));
    assert.equal(height, results.autoHeight[i].expected.height, `autoHeight/${c.name}: prose reference differs from the engine`);
  });
  lists.paint.forEach((c, i) => {
    assert.deepEqual(plain(referencePaint(c.item, c.canvas, c.transform, synthetic, c.frame)), plain(results.paint[i].expected), `paint/${c.name}: prose reference differs from the engine`);
  });
  lists.styleScale.forEach((c, i) => {
    assert.deepEqual(plain(referenceAnimatedStyle(c.item, c.animated, c.canvas, catalogue.titleStyles)), plain(results.styleScale[i].expected), `styleScale/${c.name}: prose reference differs from the engine`);
  });
  lists.motion.forEach((c, i) => {
    const sine = Object.values(c.spec).some((slot) => SINE_PRESETS.includes(slot.presetId));
    for (const [frame, unit, ...want] of results.motion[i].samples) {
      const s = referenceMotionState(c.spec, { frame, length: c.context.length, unitIndex: unit, unitCount: c.context.unitCount, fontSize: c.context.fontSize, boxWidth: c.context.boxWidth });
      const got = s ? [s.dx, s.dy, s.scale, s.rotation, s.alpha, s.soften] : [0, 0, 1, 0, 1, 0];
      got.forEach((value, k) => assert(sine ? Math.abs(value - want[k]) <= SINE_TOLERANCE : value === want[k],
        `motion/${c.name}: frame ${frame} unit ${unit} channel ${k}: reference ${value}, engine ${want[k]}`));
    }
  });
  lists.slot.forEach((c, i) => assert.deepEqual(c.frames.map((frame) => referenceCoarseSlot(c.spec, frame, c.length)), results.slot[i].slots, `slot/${c.name}`));
  lists.units.forEach((c, i) => assert.deepEqual(referenceUnits(c.lines, c.unit), results.units[i], `units/${c.name}`));
}

export async function runTextGoldens({ write = false } = {}) {
  const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
  const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
  const engineBuild = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const lists = {
    layout: layoutCases(), autoHeight: autoHeightCases(), paint: paintCases(catalogue), styleScale: styleScaleCases(catalogue),
    motion: motionCases(catalogue), slot: slotCases(catalogue), units: unitCases(), image: imageCases(),
  };
  const fonts = await loadFontFiles();
  const SWIFTSHADER = '--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan --disable-accelerated-2d-canvas';
  const canonicalArgs = (process.env.FREECUT_CHROME_ARGS_REPLACE || SWIFTSHADER).split(/\s+/).filter(Boolean);
  const started = Date.now();
  const canonical = await collect(origin, canonicalArgs, fonts, lists);
  assert.equal(canonical.environment.fontsLoaded, fonts.length, 'every named font file must be loaded');
  checkReference(lists, canonical, catalogue);
  const fontRecord = fonts.map(({ base64, ...font }) => font);

  if (!write) {
    const goldens = JSON.parse(await readFile(goldensPath, 'utf8'));
    validateTextGoldens(goldens, catalogue);
    assert.deepEqual(goldens.fonts, fontRecord, 'the goldens were written with other font files: set TEXT_GOLDENS_FONT_DIR or regenerate');
    let failures = 0;
    const same = (kind, i, actual, expected) => {
      try { assert.deepEqual(plain(actual), expected); } catch { failures++; console.error(`${kind}/${goldens[kind][i].name}: the engine no longer matches the golden`); }
    };
    goldens.layout.forEach((g, i) => { if (g.measurer === 'synthetic') same('layout', i, canonical.layout[i].expected, g.expected); });
    goldens.paint.forEach((g, i) => same('paint', i, canonical.paint[i].expected, g.expected));
    goldens.styleScale.forEach((g, i) => same('styleScale', i, canonical.styleScale[i].expected, g.expected));
    goldens.slot.forEach((g, i) => same('slot', i, canonical.slot[i].slots, g.slots));
    goldens.units.forEach((g, i) => same('units', i, canonical.units[i], { indices: g.indices, unitCount: g.unitCount }));
    goldens.motion.forEach((g, i) => {
      const bound = g.exact ? 0 : SINE_TOLERANCE;
      const ok = g.samples.length === canonical.motion[i].samples.length
        && g.samples.every((row, r) => row.every((value, k) => Math.abs(value - canonical.motion[i].samples[r][k]) <= bound));
      if (!ok) { failures++; console.error(`motion/${g.name}: the engine no longer matches the golden`); }
    });
    goldens.image.forEach((g, i) => {
      const result = compareCase({ ...g, expected: decodeBuffer(g.output.data, g.output.encoding) }, canonical.image[i].pixels);
      if (!result.pass) { failures++; console.error(`image/${g.name}: ${result.missed} channels outside tolerance (worst ${result.worst.toFixed(4)})`); }
    });
    const platform = lists.layout.filter((c) => c.measurer === 'platform').length + lists.autoHeight.length;
    console.log(JSON.stringify({ check: 'platform measurements re-captured and reproduced by the prose reference', cases: platform, environment: canonical.environment,
      measurementsSha256: sha256(JSON.stringify([canonical.layout.map((r) => r.platformMeasurements ?? null), canonical.autoHeight.map((r) => r.platformMeasurements)])) }));
    assert.equal(failures, 0, `${failures} text golden cases drifted`);
    console.log('text goldens hold');
    return { failures };
  }

  const again = await collect(origin, canonicalArgs, fonts, lists);
  assert.deepEqual(again, canonical, 'two canonical runs must agree bit for bit');
  const crossArgs = process.env.GOLDENS_CROSS_CHECK_ARGS?.split(/\s+/).filter(Boolean);
  const cross = crossArgs ? await collect(origin, crossArgs, fonts, lists) : null;
  if (cross) {
    // Numbers do not depend on the backend; only the image cases may.
    for (const kind of ['paint', 'styleScale', 'motion', 'slot', 'units']) assert.deepEqual(cross[kind], canonical[kind], `${kind} values differ between backends`);
  }
  console.log(`collected in ${((Date.now() - started) / 1000).toFixed(1)} s${cross ? ' with a hardware cross-check of the image cases' : ''}`);

  const doc = {
    format: TEXT_GOLDENS_FORMAT, version: TEXT_GOLDENS_VERSION, kind: 'text', contract: 'studio/spec/text.md',
    engine: { name: 'freecut', revision: catalogue.engine.revision, patches: engineBuild.patches.length, sourceDigest: await sourceDigest() },
    generatedBy: 'studio/tools/text-goldens.browser.mjs --write',
    renderer: { canonical: { ...canonical.environment, args: canonicalArgs }, crossCheck: cross ? { ...cross.environment, args: crossArgs } : null },
    fonts: fontRecord,
    syntheticMeasurer: 'text-goldens.mjs syntheticMeasurer: per-character advances in units of the font size, x1.125 at weight 600 and above, no kerning; ascent 0.9375 and descent 0.25 of the size.',
    comparison: `Numeric cases are exact in binary64 (0 and -0 are equal); motion cases with "exact": false allow ${SINE_TOLERANCE} per number. Image cases use render-goldens.mjs compareCase.`,
    imageSize: IMAGE_SIZE,
    layout: lists.layout.map((c, i) => ({ ...c, ...canonical.layout[i] })),
    autoHeight: lists.autoHeight.map((c, i) => ({ ...c, measurer: 'platform', ...canonical.autoHeight[i] })),
    paint: lists.paint.map((c, i) => ({ ...c, measurer: 'synthetic', ...canonical.paint[i] })),
    styleScale: lists.styleScale.map((c, i) => ({ ...c, ...canonical.styleScale[i] })),
    motion: lists.motion.map((c, i) => ({ name: c.name, exact: !Object.values(c.spec).some((slot) => SINE_PRESETS.includes(slot.presetId)), spec: c.spec, context: c.context,
      columns: ['frame', 'unit', 'dx', 'dy', 'scale', 'rotation', 'alpha', 'soften'], samples: canonical.motion[i].samples })),
    slot: lists.slot.map((c, i) => ({ ...c, ...canonical.slot[i] })),
    units: lists.units.map((c, i) => ({ ...c, ...canonical.units[i] })),
    image: lists.image.map((c, i) => {
      const encoding = 'rgba8-deflate-base64';
      const data = encodeBuffer(canonical.image[i].pixels, encoding);
      const tolerance = deriveTolerance('sdr', decodeBuffer(data, encoding), cross?.image[i].pixels, `text/${c.name}`);
      return { ...c, measurer: 'synthetic', tolerance, output: { encoding, data } };
    }),
  };
  const kinds = ['layout', 'autoHeight', 'paint', 'styleScale', 'motion', 'slot', 'units', 'image'];
  const head = Object.fromEntries(Object.entries(doc).filter(([key]) => !kinds.includes(key)));
  const body = kinds.map((kind) => `  ${JSON.stringify(kind)}: [\n${doc[kind].map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`).join(',\n');
  const text = `${JSON.stringify(head, null, 2).replace(/\n}$/, '')},\n${body}\n}\n`;
  const counts = validateTextGoldens(JSON.parse(text), catalogue);
  await writeFile(goldensPath, text);
  console.log(JSON.stringify(counts));
  console.log('wrote studio/spec/goldens/text.json');
  return { counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runTextGoldens({ write: process.argv.includes('--write') });
  process.exit(0);
}
