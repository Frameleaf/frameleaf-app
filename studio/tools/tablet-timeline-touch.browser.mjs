/** Chromium trusted touch → production timeline tools/history; OPFS roundtrip only, no host authority claim. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { inventory } from "./engine.mjs";
import { createHarness } from "./lib/cross-browser-harness.mjs";
const engineDirectory = new URL("../engine/", import.meta.url).pathname;
const source = JSON.parse(
  await readFile(
    new URL("../engine/frameleaf-source.json", import.meta.url),
    "utf8",
  ),
);
const configuration = JSON.parse(
  await readFile(new URL("../engine-build.json", import.meta.url), "utf8"),
);
assert.equal(source.sourceSha256, configuration.sourceSha256);
assert.deepEqual(
  await inventory(
    engineDirectory,
    "",
    new Set([
      "node_modules",
      "dist",
      "frameleaf-source.json",
      "frameleaf-build.json",
    ]),
  ),
  source.files,
);
const sourceBinding = {
  sourceSha256: source.sourceSha256,
  patches: source.patches.length,
  files: source.files.length,
  upstreamCommit: source.upstreamCommit,
};
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5299";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const evidence = process.env.STUDIO_TEST_EVIDENCE;
assert(
  evidence,
  "STUDIO_TEST_EVIDENCE must identify an owned evidence directory",
);
const mutation = process.env.STUDIO_TEST_MUTATION;
assert(
  !mutation ||
    ["missing-touch-hook", "corrupt-retained-history"].includes(mutation),
);
const harness = createHarness({ upstream: origin, inspectConnect: true });
let browser;
let page;
let cleanupFailure;
const projectId = `fl94-touch-${randomUUID()}`;
const witness = {
  mutation: mutation ?? null,
  sourceBinding,
  projectId,
  viewport: { width: 1024, height: 768 },
};
// Compare the complete serialized edit graph, excluding only the documented view state.
const editContent = (timeline) => {
  const {
    currentFrame: _currentFrame,
    zoomLevel: _zoomLevel,
    scrollPosition: _scrollPosition,
    ...content
  } = timeline;
  return JSON.parse(JSON.stringify(content));
};
try {
  await mkdir(evidence, { recursive: true });
  const proxy = await harness.listen();
  browser = await chromium.launch({
    headless: true,
    proxy: { server: proxy },
    args: ["--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext({
    viewport: witness.viewport,
    hasTouch: true,
    isMobile: false,
    serviceWorkers: "block",
  });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const url = `${origin}/studio-engine/test/editor-controls.browser.html`;
  await page.goto(url);
  await page.waitForFunction(() => !!window.fl100Editor);
  await page.evaluate(
    (id) => window.fl100Editor.prepareTouchTimeline(id),
    projectId,
  );
  await page.waitForFunction(() => window.fl100Editor.touchReady());
  if (mutation === "missing-touch-hook")
    await page.evaluate(() => window.fl100Editor.disableTouchForControl());
  await page.evaluate(() => {
    window.fl94TouchEvents = [];
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
    ]) {
      window.addEventListener(
        type,
        (event) => {
          if (event.pointerType !== "touch") return;
          window.fl94TouchEvents.push({
            type: event.type,
            trusted: event.isTrusted,
            pointerType: event.pointerType,
            itemId: event.target
              .closest?.("[data-timeline-item]")
              ?.getAttribute("data-item-id"),
          });
        },
        { capture: true },
      );
    }
  });
  const state = () => page.evaluate(() => window.fl100Editor.state());
  const timeline = () => page.evaluate(() => window.fl100Editor.timeline());
  const clip = page.locator('[data-timeline-item][data-item-id="tablet-v"]');
  await clip.waitFor({ state: "visible" });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const beginDrag = async () => {
    const box = await clip.boundingBox();
    assert(
      box && box.width > 0 && box.height > 0,
      "real clip must have geometry",
    );
    // Interior hit avoids trim/fade handles. Sixty frames determine the actual scale.
    const start = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      id: 1,
    };
    const dx = (box.width * 12) / 60;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await settle();
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...start, x: start.x + (dx * step) / 8 }],
      });
      await settle();
    }
    return { start, dx, beforeBox: box, movingBox: await clip.boundingBox() };
  };
  witness.initial = await state();
  witness.initialContent = editContent(await timeline());
  assert.equal(witness.initial.items.length, 2);
  assert(witness.initial.items.every((item) => item.from === 30));
  witness.editGesture = await beginDrag();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForFunction(() =>
    window.fl100Editor.state().items.every((item) => item.from === 42),
  );
  witness.edited = await state();
  assert.deepEqual(
    witness.edited.items,
    witness.initial.items.map((item) => ({ ...item, from: 42 })),
    "touch move must change exactly both linked offsets, retaining source ranges and all other fields",
  );
  witness.editedContent = editContent(await timeline());
  assert.equal(witness.edited.undoCount, 1);
  assert.equal(witness.edited.canRedo, false);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+z`);
  witness.undone = await state();
  assert.deepEqual(witness.undone.items, witness.initial.items);
  assert.equal(witness.undone.canRedo, true);
  await page.keyboard.press(`${modifier}+Shift+z`);
  witness.redone = await state();
  assert.deepEqual(witness.redone.items, witness.edited.items);
  assert.equal(witness.redone.undoCount, 1);
  const beforeCancel = await state();
  const contentBeforeCancel = editContent(await timeline());
  witness.cancelGesture = await beginDrag();
  assert(
    witness.cancelGesture.movingBox.x > witness.cancelGesture.beforeBox.x,
    "cancellation control must first move the rendered production clip",
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  await settle();
  witness.cancelled = await state();
  assert.deepEqual(
    witness.cancelled,
    beforeCancel,
    "cancel must restore exact items, selection and history counts/flags",
  );
  assert.deepEqual(
    editContent(await timeline()),
    contentBeforeCancel,
    "cancel must restore the whole edit graph",
  );
  if (mutation === "corrupt-retained-history") {
    await page.evaluate(() =>
      window.fl100Editor.corruptRetainedTouchHistoryForControl(),
    );
    witness.corruptedProjection = await state();
    witness.corruptedContent = editContent(await timeline());
    assert.deepEqual(
      witness.corruptedProjection,
      witness.cancelled,
      "negative control must retain counts/flags/current state",
    );
    assert.deepEqual(
      witness.corruptedContent,
      contentBeforeCancel,
      "negative control must retain the complete visible edit graph",
    );
  }
  // Counts cannot prove the retained command still owns the correct snapshots.
  // Exercise that command through the same real shortcut path after cancellation.
  await page.keyboard.press(`${modifier}+z`);
  witness.afterCancelUndone = await state();
  witness.afterCancelUndoneContent = editContent(await timeline());
  assert.deepEqual(
    witness.afterCancelUndoneContent,
    witness.initialContent,
    "retained undo after cancellation must restore the complete original edit graph",
  );
  assert.deepEqual(
    witness.afterCancelUndone,
    witness.undone,
    "retained undo after cancellation must preserve selection and history behavior",
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  witness.afterCancelRedone = await state();
  witness.afterCancelRedoneContent = editContent(await timeline());
  assert.deepEqual(
    witness.afterCancelRedoneContent,
    witness.editedContent,
    "retained redo after cancellation must restore the complete edited graph",
  );
  assert.deepEqual(
    witness.afterCancelRedone,
    witness.redone,
    "retained redo after cancellation must preserve selection and history behavior",
  );
  witness.pointerEvents = await page.evaluate(() => window.fl94TouchEvents);
  assert(witness.pointerEvents.length > 0);
  assert(
    witness.pointerEvents.every(
      (event) => event.trusted && event.pointerType === "touch",
    ),
  );
  assert.equal(
    witness.pointerEvents.filter((event) => event.type === "pointerdown")
      .length,
    2,
  );
  assert(
    witness.pointerEvents
      .filter((event) => event.type === "pointerdown")
      .every((event) => event.itemId === "tablet-v"),
  );
  assert.equal(
    witness.pointerEvents.filter((event) => event.type === "pointercancel")
      .length,
    1,
  );
  witness.beforeSave = editContent(await timeline());
  assert.deepEqual(
    witness.beforeSave,
    witness.editedContent,
    "save must receive the exact edited graph after the retained history probe",
  );
  witness.persisted = editContent(
    await page.evaluate(
      (id) => window.fl100Editor.saveTouchTimeline(id),
      projectId,
    ),
  );
  assert.deepEqual(
    witness.persisted,
    witness.beforeSave,
    "real production save must persist the exact edit graph",
  );
  await page.reload();
  await page.waitForFunction(() => !!window.fl100Editor);
  await page.evaluate(
    (id) => window.fl100Editor.reopenTouchTimeline(id),
    projectId,
  );
  witness.reopened = editContent(await timeline());
  assert.deepEqual(
    witness.reopened,
    witness.persisted,
    "fresh-document production hydration must retain the stored graph",
  );
  assert.deepEqual(
    (await state()).items.map(
      ({ id, from, sourceStart, sourceEnd, linkedGroupId }) => ({
        id,
        from,
        sourceStart,
        sourceEnd,
        linkedGroupId,
      }),
    ),
    witness.edited.items.map(
      ({ id, from, sourceStart, sourceEnd, linkedGroupId }) => ({
        id,
        from,
        sourceStart,
        sourceEnd,
        linkedGroupId,
      }),
    ),
  );
  witness.userAgent = await page.evaluate(() => navigator.userAgent);
  await page.screenshot({
    path: path.join(evidence, "tablet-touch-reopened.png"),
  });
  assert(
    harness.observations.some(
      (entry) => entry.kind === "proxied" && entry.url === url,
    ),
  );
  assert(
    !harness.observations.some(
      (entry) =>
        entry.kind === "tunnelled" ||
        (entry.kind === "error" &&
          !(
            entry.upgradeProtocol === "vite-hmr" &&
            new URL(entry.url).origin === origin
          )),
    ),
  );
  witness.result = "PASS";
} catch (error) {
  witness.result = "FAIL";
  witness.error = String(error?.stack ?? error);
  if (page && !page.isClosed()) {
    try {
      witness.pointerEvents ??= await page.evaluate(
        () => window.fl94TouchEvents,
      );
      witness.failureState = await page.evaluate(() =>
        window.fl100Editor.state(),
      );
    } catch (observationError) {
      witness.failureObservationError = String(observationError);
    }
  }
  throw error;
} finally {
  try {
    await page?.evaluate(
      (id) => window.fl100Editor?.disposeTouchTimeline(id),
      projectId,
    );
  } catch (error) {
    // Setup failure may precede directory creation. Preserve the original failure evidence.
    witness.cleanupError = String(error);
    if (witness.result === "PASS") {
      witness.result = "FAIL";
      cleanupFailure = error;
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await harness.close();
      witness.browserConnectedAfterClose = browser?.isConnected() ?? false;
      witness.harnessClosed = true;
      witness.requests = harness.observations;
      await writeFile(
        path.join(evidence, "observation.json"),
        JSON.stringify(witness, null, 2),
      );
      assert.equal(witness.browserConnectedAfterClose, false);
    }
  }
}
if (cleanupFailure) throw cleanupFailure;
process.stdout.write(
  "PASS trusted tablet touch linked move → history undo/redo → cancel rollback → OPFS save/reopen\n",
);
