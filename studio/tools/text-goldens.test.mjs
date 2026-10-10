// Engine-free checks of the text render spec (studio/spec/text.md): golden structure and coverage,
// the prose reference of text-goldens.mjs reproducing every numeric golden, the image cases against
// the geometry the prose predicts, and the clean-room lint. text-goldens.browser.mjs checks the
// goldens against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCase, decodeBuffer, sha256 } from './render-goldens.mjs';
import {
  SINE_TOLERANCE, SINE_PRESETS, STYLE_FIELDS, IMAGE_SIZE, TEXT_MOTION_PRESETS,
  syntheticMeasurer, recordedMeasurer, plain, validateTextGoldens, randomRanks, bundledTitleFonts, bundledFontRecords,
  layoutCases, autoHeightCases, paintCases, styleScaleCases, motionCases, slotCases, unitCases, imageCases,
  referenceLayout, referenceAutoHeight, referencePaint, referenceAnimatedStyle, referenceMotionState, referenceCoarseSlot, referenceUnits,
} from './text-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(studio, '..');
const readJson = async (rel) => JSON.parse(await readFile(path.join(studio, rel), 'utf8'));
const catalogue = await readJson('graph-parameters-v1.json');
const goldens = await readJson('spec/goldens/text.json');
const page = await readFile(path.join(studio, 'spec/text.md'), 'utf8');
const synthetic = syntheticMeasurer();
const IDENTITY = [0, 0, 1, 0, 1, 0];

test('the goldens hold every case, in order, and name the font files they were made with', async () => {
  const counts = validateTextGoldens(goldens, catalogue);
  assert(counts.layout >= 80 && counts.paint >= 40 && counts.motion >= 80 && counts.styleScale >= 40, 'case lists unexpectedly short');
  assert.equal(goldens.contract, 'studio/spec/text.md');
  assert.equal(goldens.engine.revision, catalogue.engine.revision);
  // The fonts of the platform cases are exactly the bundled title fonts, file for file and hash for hash.
  const bundled = bundledFontRecords(await bundledTitleFonts(repository));
  assert.equal(bundled.length, 64);
  // The decoded twins are on disk in the repository with the hashes the goldens name.
  for (const font of goldens.fonts) assert.equal(sha256(await readFile(path.join(repository, font.decoded.file))), font.decoded.sha256, font.decoded.file);
  assert.deepEqual(goldens.fonts, bundled);
  assert.deepEqual([...new Set(bundled.map((font) => font.family))], ['Inter', 'Inter Tight', 'Anton', 'Bebas Neue', 'Orbitron', 'Playfair Display', 'Space Grotesk']);
  for (const family of new Set(catalogue.titleStyles.presets.map((preset) => preset.fields.fontFamily))) assert(bundled.some((font) => font.family === family), `${family} is not bundled`);
  for (const list of [layoutCases, autoHeightCases, unitCases, imageCases]) assert.deepEqual(list(), list());
  for (const list of [paintCases, styleScaleCases, motionCases, slotCases]) assert.deepEqual(list(catalogue), list(catalogue));
});

test('coverage: every style field, alignment, span flow, preset, order, easing and unit kind', () => {
  const items = [...goldens.layout, ...goldens.paint, ...goldens.styleScale, ...goldens.autoHeight].map((c) => c.item);
  for (const field of STYLE_FIELDS) assert(items.some((item) => Object.hasOwn(item, field)), `no case sets ${field}`);
  for (const field of ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'color', 'letterSpacing']) {
    assert(items.some((item) => item.textSpans?.some((span) => Object.hasOwn(span, field))), `no span overrides ${field}`);
  }
  for (const textAlign of ['left', 'center', 'right']) {
    for (const verticalAlign of ['top', 'middle', 'bottom']) {
      assert(goldens.layout.some((c) => c.item.textAlign === textAlign && c.item.verticalAlign === verticalAlign), `${textAlign}/${verticalAlign}`);
    }
  }
  assert(goldens.layout.some((c) => c.item.spanLayout === 'inline' && c.expected.lines.some((line) => line.runs?.length > 1)));
  assert(goldens.layout.some((c) => c.item.textSpans?.length > 1 && c.item.spanLayout !== 'inline' && new Set(c.expected.lines.map((line) => line.fontSize)).size > 1));
  assert(goldens.layout.some((c) => c.measurer === 'platform') && goldens.layout.some((c) => c.expected.background));

  const presets = [...catalogue.textMotion.in, ...catalogue.textMotion.out, ...catalogue.textMotion.loop];
  assert.equal(presets.length, 17);
  assert.deepEqual(Object.keys(TEXT_MOTION_PRESETS), presets);
  for (const slot of ['in', 'out', 'loop']) for (const id of catalogue.textMotion[slot]) assert.equal(TEXT_MOTION_PRESETS[id].slot, slot);
  const used = (list) => new Set(list.flatMap((c) => Object.values(c.spec ?? c.item.textMotion ?? {}).map((slot) => slot.presetId)));
  assert.deepEqual([...used(goldens.motion)].sort(), [...presets].sort());
  assert.deepEqual([...used(goldens.paint)].sort(), [...presets].sort());
  const slots = goldens.motion.flatMap((c) => Object.values(c.spec));
  for (const order of ['forward', 'backward', 'center', 'random']) assert(slots.some((slot) => slot.order === order), order);
  for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot']) assert(slots.some((slot) => slot.easing === easing), easing);
  for (const unit of ['character', 'word', 'line', 'whole-clip']) assert(goldens.units.some((c) => c.unit === unit), unit);
  // Every preset moves at least one sampled unit away from its identity at its default settings.
  for (const id of presets) {
    const c = goldens.motion.find((entry) => entry.name === `preset/${id}`);
    assert(c.samples.some((row) => row.slice(2).some((value, k) => value !== IDENTITY[k])), `${id} never leaves its identity`);
    assert.equal(c.exact, !SINE_PRESETS.includes(id));
  }
  const ops = new Set(goldens.paint.flatMap((c) => c.expected.map((op) => op.op)));
  assert.deepEqual([...ops].sort(), ['background', 'clip', 'fill', 'stroke', 'underline']);
  assert(goldens.paint.some((c) => c.expected.some((op) => op.motion?.rotation)) && goldens.paint.some((c) => c.expected.some((op) => op.blur > 0)));
});

test('the prose reference reproduces every layout and auto-height golden bit for bit', () => {
  for (const c of goldens.layout) {
    const measurer = c.measurer === 'synthetic' ? synthetic : recordedMeasurer(c.platformMeasurements);
    assert.deepEqual(plain(referenceLayout(c.item, c.box.width, c.box.height, measurer)), c.expected, `layout/${c.name}`);
  }
  for (const c of goldens.autoHeight) {
    assert.equal(referenceAutoHeight(c.item, c.box.width, c.box.height, recordedMeasurer(c.platformMeasurements)), c.expected.height, `autoHeight/${c.name}`);
  }
  assert(goldens.autoHeight.some((c) => c.expected.height > c.box.height) && goldens.autoHeight.some((c) => c.expected.height === c.box.height));
});

test('the prose reference reproduces every paint and animated-style golden bit for bit', () => {
  for (const c of goldens.paint) assert.deepEqual(plain(referencePaint(c.item, c.canvas, c.transform, synthetic, c.frame)), c.expected, `paint/${c.name}`);
  for (const c of goldens.styleScale) {
    assert.deepEqual(plain(referenceAnimatedStyle(c.item, c.animated, c.canvas, catalogue.titleStyles)), c.expected, `styleScale/${c.name}`);
  }
});

test('the prose reference reproduces every text-motion state, slot and unit golden', () => {
  let exact = 0;
  let toleranced = 0;
  for (const c of goldens.motion) {
    for (const [frame, unit, ...want] of c.samples) {
      const s = referenceMotionState(c.spec, { frame, length: c.context.length, unitIndex: unit, unitCount: c.context.unitCount, fontSize: c.context.fontSize, boxWidth: c.context.boxWidth });
      const got = s ? [s.dx, s.dy, s.scale, s.rotation, s.alpha, s.soften] : IDENTITY;
      got.forEach((value, k) => {
        if (c.exact) assert(value === want[k], `motion/${c.name}: frame ${frame} unit ${unit} channel ${k}: ${value} != ${want[k]}`);
        else assert(Math.abs(value - want[k]) <= SINE_TOLERANCE, `motion/${c.name}: frame ${frame} unit ${unit} channel ${k}`);
      });
      if (c.exact) exact++; else toleranced++;
    }
  }
  assert(exact > 3000 && toleranced > 1000, `${exact} exact and ${toleranced} toleranced states`);
  for (const c of goldens.slot) assert.deepEqual(c.frames.map((frame) => referenceCoarseSlot(c.spec, frame, c.length)), c.slots, `slot/${c.name}`);
  for (const c of goldens.units) assert.deepEqual(referenceUnits(c.lines, c.unit), { indices: c.indices, unitCount: c.unitCount }, `units/${c.name}`);
});

test('an 8-digit colour draws exactly as the rgba() string of the caption preset it replaces', () => {
  const frame = (name) => goldens.image.find((c) => c.name === name).output.data;
  assert.equal(frame('alpha/background-8-digit-equals-caption-rgba'), frame('background-translucent'));
  assert.equal(frame('alpha/caption-shadow-8-digit'), frame('alpha/caption-shadow-rgba'));
  assert.notEqual(frame('alpha/shadow-8-digit'), frame('underline-hard-shadow'));
});

test('the random order is a permutation fixed by the unit count and the seed', () => {
  for (const [count, seed] of [[1, 0], [2, 0], [9, 7], [9, -3], [40, 123456789]]) {
    const ranks = randomRanks(count, seed);
    assert.deepEqual([...ranks].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
    assert.deepEqual(randomRanks(count, seed), ranks);
  }
  assert.notDeepEqual(randomRanks(9, 7), randomRanks(9, 8));
  assert.deepEqual(randomRanks(9, 2.7), randomRanks(9, 2));
});

const colourOf = (text) => {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(hex[2] ? parseInt(hex[2], 16) / 255 : 1);
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(text);
  assert(rgba, `unsupported test colour ${text}`);
  // X12: the alpha of a functional colour is rounded to the nearest of 255 steps.
  return [rgba[1] / 255, rgba[2] / 255, rgba[3] / 255, Math.round(Number(rgba[4]) * 255) / 255];
};

test('image cases: stored frames have the geometry and colours the prose predicts', () => {
  const { width, height } = IMAGE_SIZE;
  let checked = 0;
  for (const c of goldens.image) {
    assert.match(c.tolerance.class, /^(pixel|edge)$/, `${c.name} must be a pixel or edge case`);
    const pixels = decodeBuffer(c.output.data, c.output.encoding);
    assert.equal(pixels.length, width * height * 4);
    assert(compareCase({ ...c, expected: pixels }, pixels).pass);
    assert(!compareCase({ ...c, expected: pixels }, pixels.map(() => 0)).pass, `${c.name}: a blank frame must fail`);
    // Shapes in paint order, each a rectangle with a corner radius, a colour and a blur margin.
    const ops = referencePaint(c.item, IMAGE_SIZE, c.transform, synthetic, 0);
    const clip = ops.find((op) => op.op === 'clip');
    const shapes = [];
    for (const op of ops) {
      const rect = op.op === 'background' ? { x: op.x, y: op.y, w: op.width, h: op.height, r: op.radius }
        : op.op === 'underline' ? { x: op.x1, y: op.y - op.thickness / 2, w: op.x2 - op.x1, h: op.thickness, r: 0 } : null;
      if (!rect) continue;
      // X12: a shadow's alpha is the shadow colour's alpha times the alpha of the shape that casts it.
      if (op.shadow) {
        const cast = colourOf(op.shadow.color);
        shapes.push({ ...rect, x: rect.x + op.shadow.offsetX, y: rect.y + op.shadow.offsetY, colour: [cast[0], cast[1], cast[2], cast[3] * colourOf(op.color)[3]], soft: op.shadow.blur });
      }
      shapes.push({ ...rect, colour: colourOf(op.color), soft: 0 });
    }
    assert(shapes.length > 0, `${c.name} draws nothing`);
    // Signed distance of a pixel centre into a rectangle (positive inside), ignoring rounded corners.
    const depth = (shape, px, py) => Math.min(px - shape.x, shape.x + shape.w - px, py - shape.y, shape.y + shape.h - py);
    const core = (shape, px, py) => depth(shape, px, py) >= 1 && shape.soft === 0
      && (Math.min(px - shape.x, shape.x + shape.w - px) >= shape.r + 1 || Math.min(py - shape.y, shape.y + shape.h - py) >= shape.r + 1);
    const clear = (shape, px, py) => depth(shape, px, py) <= -(1.5 + 3 * shape.soft);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const px = i + 0.5;
        const py = j + 0.5;
        const got = pixels.slice((j * width + i) * 4, (j * width + i) * 4 + 4);
        const inClip = depth({ x: clip.x, y: clip.y, w: clip.width, h: clip.height }, px, py);
        let want = null;
        if (inClip <= -1 || shapes.every((shape) => clear(shape, px, py))) want = [0, 0, 0, 0];
        else if (inClip >= 1) {
          const top = shapes.findLastIndex((shape) => core(shape, px, py));
          if (top >= 0 && shapes.slice(top + 1).every((shape) => clear(shape, px, py)) && (shapes[top].colour[3] === 1 || shapes.slice(0, top).every((shape) => clear(shape, px, py)))) want = shapes[top].colour;
        }
        if (!want) continue;
        checked++;
        const visible = want[3] > 0;
        want.forEach((value, k) => {
          if (k < 3 && !visible) return;
          assert(Math.abs(got[k] - value) <= 2 / 255 + 1e-9, `image/${c.name}: pixel (${i}, ${j}) channel ${k} is ${got[k]}, the prose gives ${value}`);
        });
      }
    }
  }
  assert(checked > goldens.image.length * width * height * 0.6, `only ${checked} pixels were decidable`);
});

// The spec is prose and mathematics: no engine source text (the lint of render-goldens.test.mjs).
const SOURCE_PATTERNS = [
  /\bfn\s+\w+\s*\(/, /@(fragment|vertex|compute|group|binding|builtin|location)\b/, /\btexture(Sample\w*|Load|Store|Dimensions)\b/,
  /\bvec[234][fiu]?\s*\(/, /\bmat[234]x?[234]?f?\s*\(/, /\blet\s+\w+\s*:\s*\w+\s*=/, /\bvar\s*(<[^>]*>)?\s+\w+\s*:/, /\bconst\s+\w+\s*[:=]/,
  /=>/, /\bctx\.\w+/, /\bnew\s+(Float32Array|Path2D|OffscreenCanvas)\b/, /\bpackUniforms\b/, /\bparams\.\w+/, /\{\s*$\n\s+\w+.*\n\s*\}/m,
  /\bfunction\s+\w+\s*\(/, /\bMath\.\w+/, /\bfillText\b|\bstrokeText\b|\bmeasureText\b|\bglobalAlpha\b|\bshadowBlur\b/, /\?\?|===/,
];

test('text.md is clean-room prose, cites tags X1 to X22 and names every field and preset', () => {
  for (const pattern of SOURCE_PATTERNS) assert(!pattern.test(page), `text.md matches ${pattern}`);
  for (let n = 1; n <= 22; n++) assert(page.includes(`**[X${n}]`), `tag X${n} is missing`);
  assert(!page.includes('**[X23]'));
  for (const field of STYLE_FIELDS) assert(page.includes(`\`${field}\``), `text.md does not name ${field}`);
  for (const id of Object.keys(TEXT_MOTION_PRESETS)) assert(page.includes(`| \`${id}\` | ${TEXT_MOTION_PRESETS[id].slot} | ${TEXT_MOTION_PRESETS[id].unit} |`), `text.md preset row ${id}`);
  // The preset table restates the catalogue defaults.
  for (const [id, d] of Object.entries(catalogue.textMotion.defaults)) {
    const row = page.split('\n').find((line) => line.startsWith(`| \`${id}\` |`));
    assert(row.includes(`| ${d.durationFrames}, ${d.staggerFrames}, ${d.easing}${d.order === 'forward' ? '' : `, order ${d.order}`} |`), `text.md defaults of ${id}`);
    assert.equal(d.intensity, 1);
  }
  for (const preset of catalogue.titleStyles.presets) {
    if (preset.id in { 'clean-title': 1, poster: 1, 'outline-pill': 1, cinematic: 1, neon: 1 }) continue;
    assert(page.includes(`| \`${preset.id}\` |`), `text.md template spans of ${preset.id}`);
  }
  for (const font of goldens.fonts) assert(page.includes(`| \`${font.file}\` | \`${font.sha256}\` | \`${font.decoded.sha256}\` |`), `text.md does not name ${font.file} with its two hashes`);
});
