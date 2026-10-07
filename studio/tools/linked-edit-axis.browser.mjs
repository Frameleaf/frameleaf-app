/**
 * Native keyframe hits on the linked Edit axis (FL-100): the production Edit timeline with its
 * docked keyframe panel, whose markers share the main timeline's scroll and zoom axis.
 *
 * Covers what boundary-hit.browser.mjs (standalone Motion panel) cannot: the frame-0 marker at the
 * left edge of the linked axis, a marker at the right-visible edge, and markers after a pan and a
 * zoom of the main timeline. Every expected position comes from the main timeline's own clip
 * element, never from the panel under test. Clicks are ordinary locator / WebDriver clicks: no
 * force, no position, no dispatched event. No host, API, Safari or render claim.
 *
 * Edge markers (decision of October 2, 2026; engine patch 0047). A marker on either edge of the
 * linked axis is centred on the edge. The lane used to clip it to 5 of its 12 pixels, with its
 * centre on the cell border (left) or the scrollbar strip (right), so linked-frame0 and
 * linked-right-endpoint were red. Edge markers now overflow the lane by half a marker, over the
 * property column on the left and the scrollbar strip on the right, and stay on their frame. Do
 * not relax these cases: every selected marker must be reachable across its whole width, and the
 * pixels just beyond it must still belong to its neighbours (the property column on the left
 * edge, the scrollbar on the right).
 *
 *   STUDIO_TEST_ORIGIN=http://127.0.0.1:<vite port of keyframe-browser.config.mjs> \
 *   STUDIO_TEST_EVIDENCE=<directory> [BROWSER=firefox WEBDRIVER_ENDPOINT=...] \
 *   node studio/tools/linked-edit-axis.browser.mjs
 */
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

const K0 = '[data-testid="row-keyframe-x-k0"]';
const K30 = '[data-testid="row-keyframe-x-k30"]';
const SHOW_PANEL = 'button[data-tooltip="Show keyframe panel"]';
// The linked cells keep a one-pixel left border, so a marker may sit one pixel off the main axis.
const AXIS_TOLERANCE_PX = 1;
// Longer than the panel's pan settle (90 ms) and the timeline's content zoom settle (200 ms).
const SETTLE_MS = 400;

/** Layout readiness only; never a hit-readiness wait. */
async function settled(page) {
  await layoutSettled(page);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  await page.waitForFunction(() => window.fl100Linked.mainAxis().zoomSettled);
  await layoutSettled(page);
}

/** Where the main timeline itself draws `frame` of the hero clip, in viewport pixels. */
const mainAxisX = (axis, frame) =>
  axis.heroClip.x + (frame / axis.heroFrames) * axis.heroClip.width;

async function measure(page, selector) {
  const marker = await geometry(page, selector);
  const axis = await page.evaluate(() => window.fl100Linked.mainAxis());
  return {
    marker,
    axis,
    expectedCenterX: mainAxisX(axis, marker.frame),
    axisDelta: marker.defaultCenter.x - mainAxisX(axis, marker.frame),
  };
}

const assertOnMainAxis = (measured, label) =>
  assert.ok(
    Math.abs(measured.axisDelta) <= AXIS_TOLERANCE_PX,
    `${label}: marker center ${measured.marker.defaultCenter.x} is not at the main timeline's ${measured.expectedCenterX}`,
  );

async function open(page, width) {
  await page.evaluate((width) => window.fl100Linked.prepare(width), width);
  await page.waitForFunction(
    () =>
      !!document.querySelector('button[data-tooltip="Show keyframe panel"]'),
  );
  await layoutSettled(page);
  await page.click(SHOW_PANEL); // The native toolbar toggle.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="row-keyframe-x-k30"]'),
  );
  await settled(page);
}

/**
 * One ordinary click on a marker, with the hit witness saved before it. `edge` names the lane
 * edge the marker is centred on, whose neighbour it must not cover beyond its own box.
 */
async function selectCase(page, report, selector, ids, edge) {
  report.before = await measure(page, selector);
  report.stateBefore = await page.evaluate(() => window.fl100Linked.snapshot());
  await writeFile(
    path.join(evidence, `${browser}-${report.name}-before.json`),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(evidence, `${browser}-${report.name}-before.png`),
    Buffer.from(await page.screenshot(), "base64"),
  );
  assertOnMainAxis(report.before, "before the click");
  await page.click(selector); // No force, position, dispatched event or elementFromPoint override.
  await settled(page);
  report.after = await measure(page, selector);
  report.stateAfter = await page.evaluate(() => window.fl100Linked.snapshot());
  assert.ok(
    report.before.marker.centerHitsButton,
    "default button center belongs to the actual visible marker",
  );
  const { reach } = report.before.marker;
  assert.ok(
    reach.insideLeft.hitsButton && reach.insideRight.hitsButton,
    "the marker is reachable across its whole width",
  );
  assert.ok(
    !reach.outsideLeft.hitsButton && !reach.outsideRight.hitsButton,
    "the marker takes no pointer input beyond its own box",
  );
  if (edge === "left") {
    assert.ok(
      !reach.outsideLeft.inSurface,
      "left of a frame-0 marker the property column keeps its own pixels",
    );
  }
  if (edge === "right") {
    assert.equal(
      reach.outsideRight.region,
      "dopesheet-scrollbar",
      "right of a last-frame marker the scrollbar keeps its own pixels",
    );
  }
  assert.deepEqual(
    report.stateAfter.selection.map((r) => r.keyframeId).sort(),
    [...ids].sort(),
  );
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
  assert.deepEqual(
    report.after.marker,
    report.before.marker,
    "selection preserves logical axis/diamond/hit geometry",
  );
}

const cases = [
  {
    // Both seeded keys sit where the main timeline draws their frames.
    name: "linked-axis-alignment",
    async run(page, report) {
      await open(page);
      report.k0 = await measure(page, K0);
      report.k30 = await measure(page, K30);
      assert.equal(report.k0.marker.frame, 0);
      assert.equal(report.k30.marker.frame, 30);
      assertOnMainAxis(report.k0, "frame 0");
      assertOnMainAxis(report.k30, "frame 30");
      // Linked: the panel reports the main viewport as its axis width.
      assert.equal(
        Number(report.k30.marker.logicalAxis.width),
        report.k30.axis.clientWidth,
      );
    },
  },
  {
    name: "linked-interior30",
    async run(page, report) {
      await open(page);
      await selectCase(page, report, K30, ["k30"]);
    },
  },
  {
    // The frame-0 marker is centred on the left edge of the linked axis.
    name: "linked-frame0",
    async run(page, report) {
      await open(page);
      await selectCase(page, report, K0, ["k0"], "left");
    },
  },
  {
    // A key exactly at the right-visible edge: the viewport is narrowed until frame 30 is its
    // last visible frame at the default zoom.
    name: "linked-right-endpoint",
    async run(page, report) {
      await open(page);
      const wide = await page.evaluate(() => window.fl100Linked.mainAxis());
      const chrome = 1200 - wide.clientWidth;
      const frame30Offset = (30 / wide.heroFrames) * wide.heroClip.width;
      await open(page, chrome + frame30Offset);
      report.arranged = await measure(page, K30);
      assert.ok(
        Math.abs(
          report.arranged.expectedCenterX -
            (report.arranged.axis.scroller.x +
              report.arranged.axis.clientWidth),
        ) <= AXIS_TOLERANCE_PX,
        "arrangement: frame 30 is the last visible frame of the main timeline",
      );
      await selectCase(page, report, K30, ["k30"], "right");
    },
  },
  {
    // After a pan the markers follow the main timeline, and a key panned out of view on the left
    // has no reachable hit area.
    name: "linked-pan",
    async run(page, report) {
      await open(page);
      await page.evaluate(() => window.fl100Linked.pan(40));
      await settled(page);
      report.k0 = await measure(page, K0);
      assert.equal(report.k0.axis.scrollLeft, 40, "the main timeline panned");
      assertOnMainAxis(report.k0, "frame 0 after the pan");
      assert.equal(
        report.k0.marker.visibleInClip.width,
        0,
        "a key panned out of view keeps no reachable hit area",
      );
      assert.equal(report.k0.marker.centerHitsButton, false);
      await selectCase(page, report, K30, ["k30"]);
      assert.equal(report.after.axis.scrollLeft, 40, "selection does not pan");
    },
  },
  {
    // After the native Zoom In control the markers follow the main timeline's new scale.
    name: "linked-zoom",
    async run(page, report) {
      await open(page);
      report.zoomBefore = await page.evaluate(() =>
        window.fl100Linked.mainAxis(),
      );
      await page.click('button[aria-label="Zoom In"]');
      await page.waitForFunction(
        () => window.fl100Linked.mainAxis().pixelsPerSecond > 100,
      );
      await settled(page);
      report.k0 = await measure(page, K0);
      assert.ok(
        report.k0.axis.heroClip.width > report.zoomBefore.heroClip.width,
        "the main timeline zoomed in",
      );
      assertOnMainAxis(report.k0, "frame 0 after the zoom");
      await selectCase(page, report, K30, ["k30"]);
    },
  },
  {
    // An ordinary pointer drag retimes by the main timeline's pixels per frame, and Undo restores.
    name: "linked-native-retime-undo",
    async run(page, report) {
      await open(page);
      await page.click(K30);
      await settled(page);
      report.before = await measure(page, K30);
      report.stateBefore = await page.evaluate(() =>
        window.fl100Linked.snapshot(),
      );
      const pixelsPerFrame =
        report.before.axis.heroClip.width / report.before.axis.heroFrames;
      const from = report.before.marker.defaultCenter;
      await page.drag(from, { x: from.x - 3 * pixelsPerFrame, y: from.y });
      await settled(page);
      report.after = await measure(page, K30);
      report.stateAfter = await page.evaluate(() =>
        window.fl100Linked.snapshot(),
      );
      assert.equal(
        report.after.marker.frame,
        27,
        "native drag moves exactly three frames on the main timeline's scale",
      );
      assertOnMainAxis(report.after, "frame 27 after the drag");
      assert.notDeepEqual(report.stateAfter.graph, report.stateBefore.graph);
      assert.equal(report.stateAfter.history.canUndo, true);
      await page.shortcut("z");
      report.undone = await page.evaluate(() => window.fl100Linked.snapshot());
      assert.deepEqual(
        report.undone.graph,
        report.stateBefore.graph,
        "native Undo restores exact graph",
      );
      assert.equal(report.undone.history.canRedo, true);
    },
  },
];

try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {browser, endpoint: process.env.WEBDRIVER_ENDPOINT});
  const page = driver.page;
  browserProvenance = driver.browser;
  await page.goto(`${origin}/studio-engine/test/linked-edit-axis.browser.html`);
  await page.waitForFunction(() => !!window.fl100Linked);
  for (const test of cases) {
    const report = { name: test.name, passed: false };
    reports.push(report);
    try {
      await test.run(page, report);
      report.passed = true;
    } catch (error) {
      report.error = String(error);
      await writeFile(
        path.join(evidence, `${browser}-${test.name}-failure.png`),
        Buffer.from(await page.screenshot(), "base64"),
      );
    }
    console.log(
      `${report.passed ? "PASS" : "FAIL"} ${test.name}${report.error ? `: ${report.error.split("\n")[0]}` : ""}`,
    );
  }
  assert.equal(
    harness.observations.filter((r) => r.kind === "override").length,
    0,
  );
  assert.ok(
    reports.every((r) => r.passed),
    "linked Edit-axis keyframe hit regression; see retained per-case witnesses",
  );
} finally {
  try {
    await writeFile(
      path.join(evidence, `${browser}-linked-edit-axis.json`),
      JSON.stringify(
        {
          browser,
          browserProvenance,
          reports,
          requests: harness.observations,
          scope:
            "production Edit timeline with its docked keyframe panel: property-row markers only",
          unqualified: [
            "group markers on the linked axis",
            "wheel and pinch input (the pan is a scroll position)",
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
