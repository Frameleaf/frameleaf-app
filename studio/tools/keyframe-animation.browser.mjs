/** FL100: real prepared engine, no substituted HTML, media, network or pixel results.
 * Start vp dev --config test/keyframe-browser.config.mjs from studio/adapters/web.
 * STUDIO_TEST_ORIGIN=http://127.0.0.1:5190 node studio/tools/keyframe-animation.browser.mjs
 * BROWSER=firefox WEBDRIVER_ENDPOINT=http://127.0.0.1:4593 uses installed Firefox/geckodriver.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { createChromiumDriver, createWebDriverClassicDriver } from "./lib/browser-driver.mjs";

const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5190";
const browserName = process.env.BROWSER ?? "chromium";
assert.ok(
  ["chromium", "firefox"].includes(browserName),
  "This packet qualifies Chromium/Firefox only",
);
const evidence = process.env.STUDIO_TEST_EVIDENCE;
// Optional fixture counterfactuals prove that the independent witnesses catch lost semantics.
// These mutate only the supplied test graph, never the engine or network results.
const mutation = process.env.STUDIO_TEST_MUTATION;
assert.ok(
  !mutation ||
    [
      "no-expression",
      "no-character-motion",
      "no-word-motion",
      "no-line-motion",
      "word-as-character",
      "line-as-character",
      "no-instance-override",
      "no-baked-keys",
    ].includes(mutation),
);
const harness = createHarness({ upstream: origin });
const harnessOrigin = await harness.listen();
let driver;
try {
  if (browserName === "chromium") {
    const require = createRequire(new URL("../engine/package.json", import.meta.url));
    driver = await createChromiumDriver({
      harnessOrigin,
      chromium: require("playwright").chromium,
    });
  } else {
    assert.ok(process.env.WEBDRIVER_ENDPOINT, "Firefox requires its real WebDriver endpoint");
    driver = await createWebDriverClassicDriver({
      endpoint: process.env.WEBDRIVER_ENDPOINT,
      harnessOrigin,
      capabilities: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: process.env.FIREFOX_BINARY ?? "/Applications/Firefox.app/Contents/MacOS/firefox",
          args: ["-headless"],
          prefs: { "network.proxy.allow_hijacking_localhost": true },
        },
      },
    });
  }
  const page = await driver.newPage();
  await page.goto(`${origin}/studio-engine/test/keyframe-render.browser.html`);
  await page.waitForFunction(() => !!window.fl100Fixtures);
  const frames = await page.evaluate(
    async (mutation) => window.fl100Fixtures.run(mutation),
    mutation,
  );
  assert.equal(frames.length, 71);
  const controls = [];
  for (const mode of ["dopesheet", "graph", "split"]) {
    await page.evaluate((mode) => window.fl100Fixtures.mountControls(mode), mode);
    await page.waitForFunction(() => !!document.querySelector('[data-testid="dopesheet-ruler"]'));
    const state = await page.evaluate(() => ({
      sheet: !!document.querySelector('[data-testid="dopesheet-playhead-clip"]'),
      graph: !!document.querySelector('[data-testid="dopesheet-graph-pane"]'),
      rulers: document.querySelectorAll('[data-testid="dopesheet-ruler"]').length,
    }));
    assert.deepEqual(state, { sheet: mode !== "graph", graph: mode !== "dopesheet", rulers: 1 });
    controls.push({ mode, ...state });
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        path.join(evidence, `${browserName}-controls-${mode}.png`),
        Buffer.from(await page.screenshot(), "base64"),
      );
    }
  }
  await page.evaluate(() => window.fl100Fixtures.mountControls("graph"));
  await page.waitForFunction(
    () => !!document.querySelector('.graph-handles .bezier-handle circle[r="12"]'),
  );
  const handle = await page.evaluate(() => {
    const r = document
      .querySelector('.graph-handles .bezier-handle circle[r="12"]')
      .getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.drag(handle, { x: handle.x + 20, y: handle.y - 15 });
  const tangent = await page.evaluate(() => window.fl100Fixtures.getControlState().bezierMoves);
  assert.ok(
    tangent.some(
      ({ bezier }) =>
        Number.isFinite(bezier.x1) &&
        Number.isFinite(bezier.y1) &&
        (Math.abs(bezier.x1 - 0.25) > 0.001 || Math.abs(bezier.y1 - 0.25) > 0.001),
    ),
    JSON.stringify(tangent),
  );
  await page.evaluate(() => window.fl100Fixtures.mountControls("dopesheet"));
  const marquee = await page.evaluate(() => {
    const markers = [...document.querySelectorAll("[data-motion-keyframe-id]")].map((e) =>
      e.getBoundingClientRect(),
    );
    return {
      from: {
        x: Math.min(...markers.map((r) => r.left)) - 2,
        y: Math.min(...markers.map((r) => r.top)) - 8,
      },
      to: {
        x: Math.max(...markers.map((r) => r.right)) + 8,
        y: Math.max(...markers.map((r) => r.bottom)) + 8,
      },
    };
  });
  await page.drag(marquee.from, marquee.to);
  const selections = await page.evaluate(() => window.fl100Fixtures.getControlState().selections);
  assert.ok(
    selections.some((ids) => ids.join(",") === "k0,k30"),
    JSON.stringify(selections),
  );
  controls.push({ tangent, selections });
  await page.click('button[aria-label="Set interpolation to Bezier"]');
  assert.equal(
    await page.evaluate(() => window.fl100Fixtures.getControlState().interpolation),
    "cubic-bezier",
  );
  await page.click('button[aria-label="Enable auto-key for X Position"]');
  await page.waitForFunction(() => window.fl100Fixtures.getControlState().autoKey);
  const input = 'input[aria-label="X Position value at playhead"]';
  await page.fill(input, "42");
  await page.click('button[aria-label="Set interpolation to Bezier"]');
  const keyed = await page.evaluate(() => window.fl100Fixtures.getControlState());
  assert.ok(
    keyed.commits.some(
      (entry) =>
        entry.property === "x" && entry.value === 42 && entry.options?.allowCreate === true,
    ),
    JSON.stringify(keyed),
  );
  await page.click('button[aria-label="Auto-key enabled for X Position"]');
  await page.waitForFunction(() => !window.fl100Fixtures.getControlState().autoKey);
  await page.fill(input, "43");
  await page.click('button[aria-label="Set interpolation to Bezier"]');
  const manual = await page.evaluate(() => window.fl100Fixtures.getControlState());
  assert.ok(
    manual.commits.some(
      (entry) =>
        entry.property === "x" && entry.value === 43 && entry.options?.allowCreate === false,
    ),
    JSON.stringify(manual),
  );
  controls.push({
    interpolation: keyed.interpolation,
    autoKeyOn: keyed.autoKey,
    autoKeyOff: manual.autoKey,
    commits: manual.commits,
  });
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    offscreenCanvas: typeof OffscreenCanvas === "function",
  }));
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    for (const frame of frames) {
      await writeFile(
        path.join(evidence, `${browserName}-${frame.name}-${frame.frame}.png`),
        Buffer.from(frame.png.split(",")[1], "base64"),
      );
    }
    await writeFile(
      path.join(evidence, `${browserName}.json`),
      JSON.stringify(
        {
          environment,
          frames: frames.map(({ png: _png, ...frame }) => frame),
          controls,
          requests: harness.observations,
        },
        null,
        2,
      ),
    );
  }
  assert.equal(harness.observations.filter((request) => request.kind === "override").length, 0);
  console.log(
    JSON.stringify({
      browser: browserName,
      environment,
      renderedFrames: frames.length,
      controls,
      substitutedRequests: 0,
      blockedExternalRequests: harness.observations.filter((request) => request.kind === "blocked")
        .length,
    }),
  );
} finally {
  try {
    await driver?.close();
  } finally {
    await harness.close();
  }
}
