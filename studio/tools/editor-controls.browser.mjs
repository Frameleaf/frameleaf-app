/** Real component/store/history/browser-preference checks. No backend persistence claim. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { admittedHostCapabilities } from "./lib/browser-driver.mjs";
import { openPage } from "./resource-admission.browser.mjs";
const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5191";
const browser = process.env.BROWSER ?? "chromium";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
// Deliberately wrong fixture input verifies the independent expected-pose assertion.
const parentDx =
  process.env.FL100_ORACLE_COUNTERFACTUAL === "stationary-parent" ? 0 : 16;
admittedHostCapabilities(browser);
if (browser !== "chromium") assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
const harness = createHarness({ upstream: origin });
let driver;
const witnesses = [];
try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {browser, endpoint: process.env.WEBDRIVER_ENDPOINT});
  const page = driver.page;
  const browserProvenance = driver.browser;
  const url = `${origin}/studio-engine/test/editor-controls.browser.html`;
  await page.goto(url);
  await page.waitForFunction(() => !!window.fl100Editor);
  const baseline = await page.evaluate(async () =>
    window.fl100Editor.renderHero(),
  );
  assert.equal(baseline.pose.x, 0);
  assert.equal(baseline.maxDelta, 0);
  for (const parentId of ["null", "group-instance"]) {
    await page.evaluate(() => window.fl100Editor.mount("compose", true));
    const coords = await page.evaluate((parentId) => {
      const from = document
        .querySelector(
          'button[aria-label="Parent pick whip for Hero rectangle"]',
        )
        .getBoundingClientRect();
      const to = document
        .querySelector(`[data-testid="motion-layer-row-${parentId}"]`)
        .getBoundingClientRect();
      return {
        from: { x: from.x + from.width / 2, y: from.y + from.height / 2 },
        to: { x: to.x + to.width / 2, y: to.y + to.height / 2 },
      };
    }, parentId);
    await page.drag(coords.from, coords.to);
    const assigned = await page.evaluate(() => window.fl100Editor.state());
    assert.equal(
      assigned.items.find((item) => item.id === "hero").transformParent
        ?.parentItemId,
      parentId,
    );
    assert.equal(
      (await page.evaluate(async () => window.fl100Editor.renderHero())).digest,
      baseline.digest,
      "parenting preserves world pixels",
    );
    await page.shortcut("z");
    assert.equal(
      (await page.evaluate(() => window.fl100Editor.state())).items.find(
        (item) => item.id === "hero",
      ).transformParent,
      undefined,
    );
    await page.shortcut("z", true);
    assert.equal(
      (await page.evaluate(() => window.fl100Editor.state())).items.find(
        (item) => item.id === "hero",
      ).transformParent?.parentItemId,
      parentId,
    );
    await page.evaluate(
      ({ parentId, dx }) => window.fl100Editor.moveParent(parentId, dx),
      { parentId, dx: parentDx },
    );
    const moved = await page.evaluate(async () =>
      window.fl100Editor.renderHero(),
    );
    assert.equal(
      moved.pose.x,
      16,
      "actual hierarchy follows a parent translated sixteen pixels",
    );
    assert.equal(moved.pose.y, 0);
    assert.equal(moved.maxDelta, 0);
    assert.notEqual(moved.digest, baseline.digest);
    witnesses.push({
      parentId,
      assigned: assigned.items,
      baseline,
      moved,
      nativeUndoRedo: true,
    });
  }
  await page.evaluate(() => {
    window.fl100Editor.mount("compose", true);
    window.fl100Editor.selectLayers();
  });
  await page.click(
    'button[aria-label="Create Layer Group from selected layers"]',
  );
  const grouped = await page.evaluate(() => window.fl100Editor.state());
  const groupTrack = grouped.tracks.find((track) => track.isGroup);
  assert.ok(groupTrack);
  assert.ok(
    grouped.tracks
      .filter((track) => ["hero-track", "null-track"].includes(track.id))
      .every((track) => track.parentTrackId === groupTrack.id),
  );
  witnesses.push({
    layerGroup: groupTrack.id,
    childTracks: grouped.tracks,
    realLayerGroupButton: true,
  });
  await page.evaluate(() => window.fl100Editor.mount("animate"));
  for (const mode of ["dopesheet", "graph", "split"]) {
    const selector =
      mode === "split"
        ? '[role="tab"][aria-label="Split"]'
        : `[role="tab"][aria-label^="${mode === "graph" ? "Graph" : "Sheet"} —"]`;
    await page.click(selector);
    await page.waitForFunction(
      () => !!document.querySelector('[role="tab"][aria-selected="true"]'),
    );
    const selected = await page.evaluate(() => ({
      label: document
        .querySelector('[role="tab"][aria-selected="true"]')
        .textContent.trim(),
      saved: window.fl100Editor.state().mode,
    }));
    assert.equal(selected.saved, mode);
    witnesses.push({ mode, selected });
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        path.join(evidence, `${browser}-actual-mode-${mode}.png`),
        Buffer.from(await page.screenshot(), "base64"),
      );
    }
  }
  await page.goto(url);
  await page.waitForFunction(() => !!window.fl100Editor);
  await page.evaluate(() => window.fl100Editor.mount("animate"));
  const restored = await page.evaluate(() => ({
    selected: document
      .querySelector('[role="tab"][aria-selected="true"]')
      .textContent.trim(),
    saved: window.fl100Editor.state().mode,
  }));
  assert.deepEqual(restored, { selected: "Split", saved: "split" });
  witnesses.push({ preferenceRestoredAfterNavigation: restored });
  assert.equal(
    harness.observations.filter((item) => item.kind === "override").length,
    0,
  );
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, `${browser}-editor.json`),
      JSON.stringify({ browserProvenance, witnesses, requests: harness.observations }, null, 2),
    );
  }
  console.log(
    JSON.stringify({
      browser,
      browserProvenance,
      passed: true,
      parentTargets: ["null", "composition-group"],
      nativeUndoRedo: true,
      layerGrouping: true,
      actualModePickerAndBrowserPreferenceReload: true,
      backendProjectPersistence: "not-tested",
      witnesses,
    }),
  );
} finally {
  try {
    await driver?.close();
  } finally {
    await harness.close();
  }
}
