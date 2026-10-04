/**
 * DOM player versus rendered preview canvas at an image edge (FL-100), on real Chromium pixels.
 *
 * The preview shows a frame two ways: the DOM player (a native IMG under the player's scale) and
 * the rendered canvas (the frame rasterised at project resolution, then scaled). Both must put an
 * item's edge in the same place. This compares full screenshots of both, every channel, for a
 * still whose edge falls at several fractional display positions, at device pixel ratio 1 and 2.
 *
 * - "production" is the engine's own canvas placement (patch 0046: a transform). At device pixel
 *   ratio 1 it must be identical to the DOM player in every case.
 * - "layout-box" is the left/top/width/height box used before patch 0046, which the browser snaps
 *   to whole device pixels. It is the counterfactual: it must still differ, or this test could
 *   not see the defect.
 * - In every case the project raster and the centre of the display canvas are exact, and any
 *   difference stays within one device pixel of the edge: presentation only, never a wrong
 *   engine pixel.
 *
 * Device pixel ratio 2 is measured and reported, not required to be identical: there the browser
 * rasterises the DOM player at twice the project resolution while the rendered canvas keeps
 * project resolution, so an edge is filtered differently whatever the placement.
 *
 * Decision (FL-100, October 2, 2026): at device pixel ratio 2 the preview canvas stays at
 * project resolution. Rendering it at device resolution would cost four times the pixels per
 * frame, so the difference in the edge pixel is accepted there. Do not raise the preview render
 * size to close it. The checks below still hold at ratio 2: the canvas centre is the project
 * raster and any difference stays within one device pixel of the edge.
 *
 *   STUDIO_TEST_ORIGIN=http://127.0.0.1:<vite port of keyframe-browser.config.mjs> \
 *   STUDIO_TEST_EVIDENCE=<directory> node studio/tools/edge-parity.browser.mjs
 *
 * Chromium only: no Firefox, Safari, GPU-effects canvas or host (Svelte) claim.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { createChromiumDriver } from "./lib/browser-driver.mjs";

const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5197";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
assert.ok(
  evidence,
  "STUDIO_TEST_EVIDENCE is required to preserve actual RED diagnostics",
);
const VIEWPORT = { width: 752, height: 423 };
// Authored x of a 1280x720 still in a 1280x720 project shown at 752x423 (scale 0.5875): the
// left edge lands at x * 0.5875 CSS pixels; a negative x brings the right edge into view.
const OFFSETS = [12, 11, 13, 20, 37.5, -12];
const PLACEMENTS = ["production", "layout-box"];
const DEVICE_PIXEL_RATIOS = [1, 2];

/** Decodes the actual screenshot in the page and compares the two viewports, every channel. */
function compareViewports(page, screenshot, rects, size, edgeColumns) {
  return page.evaluate(
    async ({ screenshot, rects, width, height, edgeColumns }) => {
      const bytes = Uint8Array.from(atob(screenshot), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
        { colorSpaceConversion: "none", premultiplyAlpha: "none" },
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const read = (rect) =>
        ctx.getImageData(rect.x, rect.y, width, height).data;
      const dom = read(rects.dom);
      const rendered = read(rects.rendered);
      let differentChannelValues = 0;
      let maximumDelta = 0;
      const columns = {};
      for (let index = 0; index < dom.length; index++) {
        const delta = Math.abs(dom[index] - rendered[index]);
        if (!delta) continue;
        differentChannelValues++;
        maximumDelta = Math.max(maximumDelta, delta);
        const x = Math.floor(index / 4) % width;
        columns[x] = (columns[x] ?? 0) + 1;
      }
      // The red channel of both presentations around each edge, whether or not they differ.
      const row = Math.floor(height / 2);
      const edges = edgeColumns.map((column) =>
        [column - 1, column, column + 1]
          .filter((x) => x >= 0 && x < width)
          .map((x) => {
            const at = (row * width + x) * 4;
            return { x, dom: dom[at], rendered: rendered[at] };
          }),
      );
      return { differentChannelValues, maximumDelta, columns, edges };
    },
    { screenshot, rects, ...size, edgeColumns },
  );
}

/** Channels of the display canvas centre that differ from the project raster (padding excluded). */
function compareRasters(project, display) {
  const a = Buffer.from(project.rgbaBase64, "base64");
  const b = Buffer.from(display.rgbaBase64, "base64");
  const padX = (display.width - project.width) / 2;
  const padY = (display.height - project.height) / 2;
  let different = 0;
  for (let y = 0; y < project.height; y++) {
    const from = ((y + padY) * display.width + padX) * 4;
    const row = b.subarray(from, from + project.width * 4);
    const expected = a.subarray(
      y * project.width * 4,
      (y + 1) * project.width * 4,
    );
    if (row.equals(expected)) continue;
    for (let i = 0; i < row.length; i++)
      different += Number(row[i] !== expected[i]);
  }
  return different;
}

const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const harness = createHarness({ upstream: origin });
const harnessOrigin = await harness.listen();
await mkdir(evidence, { recursive: true });
const results = [];
try {
  for (const deviceScaleFactor of DEVICE_PIXEL_RATIOS) {
    const driver = await createChromiumDriver({
      harnessOrigin,
      chromium: require("playwright").chromium,
      contextOptions: {
        viewport: { width: 1000, height: 1000 },
        deviceScaleFactor,
      },
    });
    try {
      for (const placement of PLACEMENTS) {
        for (const x of OFFSETS) {
          const name = `${placement}-dpr${deviceScaleFactor}-x${x}`;
          const page = await driver.newPage();
          const result = { name, placement, deviceScaleFactor, x };
          results.push(result);
          try {
            await page.goto(
              `${origin}/studio-engine/test/edge-parity.browser.html?x=${x}&placement=${placement}`,
            );
            await page.waitForFunction(() => window.fl100EdgeParity?.ready());
            const diagnostics = await page.evaluate(() =>
              window.fl100EdgeParity.capture(),
            );
            assert.equal(diagnostics.devicePixelRatio, deviceScaleFactor);
            assert.equal(diagnostics.frame, 15);
            assert.equal(diagnostics.mapping.placement, placement);
            const rects = {};
            for (const label of ["dom", "rendered"]) {
              const rect = diagnostics[label].rect;
              assert.deepEqual([rect.width, rect.height], [752, 423]);
              assert.ok(
                Number.isInteger(rect.x) && Number.isInteger(rect.y),
                "Capture origin must be integral",
              );
              rects[label] = {
                x: rect.x * deviceScaleFactor,
                y: rect.y * deviceScaleFactor,
              };
            }
            // The device-pixel columns that contain an edge of the still.
            const edgeColumns = [x, x + 1280]
              .map((edge) => edge * diagnostics.mapping.scale)
              .filter((edge) => edge > 0 && edge < VIEWPORT.width)
              .map((edge) => Math.floor(edge * deviceScaleFactor));
            const screenshot = await page.screenshot();
            await writeFile(
              path.join(evidence, `${name}.png`),
              Buffer.from(screenshot, "base64"),
            );
            Object.assign(
              result,
              await compareViewports(
                page,
                screenshot,
                rects,
                {
                  width: VIEWPORT.width * deviceScaleFactor,
                  height: VIEWPORT.height * deviceScaleFactor,
                },
                edgeColumns,
              ),
              {
                rasterCentreDifferentChannels: compareRasters(
                  diagnostics.project,
                  diagnostics.displayPixels,
                ),
                edgeColumns,
                canvas: diagnostics.display,
                image: diagnostics.imageAncestors[0].rect,
              },
            );
          } catch (error) {
            result.error = String(error);
          } finally {
            await page
              .evaluate(() => window.fl100EdgeParity?.dispose())
              .catch(() => {});
            await page.close();
          }
          console.log(
            `${name}: ${result.error ?? `${result.differentChannelValues} differing channel values, max ${result.maximumDelta}, columns ${JSON.stringify(result.columns)}, red at edges ${JSON.stringify(result.edges)}`}`,
          );
        }
      }
    } finally {
      await driver.close();
    }
  }
  await writeFile(
    path.join(evidence, "edge-parity.json"),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        results,
        requests: harness.observations,
        bindingScope:
          "source-served prepared engine; not execution of a built adapter",
      },
      null,
      2,
    ),
  );
  assert.equal(
    harness.observations.filter((entry) => entry.kind === "override").length,
    0,
  );
  for (const result of results) {
    assert.equal(result.error, undefined, `${result.name}: ${result.error}`);
    assert.equal(
      result.rasterCentreDifferentChannels,
      0,
      `${result.name}: the display canvas centre is the project raster`,
    );
    for (const column of Object.keys(result.columns).map(Number)) {
      assert.ok(
        result.edgeColumns.some((edge) => Math.abs(edge - column) <= 1),
        `${result.name}: difference away from the edge, at column ${column}`,
      );
    }
    if (result.placement === "production" && result.deviceScaleFactor === 1) {
      assert.equal(
        result.differentChannelValues,
        0,
        `${result.name}: DOM player and rendered preview screenshots differ`,
      );
    }
  }
  for (const deviceScaleFactor of DEVICE_PIXEL_RATIOS) {
    assert.ok(
      results.some(
        (result) =>
          result.placement === "layout-box" &&
          result.deviceScaleFactor === deviceScaleFactor &&
          result.differentChannelValues > 0,
      ),
      `the snapped layout box no longer differs at device pixel ratio ${deviceScaleFactor}: the counterfactual is gone`,
    );
  }
  const worst = (placement, deviceScaleFactor) =>
    Math.max(
      ...results
        .filter(
          (result) =>
            result.placement === placement &&
            result.deviceScaleFactor === deviceScaleFactor,
        )
        .map((result) => result.maximumDelta),
    );
  console.log(
    `Edge parity at device pixel ratio 1: production identical to the DOM player at all ${OFFSETS.length} offsets (snapped layout box: up to ${worst("layout-box", 1)} levels).`,
  );
  console.log(
    `Device pixel ratio 2, reported only: production up to ${worst("production", 2)} levels in the edge pixel, snapped layout box up to ${worst("layout-box", 2)}.`,
  );
} finally {
  await harness.close();
}
