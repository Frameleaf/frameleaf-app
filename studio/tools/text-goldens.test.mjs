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
  SYNTHETIC_MEASURER_TABLE, sameWithin, usesSine, referenceImage, imageTolerance, referenceRequiredHeight, referenceColour,
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
  for (const c of goldens.paint) {
    assert.equal(c.exact, !usesSine(c.item.textMotion), `paint/${c.name}: exactness`);
    assert(sameWithin(plain(referencePaint(c.item, c.canvas, c.transform, synthetic, c.frame)), c.expected, c.exact ? 0 : SINE_TOLERANCE), `paint/${c.name}`);
    assert(referenceRequiredHeight(c.item, c.transform.width, synthetic) <= c.transform.height + 0.5, `paint/${c.name}: X6 would grow this box`);
  }
  assert(goldens.paint.filter((c) => !c.exact).length >= 5);
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

test('the random order is a permutation fixed by the unit count and the seed', () => {
  for (const [count, seed] of [[1, 0], [2, 0], [9, 7], [9, -3], [40, 123456789]]) {
    const ranks = randomRanks(count, seed);
    assert.deepEqual([...ranks].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
    assert.deepEqual(randomRanks(count, seed), ranks);
  }
  assert.notDeepEqual(randomRanks(9, 7), randomRanks(9, 8));
  assert.deepEqual(randomRanks(9, 2.7), randomRanks(9, 2));
});

test('an 8-digit colour draws exactly as the rgba() string of the caption preset it replaces', () => {
  const frame = (name) => goldens.image.find((c) => c.name === name).output.data;
  assert.equal(frame('alpha/background-8-digit-equals-caption-rgba'), frame('background-translucent'));
  assert.equal(frame('alpha/caption-shadow-8-digit'), frame('alpha/caption-shadow-rgba'));
  assert.notEqual(frame('alpha/shadow-8-digit'), frame('underline-hard-shadow'));
  // The forms a reader accepts (X12) and the 8-digit form a writer gives them.
  assert.deepEqual(referenceColour('rgba(0, 0, 0, 0.55)'), referenceColour('#0000008c'));
  assert.deepEqual(referenceColour('rgba(0, 0, 0, 0.6)'), referenceColour('#00000099'));
  assert.deepEqual(referenceColour('rgb(51,102,204)'), referenceColour('#3366CC'));
  assert.deepEqual(referenceColour('#36c'), referenceColour('#3366cc'));
  assert.deepEqual(referenceColour('#36c8'), referenceColour('#3366cc88'));
  assert.throws(() => referenceColour('rebeccapurple'));
});

test('image cases: declared classes, measured tolerances and the pixels the prose predicts', () => {
  const { width, height } = IMAGE_SIZE;
  assert.deepEqual(goldens.imageSize, IMAGE_SIZE);
  const classes = { pixel: 0, edge: 0, statistical: 0 };
  for (const c of goldens.image) {
    classes[c.class]++;
    const { measured, ...tolerance } = c.tolerance;
    const { measured: _, ...declared } = imageTolerance(c);
    assert.deepEqual(tolerance, declared, `image/${c.name}: tolerance must follow from the declared class`);
    assert.equal(c.tolerance.class, c.class);
    assert(referenceRequiredHeight(c.item, c.transform.width, synthetic) <= c.transform.height + 0.5, `image/${c.name}: X6 would grow this box`);
    const pixels = decodeBuffer(c.output.data, c.output.encoding);
    assert.equal(pixels.length, width * height * 4);
    assert(compareCase({ ...c, expected: pixels }, pixels).pass);
    assert(!compareCase({ ...c, expected: pixels }, pixels.map(() => 0)).pass, `${c.name}: a blank frame must fail`);
    const { expected, undecided, blurred } = referenceImage(c);
    if (c.class === 'pixel') assert.equal(undecided, 0, `image/${c.name}: a pixel case leaves nothing to the rasteriser`);
    if (c.class === 'edge') assert(undecided > 0 && undecided <= 0.1 * width * height && !blurred);
    if (c.class === 'statistical') assert(blurred, `image/${c.name}: only a blur is statistical`);
    expected.forEach((want, index) => {
      if (!want) return;
      const got = pixels.slice(index * 4, index * 4 + 4);
      assert(Math.abs(got[3] - want[3]) <= 2 / 255 + 1e-9, `image/${c.name}: pixel ${index % width}, ${Math.floor(index / width)} alpha is ${got[3]}, the prose gives ${want[3]}`);
      if (want[3] === 0) return;
      // An 8-bit premultiplied surface holds a colour to half a step of its alpha.
      const bound = 2 / 255 + 0.5 / (want[3] * 255);
      for (let k = 0; k < 3; k++) assert(Math.abs(got[k] - want[k]) <= bound, `image/${c.name}: pixel ${index % width}, ${Math.floor(index / width)} channel ${k} is ${got[k]}, the prose gives ${want[k]}`);
    });
  }
  assert(classes.pixel >= 10 && classes.edge >= 5 && classes.statistical === 1, JSON.stringify(classes));
  // Not specifiable cases are never binding pixel cases.
  assert.equal(goldens.image.find((c) => c.name === 'underline-blurred-shadow').class, 'statistical');
  for (const c of goldens.image.filter((entry) => entry.item.backgroundRadius > 0)) assert.equal(c.class, 'edge', c.name);
});

test('the synthetic measurer is published as data and that data is the measurer', () => {
  assert.deepEqual(goldens.syntheticMeasurer, SYNTHETIC_MEASURER_TABLE);
  const table = goldens.syntheticMeasurer;
  const factor = (char) => {
    const code = char.codePointAt(0);
    if (code === 0x20 || code === 0xa0 || table.advances[0].characters.includes(char)) return table.advances[0].factor;
    if (table.advances[1].characters.includes(char)) return table.advances[1].factor;
    if (code >= 0x41 && code <= 0x5a) return table.advances[2].factor;
    if (code >= 0x2e80) return table.advances[3].factor;
    return table.advances[4].factor;
  };
  const probe = "The quick MW mw ij l.,:;!|' 0123   日本 é-_@";
  for (const [weight, size, spacing] of [[400, 32, 0], [500, 37.5, 2], [600, 40, -1], [700, 16, 0.5]]) {
    let width = 0;
    let count = 0;
    for (const char of probe) { width += size * factor(char) * (weight >= table.weightFactor.fromWeight ? table.weightFactor.factor : 1); count++; }
    const font = `italic ${weight} ${size}px "Anton", sans-serif`;
    assert.equal(synthetic.measure(probe, font, spacing), width + count * spacing);
    assert.deepEqual(synthetic.fontMetrics(font), { ascent: size * table.ascent, descent: size * table.descent });
  }
  for (const row of table.advances) assert(page.includes(`| ${row.factor} |`), `text.md does not publish the advance ${row.factor}`);
});

test('a weight or style a family lacks measures as the face it has', () => {
  const lines = (name) => goldens.layout.find((c) => c.name === name).expected.lines.map((line) => [line.text, line.width, line.top, line.baseline, line.start]);
  assert.deepEqual(lines('platform/missing-weight/Anton-bold'), lines('platform/missing-weight/Anton-normal'));
  assert.deepEqual(lines('platform/missing-style/Orbitron-italic'), lines('platform/missing-style/Orbitron-normal'));
  assert.deepEqual(lines('platform/missing-both/Bebas-Neue-semibold-italic'), lines('platform/missing-both/Bebas-Neue-normal'));
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
