/** Native Motion Dopesheet hit regression. No linked Edit-axis/host/API qualification. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { admittedHostCapabilities } from "./lib/browser-driver.mjs";
import { openPage } from "./resource-admission.browser.mjs";
import { geometry, layoutSettled } from "./lib/dopesheet-geometry.mjs";

const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5199";
const browser = process.env.BROWSER ?? "chromium";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
admittedHostCapabilities(browser);
if (browser !== "chromium") assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
assert.ok(
  evidence,
  "STUDIO_TEST_EVIDENCE is required to retain pre-click failures",
);
await mkdir(evidence, { recursive: true });
const harness = createHarness({ upstream: origin });
const reports = [];
let driver;
let browserProvenance;

try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {browser, endpoint: process.env.WEBDRIVER_ENDPOINT});
  const page = driver.page;
  browserProvenance = driver.browser;
  await page.goto(`${origin}/studio-engine/test/boundary-hit.browser.html`);
  await page.waitForFunction(() => !!window.fl100Boundary);
  for (const test of [
    {
      name: "property-frame0",
      selector: '[data-testid="row-keyframe-x-k0"]',
      ids: ["k0"],
      width: 1200,
    },
    {
      name: "property-interior30",
      selector: '[data-testid="row-keyframe-x-k30"]',
      ids: ["k30"],
      width: 1200,
    },
    {
      name: "property-frame0-resized",
      selector: '[data-testid="row-keyframe-x-k0"]',
      ids: ["k0"],
      width: 900,
    },
    {
      name: "group-frame0",
      selector: '[data-testid="group-keyframe-transform-0"]',
      ids: ["k0"],
      // Decided (FL-100, October 2, 2026): Position shows as one combined X/Y row, but a
      // group-diamond click does not also select the Y proxy. The engine's behaviour is kept,
      // and the exact selection below asserts it.
      unselectedId: "k0:y",
      width: 1200,
      group: true,
      // Product auto-expands the group of the active property (use-group-expansion), which
      // unmounts the collapsed marker; measure the revealed frame-0 row marker instead.
      afterSelector: '[data-testid="row-keyframe-x-k0"]',
    },
  ]) {
    const report = { name: test.name, passed: false };
    reports.push(report);
    try {
      await page.evaluate(
        (width) => window.fl100Boundary.prepare(width),
        test.width,
      );
      if (test.group) {
        await layoutSettled(page);
        await page.click(
          '[data-testid="dopesheet-scroll-area"] button[aria-label="Collapse Transform"]',
        );
      }
      await page.waitForFunction(
        () =>
          !!document.querySelector(
            '[data-testid="row-keyframe-x-k0"], [data-testid="group-keyframe-transform-0"]',
          ),
      );
      await layoutSettled(page);
      report.before = await geometry(page, test.selector);
      report.stateBefore = await page.evaluate(() =>
        window.fl100Boundary.snapshot(),
      );
      // Persist the actual hit witness BEFORE the normal locator/WebDriver click.
      await writeFile(
        path.join(evidence, `${browser}-${test.name}-before.json`),
        JSON.stringify(report, null, 2),
      );
      await writeFile(
        path.join(evidence, `${browser}-${test.name}-before.png`),
        Buffer.from(await page.screenshot(), "base64"),
      );
      await page.click(test.selector); // No force, position, dispatched event or elementFromPoint override.
      await layoutSettled(page);
      report.after = await geometry(page, test.afterSelector ?? test.selector);
      report.stateAfter = await page.evaluate(() =>
        window.fl100Boundary.snapshot(),
      );
      assert.ok(
        report.before.centerHitsButton,
        "default button center belongs to the actual visible marker",
      );
      const selected = report.stateAfter.selection.map((r) => r.keyframeId);
      if (test.unselectedId) {
        report.unselected = {
          keyframeId: test.unselectedId,
          selected: selected.includes(test.unselectedId),
        };
        assert.equal(
          report.unselected.selected,
          false,
          "a group-diamond click does not select the Y proxy",
        );
      }
      assert.deepEqual([...selected].sort(), [...test.ids].sort());
      assert.ok(report.stateAfter.selection.every((r) => r.itemId === "hero"));
      assert.deepEqual(
        report.stateAfter.graph,
        report.stateBefore.graph,
        "selection does not edit graph",
      );
      assert.deepEqual(
        report.stateAfter.history,
        report.stateBefore.history,
        "selection adds no command",
      );
      if (test.afterSelector) {
        assert.ok(report.after.centerHitsButton, "revealed row marker is hit");
        assert.deepEqual(
          [report.after.button.x, report.after.frame, report.after.logicalAxis],
          [
            report.before.button.x,
            report.before.frame,
            report.before.logicalAxis,
          ],
          "revealed row marker keeps the group marker's x and logical axis",
        );
      } else {
        assert.deepEqual(
          report.after,
          report.before,
          "selection preserves logical axis/diamond/hit geometry",
        );
      }
      report.passed = true;
    } catch (error) {
      report.error = String(error);
      await writeFile(
        path.join(evidence, `${browser}-${test.name}-failure.png`),
        Buffer.from(await page.screenshot(), "base64"),
      );
    }
  }
  const drag = { name: "interior-native-retime-undo", passed: false };
  reports.push(drag);
  try {
    await page.evaluate(() => window.fl100Boundary.prepare());
    await layoutSettled(page);
    await page.click('[data-testid="row-keyframe-x-k30"]');
    drag.before = await geometry(page, '[data-testid="row-keyframe-x-k30"]');
    drag.frame0 = await geometry(page, '[data-testid="row-keyframe-x-k0"]');
    drag.stateBefore = await page.evaluate(() =>
      window.fl100Boundary.snapshot(),
    );
    const pixelsPerFrame =
      (drag.before.defaultCenter.x - drag.frame0.defaultCenter.x) / 30;
    assert.ok(pixelsPerFrame > 0);
    await writeFile(
      path.join(evidence, `${browser}-retime-before.json`),
      JSON.stringify(drag, null, 2),
    );
    await page.drag(drag.before.defaultCenter, {
      x: drag.before.defaultCenter.x - 3 * pixelsPerFrame,
      y: drag.before.defaultCenter.y,
    });
    drag.after = await geometry(page, '[data-testid="row-keyframe-x-k30"]');
    drag.stateAfter = await page.evaluate(() =>
      window.fl100Boundary.snapshot(),
    );
    assert.equal(
      drag.after.frame,
      27,
      "native drag moves exactly three frames on measured logical axis",
    );
    assert.notDeepEqual(drag.stateAfter.graph, drag.stateBefore.graph);
    assert.equal(drag.stateAfter.history.canUndo, true);
    await page.shortcut("z");
    drag.undone = await page.evaluate(() => window.fl100Boundary.snapshot());
    assert.deepEqual(
      drag.undone.graph,
      drag.stateBefore.graph,
      "native Undo restores exact graph",
    );
    assert.equal(drag.undone.history.canRedo, true);
    drag.passed = true;
  } catch (error) {
    drag.error = String(error);
    await writeFile(
      path.join(evidence, `${browser}-retime-failure.png`),
      Buffer.from(await page.screenshot(), "base64"),
    );
  }
  assert.equal(
    harness.observations.filter((r) => r.kind === "override").length,
    0,
  );
  assert.ok(
    reports.every((r) => r.passed),
    "native boundary selection regression; see retained per-case witnesses",
  );
} finally {
  try {
    await writeFile(
      path.join(evidence, `${browser}-boundary-hit.json`),
      JSON.stringify(
        {
          browser,
          browserProvenance,
          reports,
          requests: harness.observations,
          scope: "standalone Motion production Dopesheet selection only",
          unqualified: [
            "linked Edit axis",
            "right-visible endpoint",
            "pan/zoom/offscreen",
            "Svelte/API persistence",
            "Safari",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await driver?.close();
    } finally {
      await harness.close();
    }
  }
}
