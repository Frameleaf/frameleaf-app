// Evaluates every case of keyframe-goldens.mjs with the real engine's render-time
// interpolation functions and writes studio/spec/goldens/keyframes.json, the numeric half
// of studio/spec/keyframes.md. Needs the prepared engine served by Vite:
//   npm --prefix studio/engine run dev -- --host 127.0.0.1 --port 5186 --strictPort
//   node studio/tools/keyframe-goldens.browser.mjs --write
// Without --write it is a drift gate: it fails when the engine no longer gives the committed
// values (bit for bit for `exact` cases, within the stated tolerance otherwise). The maths
// runs in page JavaScript, so no WebGPU is needed. STUDIO_TEST_ORIGIN names the server.
// Expected values always come from the engine; none is written by hand.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYFRAME_GOLDENS_FORMAT, KEYFRAME_GOLDENS_VERSION, KEYFRAME_GOLDENS_KIND, TOLERANCES, TRANSFORM_FIELDS, sha256,
  keyframeCases, classifyCase, referenceCase, compareKeyframeCase, encodeResult, decodeResult, hexToDouble,
  validateKeyframeGoldens, serialiseKeyframeGoldens,
} from './keyframe-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = path.join(studio, 'spec/goldens/keyframes.json');

// The engine files whose behaviour the goldens pin; their digest is recorded so drift is visible.
const SOURCE_FILES = [
  'src/features/keyframes/utils/animated-transform-resolver.ts',
  'src/features/keyframes/utils/color-keyframes.ts',
  'src/features/keyframes/utils/interpolation.ts',
  'src/features/keyframes/utils/vector-interpolation.ts',
  'src/shared/utils/easing.ts',
  'src/types/keyframe.ts',
];
async function sourceDigest() {
  const parts = [];
  for (const file of SOURCE_FILES) parts.push(`${file}\0${sha256(await readFile(path.join(studio, 'engine', file)))}`);
  return { files: SOURCE_FILES.length, sha256: sha256(parts.join('\n')) };
}

const PAGE = `<title>Keyframe goldens</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`;

/** Runs every case through the engine. Numbers come back as binary64 bit patterns (hex). */
async function evaluateWithEngine(origin, cases) {
  const require = createRequire(path.join(studio, 'engine/package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${origin}/keyframe-goldens`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${origin}/keyframe-goldens`);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    const out = await page.evaluate(async ({ cases, fields }) => {
      const { applyEasing, applyEasingConfig } = await import('/src/features/keyframes/utils/easing.ts');
      const { interpolatePropertyValue } = await import('/src/features/keyframes/utils/interpolation.ts');
      const { interpolateVectorPropertyValue } = await import('/src/features/keyframes/utils/vector-interpolation.ts');
      const { interpolateColorKeyframesToHex } = await import('/src/features/keyframes/utils/color-keyframes.ts');
      const { resolveAnimatedTransform } = await import('/src/features/keyframes/utils/animated-transform-resolver.ts');
      const view = new DataView(new ArrayBuffer(8));
      const bits = (value) => {
        if (typeof value !== 'number') throw new Error(`engine returned ${typeof value}, not a number`);
        view.setFloat64(0, value);
        return view.getBigUint64(0).toString(16).padStart(16, '0');
      };
      // Keyframes get ids as a graph's have; the interpolation never reads them.
      const withIds = (keyframes) => keyframes.map((keyframe, index) => ({ id: `k${index}`, ...keyframe }));
      const run = (c) => {
        const i = c.input;
        if (c.kind === 'easing') {
          // The two calls the interpolation makes for a segment: with a config, and without.
          return { numbers: [bits(i.easingConfig ? applyEasingConfig(i.t, i.easingConfig) : applyEasing(i.t, i.easing))] };
        }
        if (c.kind === 'scalar') return { numbers: [bits(interpolatePropertyValue(withIds(i.keyframes), i.frame, i.base))] };
        if (c.kind === 'vector') {
          const v = interpolateVectorPropertyValue(i.property, withIds(i.keyframes), i.frame, i.base, i.fps);
          return { numbers: [bits(v.x), bits(v.y)] };
        }
        if (c.kind === 'colour') return { colour: interpolateColorKeyframesToHex(withIds(i.keyframes), i.frame, i.base) };
        if (c.kind === 'transform') {
          const entry = {
            ...i.entry,
            properties: i.entry.properties.map((g) => ({ ...g, keyframes: withIds(g.keyframes) })),
            ...(i.entry.vectorProperties && { vectorProperties: i.entry.vectorProperties.map((g) => ({ ...g, keyframes: withIds(g.keyframes) })) }),
          };
          // With a rate, the renderer's context (project rate, the composition's clips); without, none.
          const context = i.fps === undefined ? undefined : {
            globalFrame: i.frame, canvas: { width: 1920, height: 1080, fps: i.fps },
            getItem: () => undefined, getKeyframes: (id) => (id === entry.itemId ? entry : undefined),
          };
          const t = resolveAnimatedTransform({ ...i.base }, entry, i.frame, context);
          return { numbers: fields.map((field) => bits(t[field])) };
        }
        throw new Error(`unknown kind ${c.kind}`);
      };
      const first = cases.map(run);
      const second = cases.map(run);
      return { first, second, userAgent: navigator.userAgent };
    }, { cases, fields: TRANSFORM_FIELDS });
    assert.deepEqual(errors, [], 'page errors');
    return out;
  } finally {
    await browser.close();
  }
}

function decodeEngineResult(kind, raw) {
  if (kind === 'colour') return raw.colour;
  const n = raw.numbers.map(hexToDouble);
  if (kind === 'easing' || kind === 'scalar') return n[0];
  if (kind === 'vector') return { x: n[0], y: n[1] };
  return Object.fromEntries(TRANSFORM_FIELDS.map((field, index) => [field, n[index]]));
}

/**
 * write: true regenerates studio/spec/goldens/keyframes.json from the engine.
 * write: false checks the committed file against the engine and throws on drift.
 */
export async function runKeyframeGoldens({ write = false, origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186', log = console.log } = {}) {
  const cases = keyframeCases();
  const { first, second, userAgent } = await evaluateWithEngine(origin, cases);
  assert.deepEqual(first, second, 'the engine did not give the same values twice');
  const results = cases.map((c, index) => decodeEngineResult(c.kind, first[index]));

  if (!write) {
    const doc = JSON.parse(await readFile(goldenPath, 'utf8'));
    const counts = validateKeyframeGoldens(doc);
    const digest = await sourceDigest();
    let failures = 0;
    doc.cases.forEach((golden, index) => {
      const outcome = compareKeyframeCase(golden, results[index]);
      if (outcome.pass) return;
      failures += 1;
      console.error(`${golden.name}: engine gives ${JSON.stringify(encodeResult(golden.kind, results[index]))}, golden holds ${JSON.stringify(golden.expected)}`);
    });
    assert.equal(failures, 0, `${failures} keyframe golden cases drifted`);
    if (digest.sha256 !== doc.engine.sourceDigest.sha256) log('note: the keyframe sources changed but every golden value still holds');
    log(`keyframe goldens hold ${JSON.stringify(counts)}`);
    return counts;
  }

  const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
  const engineBuild = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const doc = {
    format: KEYFRAME_GOLDENS_FORMAT, version: KEYFRAME_GOLDENS_VERSION, kind: KEYFRAME_GOLDENS_KIND,
    contract: 'studio/spec/keyframes.md',
    engine: { name: 'freecut', revision: catalogue.engine.revision, patches: engineBuild.patches.length, sourceDigest: await sourceDigest() },
    generatedBy: 'studio/tools/keyframe-goldens.browser.mjs --write',
    evaluator: { userAgent },
    numbers: 'Every number is a JSON number that reads back to the same IEEE 754 binary64 value the engine produced (the shortest round-trip decimal). The values JSON cannot hold are the strings "NaN", "Infinity", "-Infinity" and "-0". A colour is a lower-case hex string.',
    comparison: 'keyframe-goldens.mjs compareKeyframeCase. exact: the same binary64 value for every number (NaN equals NaN, -0 differs from 0), the same string for a colour. tolerance.abs: |actual - expected| <= abs for every number. tolerance.channel: every 8-bit channel within that many steps.',
    tolerances: TOLERANCES,
    cases: cases.map((c, index) => ({ name: c.name, kind: c.kind, input: c.input, expected: encodeResult(c.kind, results[index]), ...classifyCase(c) })),
  };
  const text = serialiseKeyframeGoldens(doc);
  // Lossless storage: what is read back is bit for bit what the engine returned.
  const reread = JSON.parse(text);
  reread.cases.forEach((c, index) => {
    const stored = decodeResult(c.kind, c.expected);
    assert(compareKeyframeCase({ ...c, exact: true }, results[index]).pass && compareKeyframeCase({ kind: c.kind, exact: true, expected: encodeResult(c.kind, results[index]) }, stored).pass,
      `${c.name}: the stored value does not round-trip`);
  });
  const counts = validateKeyframeGoldens(reread);
  // The prose must reproduce the engine. A failure here is a defect of studio/spec/keyframes.md.
  let misses = 0;
  reread.cases.forEach((golden, index) => {
    const reference = referenceCase(cases[index]).value;
    const outcome = compareKeyframeCase(golden, reference);
    if (outcome.pass) return;
    misses += 1;
    console.error(`${golden.name}: prose gives ${JSON.stringify(encodeResult(golden.kind, reference))}, engine gives ${JSON.stringify(golden.expected)}`);
  });
  await writeFile(goldenPath, text);
  log(`wrote studio/spec/goldens/keyframes.json ${JSON.stringify(counts)}`);
  assert.equal(misses, 0, `${misses} cases are not reproduced by the reference of keyframe-goldens.mjs: fix studio/spec/keyframes.md and the reference, not the tolerance`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runKeyframeGoldens({ write: process.argv.includes('--write') });
  process.exit(0);
}
