/** Trusted touch → production Slip or Select-cut Roll; exact linked ranges/history/OPFS, no host authority claim. */
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
const editTool = process.env.STUDIO_TIMELINE_EDIT ?? "slip";
assert.ok(["slip", "roll"].includes(editTool));
const mutation = process.env.STUDIO_TEST_MUTATION;
assert(
  !mutation ||
    ["missing-touch-hook", "wrong-tool", "corrupt-retained-history"].includes(
      mutation,
    ),
);
const harness = createHarness({ upstream: origin, inspectConnect: true });
let browser;
let page;
let cleanupFailure;
let lockedProjectPrepared = false;
const projectId = `fl94-touch-${randomUUID()}`;
const lockedProjectId = `fl94-touch-${randomUUID()}`;
const witness = {
  mutation: mutation ?? null,
  sourceBinding,
  projectId,
  lockedProjectId,
  viewport: { width: 1024, height: 768 },
};
if (editTool === "roll") witness.nativeTool = "roll";
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
// Fixed oracle from timeline-tools.test.ts:371. Retain every unrelated graph field.
const expectedSlipContent = (initial) => ({
  ...initial,
  items: initial.items.map((item) =>
    ["slip-v-A", "slip-a-A"].includes(item.id)
      ? { ...item, sourceStart: 30, sourceEnd: 150 }
      : item,
  ),
});
// Independent +30 edit point oracle, not the live preview or production clamp helper.
const expectedRollContent = (initial) => ({
  ...initial,
  items: initial.items.map((item) =>
    ["slip-v-A", "slip-a-A"].includes(item.id)
      ? { ...item, durationInFrames: 150, sourceEnd: 150 }
      : ["slip-v-B", "slip-a-B"].includes(item.id)
        ? { ...item, from: 150, durationInFrames: 180, sourceStart: 60 }
        : item,
  ),
});
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
    (id) => window.fl100Editor.prepareSlipTimeline(id),
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
  const selectSlip = async () => {
    await page
      .getByRole("button", { name: "Select Tool", exact: true })
      .click();
    // Select's smart cut supplies Roll; there is no invented Roll toolbar command.
    if (editTool === "roll") return;
    await page
      .getByRole("button", { name: "Slip Slide Tools", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /^Slip Tool/ }).click();
  };
  await selectSlip();
  if (mutation === "wrong-tool")
    await page
      .getByRole("button", { name: "Select Tool", exact: true })
      .click();
  const state = () => page.evaluate(() => window.fl100Editor.state());
  const timeline = () => page.evaluate(() => window.fl100Editor.timeline());
  const clip = page.locator('[data-timeline-item][data-item-id="slip-v-A"]');
  await clip.waitFor({ state: "visible" });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const beginDrag = async (
    target = clip,
    durationFrames = 120,
    pointerFrames = editTool === "roll" ? 30 : -30,
    atCut = editTool === "roll",
  ) => {
    const box = await target.boundingBox();
    assert(
      box && box.width > 0 && box.height > 0,
      "real clip must have geometry",
    );
    // A long clip can extend outside the viewport; hit its visible interior.
    // Keep the full clip width for frame scaling, never the cropped visible width.
    const visibleLeft = Math.max(0, box.x);
    const visibleRight = Math.min(witness.viewport.width, box.x + box.width);
    assert(
      visibleRight > visibleLeft,
      "drag target must intersect the real viewport",
    );
    const start = {
      x: atCut ? box.x + box.width - 1 : (visibleLeft + visibleRight) / 2,
      y: box.y + box.height / 2,
      id: 1,
    };
    // Roll moves the cut right30; Slip negates displacement to advance source by30.
    const dx = (box.width * pointerFrames) / durationFrames;
    if (atCut) {
      assert(
        start.x >= 0 && start.x < witness.viewport.width,
        "actual cut must be in the viewport",
      );
      assert(
        start.y >= 0 && start.y < witness.viewport.height,
        "actual handle must be in the viewport",
      );
      assert(
        start.x + dx >= 0 && start.x + dx < witness.viewport.width,
        "the complete trusted Roll gesture must stay in the viewport",
      );
    } else {
      assert(
        start.x + dx > visibleLeft && start.x + dx < visibleRight,
        "the complete trusted gesture must stay inside the visible clip",
      );
    }
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
    return { start, dx, beforeBox: box, movingBox: await target.boundingBox() };
  };
  witness.initial = await state();
  witness.initialContent = editContent(await timeline());
  assert.equal(witness.initial.items.length, 5);
  assert.deepEqual(
    witness.initial.items.map(
      ({
        id,
        from,
        durationInFrames,
        sourceStart,
        sourceEnd,
        sourceFps,
        sourceDuration,
      }) => ({
        id,
        from,
        durationInFrames,
        sourceStart,
        sourceEnd,
        sourceFps,
        sourceDuration,
      }),
    ),
    [
      {
        id: "slip-v-A",
        from: 0,
        durationInFrames: 120,
        sourceStart: 0,
        sourceEnd: 120,
        sourceFps: 30,
        sourceDuration: 240,
      },
      {
        id: "slip-a-A",
        from: 0,
        durationInFrames: 120,
        sourceStart: 0,
        sourceEnd: 120,
        sourceFps: 30,
        sourceDuration: 240,
      },
      {
        id: "slip-v-B",
        from: 120,
        durationInFrames: 210,
        sourceStart: 30,
        sourceEnd: 240,
        sourceFps: 30,
        sourceDuration: 240,
      },
      {
        id: "slip-a-B",
        from: 120,
        durationInFrames: 210,
        sourceStart: 30,
        sourceEnd: 240,
        sourceFps: 30,
        sourceDuration: 240,
      },
      {
        id: "slip-unrelated",
        from: 15,
        durationInFrames: 45,
        sourceStart: 15,
        sourceEnd: 60,
        sourceFps: 30,
        sourceDuration: 240,
      },
    ],
    "fixture must match the independent30fps source-range oracle",
  );
  witness.expectedContent =
    editTool === "roll"
      ? expectedRollContent(witness.initialContent)
      : expectedSlipContent(witness.initialContent);
  // A Select drag left from frame zero only selects. The negative control instead
  // moves the tail B pair right into free space, proving actual movement cannot pass Slip.
  witness.editGesture =
    mutation === "wrong-tool"
      ? await beginDrag(
          page.locator('[data-timeline-item][data-item-id="slip-v-B"]'),
          210,
          30,
          false,
        )
      : await beginDrag();
  if (editTool === "roll" && mutation !== "wrong-tool") {
    witness.commitPreview = await page.evaluate(() =>
      window.fl100Editor.rollPreview(),
    );
    assert.equal(witness.commitPreview.trimmedItemId, "slip-v-A");
    assert.equal(witness.commitPreview.neighborItemId, "slip-v-B");
    assert.equal(witness.commitPreview.handle, "end");
    assert.equal(witness.commitPreview.neighborDelta, 30);
    assert.equal(
      witness.commitPreview.linkedUpdates["slip-a-A"].sourceEnd,
      150,
    );
    assert.equal(
      witness.commitPreview.linkedUpdates["slip-a-B"].sourceStart,
      60,
    );
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForFunction(() => window.fl100Editor.state().undoCount === 1);
  witness.edited = await state();
  witness.editedContent = editContent(await timeline());
  if (mutation === "wrong-tool") {
    assert.deepEqual(
      witness.edited.items,
      witness.initial.items.map((item) =>
        ["slip-v-B", "slip-a-B"].includes(item.id)
          ? { ...item, from: 150 }
          : item,
      ),
      "wrong-tool control must first produce real linked movement with all source ranges unchanged",
    );
  }
  assert.deepEqual(
    witness.editedContent,
    witness.expectedContent,
    editTool === "roll"
      ? "Roll must move only the linked A/B cut to150 with A0..150/B60..240 source ranges and fixed span330"
      : "Slip must change exactly both A source ranges to30..150; placement, B and unrelated graph must be unchanged",
  );
  if (editTool === "roll") {
    for (const trackId of ["slip-v", "slip-a"]) {
      assert.deepEqual(
        witness.edited.items
          .filter((item) => item.trackId === trackId)
          .map(({ from, durationInFrames, sourceStart, sourceEnd }) => ({
            from,
            durationInFrames,
            sourceStart,
            sourceEnd,
          })),
        [
          { from: 0, durationInFrames: 150, sourceStart: 0, sourceEnd: 150 },
          { from: 150, durationInFrames: 180, sourceStart: 60, sourceEnd: 240 },
        ],
      );
      assert.equal(
        Math.max(
          ...witness.edited.items
            .filter((item) => item.trackId === trackId)
            .map((item) => item.from + item.durationInFrames),
        ),
        330,
      );
    }
  }
  assert.equal(witness.edited.undoCount, 1);
  assert.equal(witness.edited.canRedo, false);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+z`);
  witness.undone = await state();
  assert.deepEqual(
    editContent(await timeline()),
    witness.initialContent,
    "real undo must restore the complete original graph",
  );
  assert.deepEqual(witness.undone.items, witness.initial.items);
  assert.equal(witness.undone.canRedo, true);
  await page.keyboard.press(`${modifier}+Shift+z`);
  witness.redone = await state();
  assert.deepEqual(
    editContent(await timeline()),
    witness.expectedContent,
    `real redo must restore the independently expected ${editTool === "roll" ? "Roll" : "Slip"} graph`,
  );
  assert.deepEqual(witness.redone.items, witness.edited.items);
  assert.equal(witness.redone.undoCount, 1);
  const beforeCancel = await state();
  const contentBeforeCancel = editContent(await timeline());
  if (editTool === "roll")
    witness.historyBeforeCancel = await page.evaluate(() =>
      window.fl100Editor.historySnapshot(),
    );
  witness.cancelGesture = await beginDrag(
    clip,
    editTool === "roll" ? 150 : 120,
  );
  witness.cancelPreview = await page.evaluate(
    (tool) =>
      tool === "roll"
        ? window.fl100Editor.rollPreview()
        : window.fl100Editor.slipPreview(),
    editTool,
  );
  if (editTool === "roll") {
    assert.equal(witness.cancelPreview.trimmedItemId, "slip-v-A");
    assert.equal(witness.cancelPreview.neighborItemId, "slip-v-B");
    assert.equal(witness.cancelPreview.handle, "end");
    assert.equal(
      witness.cancelPreview.neighborDelta,
      30,
      "cancel must first reach a real nonzero Roll preview",
    );
    assert.equal(
      witness.cancelPreview.linkedUpdates["slip-a-A"].sourceEnd,
      180,
    );
    assert.equal(
      witness.cancelPreview.linkedUpdates["slip-a-B"].sourceStart,
      90,
    );
  } else {
    assert.equal(witness.cancelPreview.itemId, "slip-v-A");
    assert.equal(
      witness.cancelPreview.slipDelta,
      30,
      "cancel must first reach a real nonzero source preview",
    );
    assert.equal(
      witness.cancelPreview.linkedUpdates["slip-a-A"].sourceStart,
      60,
    );
    assert.equal(
      witness.cancelPreview.linkedUpdates["slip-a-A"].sourceEnd,
      180,
    );
  }
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
  if (editTool === "roll") {
    witness.historyAfterCancel = await page.evaluate(() =>
      window.fl100Editor.historySnapshot(),
    );
    assert.deepEqual(
      witness.historyAfterCancel,
      witness.historyBeforeCancel,
      "Roll cancellation must preserve complete retained undo/redo entries and dirty state",
    );
  }
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
  await page.evaluate(
    (id) => window.fl100Editor.prepareSlipTimeline(id, true),
    lockedProjectId,
  );
  lockedProjectPrepared = true;
  await page.waitForFunction(() => window.fl100Editor.touchReady());
  await selectSlip();
  if (editTool === "roll") {
    // A real body move and native undo seed a nonempty redo before the refused cut.
    witness.lockedSeedOriginal = editContent(await timeline());
    witness.lockedSeedGesture = await beginDrag(
      page.locator('[data-timeline-item][data-item-id="slip-unrelated"]'),
      45,
      15,
      false,
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () => window.fl100Editor.state().undoCount === 1,
    );
    witness.lockedSeedEdited = editContent(await timeline());
    const expectedSeed = {
      ...witness.lockedSeedOriginal,
      items: witness.lockedSeedOriginal.items.map((item) =>
        item.id === "slip-unrelated" ? { ...item, from: 30 } : item,
      ),
    };
    assert.deepEqual(
      witness.lockedSeedEdited,
      expectedSeed,
      "locked-case redo must originate in a real unrelated +15 move, not a fabricated history entry",
    );
    await page.keyboard.press(`${modifier}+z`);
    assert.deepEqual(editContent(await timeline()), witness.lockedSeedOriginal);
    witness.lockedHistoryBefore = await page.evaluate(() =>
      window.fl100Editor.historySnapshot(),
    );
    assert.equal(witness.lockedHistoryBefore.undo.length, 0);
    assert.equal(witness.lockedHistoryBefore.redo.length, 1);
  }
  witness.lockedBefore = await state();
  witness.lockedContentBefore = editContent(await timeline());
  assert.equal(
    witness.lockedBefore.tracks.find((track) => track.id === "slip-v").locked,
    false,
  );
  assert.equal(
    witness.lockedBefore.tracks.find((track) => track.id === "slip-a").locked,
    true,
  );
  witness.lockedGesture = await beginDrag();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await settle();
  witness.lockedAfter = await state();
  assert.deepEqual(
    editContent(await timeline()),
    witness.lockedContentBefore,
    "locked linked audio must prevent partial source or graph writes",
  );
  assert.deepEqual(witness.lockedAfter.items, witness.lockedBefore.items);
  assert.equal(witness.lockedAfter.undoCount, 0);
  assert.equal(witness.lockedAfter.canUndo, false);
  assert.equal(witness.lockedAfter.canRedo, editTool === "roll");
  if (editTool === "roll") {
    witness.lockedHistoryAfter = await page.evaluate(() =>
      window.fl100Editor.historySnapshot(),
    );
    assert.deepEqual(
      witness.lockedHistoryAfter,
      witness.lockedHistoryBefore,
      "locked Roll must preserve the entire nonempty redo and current graph",
    );
    await page.keyboard.press(`${modifier}+Shift+z`);
    assert.deepEqual(
      editContent(await timeline()),
      witness.lockedSeedEdited,
      "refused Roll must leave the real retained redo executable",
    );
    await page.keyboard.press(`${modifier}+z`);
    assert.deepEqual(
      editContent(await timeline()),
      witness.lockedContentBefore,
    );
  }
  witness.lockedPreview = await page.evaluate(
    (tool) =>
      tool === "roll"
        ? window.fl100Editor.rollPreview()
        : window.fl100Editor.slipPreview(),
    editTool,
  );
  assert.equal(
    editTool === "roll"
      ? witness.lockedPreview.trimmedItemId
      : witness.lockedPreview.itemId,
    null,
  );
  assert.deepEqual(witness.lockedPreview.linkedUpdates, {});
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
    editTool === "roll" ? 4 : 3,
  );
  if (editTool === "roll") {
    assert.deepEqual(
      witness.pointerEvents
        .filter((event) => event.type === "pointerdown")
        .map((event) => event.itemId),
      ["slip-v-A", "slip-v-A", "slip-unrelated", "slip-v-A"],
    );
  } else {
    assert(
      witness.pointerEvents
        .filter((event) => event.type === "pointerdown")
        .every((event) => event.itemId === "slip-v-A"),
    );
  }
  assert.equal(
    witness.pointerEvents.filter((event) => event.type === "pointercancel")
      .length,
    1,
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
    path: path.join(
      evidence,
      editTool === "roll"
        ? "tablet-roll-reopened.png"
        : "tablet-slip-reopened.png",
    ),
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
    for (const id of [
      projectId,
      ...(lockedProjectPrepared ? [lockedProjectId] : []),
    ]) {
      await page?.evaluate(
        (fixtureId) => window.fl100Editor?.disposeTouchTimeline(fixtureId),
        id,
      );
    }
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
  editTool === "roll"
    ? "PASS trusted Select cut Roll linked ranges/fixed span → history/cancel retained undo/redo → locked nonempty-redo refusal → OPFS save/reopen\n"
    : "PASS trusted toolbar Slip linked source ranges → history/cancel retained undo/redo → locked companion refusal → OPFS save/reopen\n",
);
