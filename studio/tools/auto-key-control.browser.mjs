/** Native auto-key -> actual vector timeline/history/render. API persistence is not tested. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { admittedHostCapabilities } from "./lib/browser-driver.mjs";
import { openPage } from "./resource-admission.browser.mjs";
const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5196";
const browser = process.env.BROWSER ?? "chromium";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
admittedHostCapabilities(browser);
if (browser !== "chromium") assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
const harness = createHarness({ upstream: origin });
let driver;
try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {browser, endpoint: process.env.WEBDRIVER_ENDPOINT});
  const page = driver.page;
  const browserProvenance = driver.browser;
  await page.goto(`${origin}/studio-engine/test/editor-controls.browser.html`);
  await page.waitForFunction(() => !!window.fl100Editor);
  await page.evaluate(() => {
    window.fl100Editor.seedEasing();
    window.fl100Editor.prepareAutoKey();
  });
  const baseline = await page.evaluate(() => window.fl100Editor.state());
  const lane = (state) =>
    state.keys
      .find((entry) => entry.itemId === "hero")
      .vectorProperties.find((entry) => entry.property === "position")
      .keyframes;
  assert.deepEqual(
    lane(baseline).map((key) => key.frame),
    [0, 30],
  );
  const before = await page.evaluate(() =>
    window.fl100Editor.renderHero(15, 0),
  );
  assert.equal(before.pose.x, 0);
  assert.equal(before.maxDelta, 0);
  const input =
    '[data-testid="dopesheet-scroll-area"] input[aria-label="Position X"]';
  await page.click(
    '[data-testid="dopesheet-scroll-area"] button[aria-label="Enable auto-key for Position"]',
  );
  await page.fill(input, "12");
  // A native blur commits; no graph/history mutation is issued by the fixture.
  await page.click(
    '[data-testid="dopesheet-scroll-area"] button[aria-label="Auto-key enabled for Position"]',
  );
  const changed = await page.evaluate(() => window.fl100Editor.state());
  const keys = lane(changed);
  assert.deepEqual(
    keys.map((key) => key.frame),
    [0, 15, 30],
  );
  assert.deepEqual(keys[0], lane(baseline)[0]);
  assert.deepEqual(keys[2], lane(baseline)[1]);
  assert.deepEqual(keys[1].value, { x: 12, y: 0 });
  assert.equal(changed.keys[0].animationVersion, 2);
  assert.deepEqual(changed.keys[0].properties, baseline.keys[0].properties);
  assert.deepEqual(changed.items, baseline.items);
  assert.deepEqual(changed.tracks, baseline.tracks);
  assert.ok(changed.canUndo);
  const expectedX =
    process.env.FL100_ORACLE_COUNTERFACTUAL === "no-interior-key" ? 0 : 12;
  const rendered = await page.evaluate(
    (x) => window.fl100Editor.renderHero(15, x),
    expectedX,
  );
  assert.equal(rendered.pose.x, expectedX);
  assert.equal(rendered.pose.y, 0);
  assert.ok(rendered.maxDelta <= 1);
  assert.notEqual(rendered.digest, before.digest);
  // Independent linear segment from(-24,0) to(12,15): frame5 gives x=-12.
  const intermediate = await page.evaluate(() =>
    window.fl100Editor.renderHero(5, -12),
  );
  assert.equal(intermediate.pose.x, -12);
  assert.ok(intermediate.maxDelta <= 1);
  await page.shortcut("z");
  const undone = await page.evaluate(async () => ({
    state: window.fl100Editor.state(),
    render: await window.fl100Editor.renderHero(15, 0),
  }));
  assert.deepEqual(undone.state.keys, baseline.keys);
  assert.equal(undone.render.digest, before.digest);
  await page.shortcut("z", true);
  const redone = await page.evaluate(async () => ({
    state: window.fl100Editor.state(),
    render: await window.fl100Editor.renderHero(15, 12),
  }));
  assert.deepEqual(redone.state.keys, changed.keys);
  assert.equal(redone.render.digest, rendered.digest);
  // Move only the playhead to an unkeyed frame; auto-key was disabled by the blur click above.
  await page.evaluate(() => window.fl100Editor.setPlayhead(20));
  await page.waitForFunction(
    () =>
      !!document.querySelector(
        '[data-testid="dopesheet-scroll-area"] button[aria-label="Enable auto-key for Position"]',
      ),
  );
  const at20 = await page.evaluate(() => window.fl100Editor.renderHero(20, 16));
  await page.fill(input, "42");
  await page.click(
    '[data-testid="dopesheet-scroll-area"] input[aria-label="Position Y"]',
  );
  const manual = await page.evaluate(() => window.fl100Editor.state());
  assert.deepEqual(manual.keys, changed.keys);
  assert.equal(
    lane(manual).some((key) => key.frame === 20),
    false,
  );
  const manualRender = await page.evaluate(() =>
    window.fl100Editor.renderHero(20, 16),
  );
  assert.equal(manualRender.digest, at20.digest);
  // Real canonical timeline projection -> JSON bytes -> parsed data; no store rehydration here.
  const timeline = await page.evaluate(() => window.fl100Editor.timeline());
  const serialized = JSON.stringify(timeline);
  const roundtrip = JSON.parse(serialized);
  assert.equal(JSON.stringify(roundtrip), serialized);
  const storedSequence = roundtrip.compositions.find(
    (entry) => entry.id === "main-comp",
  );
  assert.ok(
    storedSequence,
    "canonical projection retains the active nested sequence",
  );
  assert.deepEqual(
    storedSequence.keyframes,
    JSON.parse(JSON.stringify(changed.keys)),
  );
  assert.equal(storedSequence.keyframes[0].animationVersion, 2);
  assert.equal(
    harness.observations.filter((entry) => entry.kind === "override").length,
    0,
  );
  const result = {
    browser,
    browserProvenance,
    userAgent: await page.evaluate(() => navigator.userAgent),
    measuredAt: new Date().toISOString(),
    passed: true,
    fixture: "FL100/auto-key-interior-vector",
    baseline,
    before,
    changed,
    rendered,
    intermediate,
    undone,
    redone,
    manual,
    manualRender,
    roundtrip,
    responseOverrides: 0,
    requests: harness.observations,
    backendProjectPersistence: "not-tested",
    roundtripScope: "canonical timeline JSON, not API/store reload",
  };
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, `${browser}-auto-key.json`),
      JSON.stringify(result, null, 2),
    );
    await writeFile(
      path.join(evidence, `${browser}-control.png`),
      Buffer.from(await page.screenshot(), "base64"),
    );
    for (const [label, render] of Object.entries({
      baseline: before,
      rendered,
      intermediate,
      undo: undone.render,
      redo: redone.render,
      manual: manualRender,
    }))
      await writeFile(
        path.join(evidence, `${browser}-${label}.png`),
        Buffer.from(render.png.split(",")[1], "base64"),
      );
  }
  console.log(
    JSON.stringify({
      browser,
      browserProvenance,
      passed: true,
      interiorFrame: 15,
      nativeUndoRedo: true,
      responseOverrides: 0,
      backendProjectPersistence: "not-tested",
    }),
  );
} finally {
  try {
    await driver?.close();
  } finally {
    await harness.close();
  }
}
