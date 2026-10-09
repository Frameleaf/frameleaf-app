/** Source-prepared raw JSON acceptance. Run only after independent review/heavy grant. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHarness } from './lib/cross-browser-harness.mjs';
import { openPage, assertNoProxyErrors } from './resource-admission.browser.mjs';
import { animation, edits, samples } from '../adapters/web/test/lottie-owned.fixture.mjs';

const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:5195';
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(origin).protocol, 'http:');
const evidence = process.env.STUDIO_TEST_EVIDENCE;
assert.ok(evidence, 'An owned evidence directory is required');
const omit = process.env.FL105_LOTTIE_OMIT ?? '';
assert.ok(['', 'color', 'text', 'scalar', 'vector'].includes(omit));
const body = Buffer.from(JSON.stringify(animation));
const sourceHash = createHash('sha256').update(body).digest('hex');
const harness = createHarness({ upstream: `${origin}/studio-engine/`, inspectConnect: true,
  overrides: [{ test: (url, request) => url.origin === origin &&
    url.pathname === '/__fl105__/owned.json' && request.method === 'GET',
  respond: () => ({ contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body }) }],
});
const result = { passed: false, sourceHash, omit, stage: 'startup', witnesses: [] };
let driver;
let page;
let failure;
const expected = (edited, frame) => samples.map((sample) => ({ name: sample.name,
  rgba: sample[`frame${frame}`] ?? sample[edited ? 'edited' : 'authored'] }));
function assertPixels(actual, target, label) {
  assert.equal(actual.length, target.length, `${label}: sample count`);
  for (let index = 0; index < target.length; index++) {
    assert.equal(actual[index].name, target[index].name);
    for (let channel = 0; channel < 4; channel++) assert.ok(
      Math.abs(actual[index].rgba[channel] - target[index].rgba[channel]) <= 1,
      `${label}: ${target[index].name} channel${channel} actual=${actual[index].rgba} expected=${target[index].rgba}`,
    );
  }
}
async function seek(frame) {
  await page.click('button[aria-label="Go To Start"]');
  await page.waitForFunction(() => window.fl105Lottie.state().frame === 0);
  for (let index = 0; index < frame; index++) {
    await page.click('button[aria-label="Next Frame"]');
    // Check each actual native action; never manufacture transport or renderer state.
    assert.equal((await page.evaluate(() => window.fl105Lottie.state())).frame, index + 1);
  }
}
async function qualify(edited, frame, stage) {
  result.stage = `${stage}:strict:${frame}`;
  await seek(frame);
  const target = expected(edited, frame);
  const strict = await page.evaluate((value) => window.fl105Lottie.strict(value), frame);
  assert.equal(strict.mapped, frame, 'Independent authored project/source cadence');
  assertPixels(strict.pixels, target, result.stage);
  result.stage = `${stage}:native-preview:${frame}`;
  // Expected values are test metadata only. This does not write production renderer state.
  await page.evaluate((value) => { window.fl105ExpectedPixels = value; }, target);
  try {
    await page.waitForFunction(async () => {
      try {
        const actual = await window.fl105Lottie.preview();
        return actual.every((sample, index) => sample.rgba.every((value, channel) =>
          Math.abs(value - window.fl105ExpectedPixels[index].rgba[channel]) <= 1));
      } catch { return false; }
    }, { timeout: 30_000 });
  } catch (error) {
    // Retain last observed native pixels; original failure still terminates qualification.
    result.lastNative = await page.evaluate(async () => {
      try { return await window.fl105Lottie.preview(); }
      catch (failure) { return { error: String(failure) }; }
    });
    throw error;
  }
  const preview = await page.evaluate(() => window.fl105Lottie.preview());
  assertPixels(preview, target, result.stage);
  result.witnesses.push({ stage, frame, strict, preview, target });
}
try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, 'block', { browser: 'chromium' });
  result.browser = driver.browser;
  page = driver.page;
  const entry = '/studio-engine/test/lottie-owned.browser.html';
  await page.goto(origin + entry);
  await page.waitForFunction(() => !!window.fl105Lottie);
  result.stage = 'native-import';
  const imported = await page.evaluate(({ name, url }) => window.fl105Lottie.open(name, url),
    { name: `fl105-lottie-${randomUUID()}`, url: `${origin}/__fl105__/owned.json` });
  assert.equal(imported.sourceHash, sourceHash);
  result.imported = imported;
  for (const frame of [0, 30]) await qualify(false, frame, 'authored');
  await seek(0);
  result.stage = 'canonical-edit-fullgraph-history';
  await page.evaluate((value) => window.fl105Lottie.edit(value), omit);
  for (const frame of [0, 30]) await qualify(true, frame, 'edited');
  const edited = await page.evaluate(() => window.fl105Lottie.state());
  assert.deepEqual(edited.maps, { colorOverrides: edits.colors,
    textOverrides: edits.text, slotOverrides: edits.slots });
  assert.deepEqual(edited.history, { undo: 1, redo: 0 });
  await seek(0);
  result.stage = 'real-bundle-export-import-reload';
  result.bundle = await page.evaluate(() => window.fl105Lottie.bundle());
  for (const frame of [0, 30]) await qualify(true, frame, 'bundle-reopened');
  assert.deepEqual((await page.evaluate(() => window.fl105Lottie.state())).maps, edited.maps);
  assertNoProxyErrors(harness, origin, entry);
  assert.deepEqual(harness.observations.filter((observation) =>
    ['blocked', 'error', 'tunnelled'].includes(observation.kind)), []);
  const overrides = harness.observations.filter((observation) => observation.kind === 'override');
  assert.ok(overrides.length > 0 && overrides.every((observation) =>
    observation.url === `${origin}/__fl105__/owned.json` && observation.method === 'GET'));
  assert.ok(harness.observations.some((observation) => observation.kind === 'proxied' &&
    new URL(observation.url).pathname.endsWith('/dotlottie-player.wasm') &&
    !new URL(observation.url).searchParams.has('import')), 'Actual bundled WASM request witness required');
  result.stage = 'complete';
  result.passed = true;
} catch (error) {
  failure = error;
  result.error = { name: error.name, message: error.message };
} finally {
  try {
    if (page) {
      await page.evaluate(() => window.fl105Lottie?.dispose());
      result.ownedOpfsDisposed = true;
    }
  } catch (error) {
    result.cleanupError = String(error);
    result.passed = false;
    failure ??= error;
  }
  for (const [name, close] of [
    ['driver', () => driver?.close()], ['harness', () => harness.close()],
  ]) {
    try { await close(); }
    catch (error) {
      result.cleanupErrors ??= [];
      result.cleanupErrors.push({ name, error: String(error) });
      result.passed = false;
      failure ??= error;
    }
  }
  result.requests = harness.observations;
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, `lottie-${omit || 'positive'}.json`), JSON.stringify(result, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify(result));
