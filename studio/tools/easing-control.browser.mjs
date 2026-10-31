/** Native production easing control -> timeline history -> independently expected rendered frames.
 * This fixture does not claim Svelte/API persistence or whole-row/browser acceptance.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { admittedHostCapabilities } from "./lib/browser-driver.mjs";
import { openPage } from "./resource-admission.browser.mjs";

const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5194";
const browser = process.env.BROWSER ?? "chromium";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
admittedHostCapabilities(browser);
if (browser !== "chromium") assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
// Independent CSS Ease In cubic curve: solve x(t)=0.5, then y(t), without engine easing code.
const cubic = (t, a, b) =>
  3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
let lo = 0,
  hi = 1;
for (let i = 0; i < 60; i++) {
  const t = (lo + hi) / 2;
  if (cubic(t, 0.42, 1) < 0.5) lo = t;
  else hi = t;
}
const expectedX = -24 + 48 * cubic((lo + hi) / 2, 0, 1);
const harness = createHarness({ upstream: origin });
let driver;
try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {browser, endpoint: process.env.WEBDRIVER_ENDPOINT});
  const page = driver.page;
  const browserProvenance = driver.browser;
  await page.goto(`${origin}/studio-engine/test/editor-controls.browser.html`);
  await page.waitForFunction(() => !!window.fl100Editor);
  await page.evaluate(() => window.fl100Editor.seedEasing());
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="row-keyframe-x-k0"]'),
  );
  await page.click('[data-testid="row-keyframe-x-k0"]');
  const baseline = await page.evaluate(async () =>
    window.fl100Editor.renderHero(15, 0),
  );
  assert.equal(baseline.pose.x, 0);
  assert.equal(baseline.pose.y, 0);
  assert.equal(baseline.maxDelta, 0);
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll("button")].map((b) => ({
      label: b.getAttribute("aria-label"),
      disabled: b.disabled,
    })),
  );
  const easeIn = buttons.find((b) =>
    /set interpolation to ease in$/i.test(b.label ?? ""),
  );
  assert.ok(
    easeIn && !easeIn.disabled,
    "native Ease In button enabled after marker selection",
  );
  await page.click(`button[aria-label=${JSON.stringify(easeIn.label)}]`);
  const changed = await page.evaluate(() => window.fl100Editor.state());
  assert.equal(
    changed.keys[0].vectorProperties.find((p) => p.property === "position")
      .keyframes[0].easing,
    "ease-in",
  );
  assert.ok(
    changed.canUndo,
    "real timeline command history records native control",
  );
  // Deliberately wrong linear expectation proves oracle independence, not an old engine defect.
  const oracleX =
    process.env.FL100_ORACLE_COUNTERFACTUAL === "linear-ease-in"
      ? 0
      : expectedX;
  const rendered = await page.evaluate(
    async (x) => window.fl100Editor.renderHero(15, x),
    oracleX,
  );
  assert.ok(
    Math.abs(rendered.pose.x - oracleX) < 1e-5,
    `independent Ease In pose: ${rendered.pose.x} vs ${oracleX}`,
  );
  assert.ok(
    rendered.maxDelta <= 1,
    `independent rectangle pixels: ${rendered.maxDelta}`,
  );
  assert.notEqual(rendered.digest, baseline.digest);
  await page.shortcut("z");
  const undone = await page.evaluate(async () => ({
    state: window.fl100Editor.state(),
    render: await window.fl100Editor.renderHero(15, 0),
  }));
  assert.equal(
    undone.state.keys[0].vectorProperties.find((p) => p.property === "position")
      .keyframes[0].easing,
    "linear",
  );
  assert.equal(undone.render.digest, baseline.digest);
  await page.shortcut("z", true);
  const redone = await page.evaluate(
    async (x) => ({
      state: window.fl100Editor.state(),
      render: await window.fl100Editor.renderHero(15, x),
    }),
    expectedX,
  );
  assert.equal(
    redone.state.keys[0].vectorProperties.find((p) => p.property === "position")
      .keyframes[0].easing,
    "ease-in",
  );
  assert.equal(redone.render.digest, rendered.digest);
  assert.equal(
    harness.observations.filter((item) => item.kind === "override").length,
    0,
  );
  const result = {
    browser,
    browserProvenance,
    userAgent: await page.evaluate(() => navigator.userAgent),
    measuredAt: new Date().toISOString(),
    passed: true,
    fixture: "readme.keyframe-animation.2/ease-in",
    frame: 15,
    expectedX,
    baseline,
    changed,
    rendered,
    undone,
    redone,
    responseOverrides: 0,
    requests: harness.observations,
    backendProjectPersistence: "not-tested",
  };
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, `${browser}-easing.json`),
      JSON.stringify(result, null, 2),
    );
    await writeFile(
      path.join(evidence, `${browser}-control.png`),
      Buffer.from(await page.screenshot(), "base64"),
    );
    for (const [label, render] of Object.entries({
      baseline,
      rendered,
      undo: undone.render,
      redo: redone.render,
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
      expectedX,
      actualX: rendered.pose.x,
      maxDelta: rendered.maxDelta,
      nativeUndoRedo: true,
      responseOverrides: 0,
    }),
  );
} finally {
  try {
    await driver?.close();
  } finally {
    await harness.close();
  }
}
