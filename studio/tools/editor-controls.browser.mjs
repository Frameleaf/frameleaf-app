/** Real component/store/history/browser-preference checks. No backend persistence claim. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { admittedHostCapabilities } from "./lib/browser-driver.mjs";
import { openPage } from "./resource-admission.browser.mjs";
const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5191";
const browser = process.env.BROWSER ?? "chromium";
const evidence = process.env.STUDIO_TEST_EVIDENCE;
const scenario = process.env.STUDIO_EDITOR_SCENARIO ?? "controls";
assert.ok(["controls", "monitor"].includes(scenario));
const counterfactual = process.env.FL98_COUNTERFACTUAL;
assert.ok(
  !counterfactual ||
    ["monitor-leak", "mutate-capture", "stale-epoch", "state-only"].includes(counterfactual),
);
assert.ok(!counterfactual || scenario === "monitor");
// Deliberately wrong fixture input verifies the independent expected-pose assertion.
const parentDx = process.env.FL100_ORACLE_COUNTERFACTUAL === "stationary-parent" ? 0 : 16;
admittedHostCapabilities(browser);
if (browser !== "chromium")
  assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
let monitorWav;
const harness = createHarness({
  upstream: scenario === "monitor" ? `${origin}/studio-engine/` : origin,
  inspectConnect: scenario === "monitor",
  overrides:
    scenario === "monitor"
      ? [
          {
            test: (url, request) =>
              url.origin === new URL(origin).origin &&
              url.pathname === "/__fl98__/constant.wav" &&
              request.method === "GET",
            respond: () => {
              assert.ok(monitorWav, "synthetic WAV must be prepared before mounting preview");
              return {
                contentType: "audio/wav",
                headers: { "cache-control": "no-store" },
                body: monitorWav,
              };
            },
          },
        ]
      : [],
});
let driver;
const witnesses = [];

/** Real UI/Clock/audio and local OPFS only; no server revision or worker-export claim. */
async function qualifyMonitor(page, url) {
  const projectId = `fl98-monitor-${randomUUID()}`;
  const api = () => page.evaluate(() => window.fl98Monitor.state());
  const observe = () => page.evaluate(() => window.fl98Monitor.observation());
  const waitAck = () =>
    page.waitForFunction(() => {
      const observed = window.fl98Monitor.observation();
      return (
        observed.acknowledged &&
        observed.latest.epoch.running === window.fl98Monitor.state().isPlaying
      );
    });
  const settleSeek = async () => {
    try {
      await page.waitForFunction(() => {
        const state = window.fl98Monitor.state(),
          observed = window.fl98Monitor.observation();
        const requestedTarget = window.fl98Monitor.requestedSeekTarget;
        return (
          state.currentFrame === requestedTarget && observed.latest?.epoch.frame === requestedTarget
        );
      });
      const observed = await observe();
      assert.deepEqual(
        observed.latest.forwarded,
        observed.latest.epoch,
        "native seek must publish its current epoch, not replay an old one",
      );
      await page.waitForFunction(() => {
        const state = window.fl98Monitor.state(),
          observed = window.fl98Monitor.observation(),
          requestedTarget = window.fl98Monitor.requestedSeekTarget;
        return (
          state.currentFrame === requestedTarget &&
          observed.latest?.epoch.frame === requestedTarget &&
          observed.acknowledged &&
          observed.latest.epoch.running === state.isPlaying
        );
      });
    } catch (error) {
      console.error(
        "FL98_SEEK_FAILURE",
        JSON.stringify({
          requestedTarget: await page.evaluate(() => window.fl98Monitor.requestedSeekTarget),
          state: await api(),
          observation: await observe(),
        }),
      );
      throw error;
    }
  };
  const seek = async (frame) => {
    // Oracle metadata only: never writes transport/store/producer/ACK state.
    await page.evaluate(() => {
      window.fl98Monitor.requestedSeekTarget = 0;
    });
    await page.click('button[aria-label="Go To Start"]');
    await settleSeek();
    for (let index = 0; index < frame; index++) {
      const requestedTarget = index + 1;
      assert.equal((await api()).currentFrame, index);
      await page.evaluate((target) => {
        window.fl98Monitor.requestedSeekTarget = target;
      }, requestedTarget);
      await page.click('button[aria-label="Next Frame"]');
      await settleSeek();
    }
    assert.equal((await api()).currentFrame, frame);
  };
  const preview = async (frame, expected) => {
    await seek(frame);
    await page.click('button[aria-label="Play"]');
    await waitAck();
    const initial = await observe();
    assert.equal(initial.nativeTap, true, "store state alone cannot qualify native PCM");
    await page.waitForFunction(() => {
      const observed = window.fl98Monitor.observation();
      return (
        observed.acknowledged &&
        observed.settled &&
        observed.spread < 1e-6 &&
        (window.fl98Monitor.state().muted ? observed.peak === 0 : observed.mean > 0)
      );
    });
    const observed = await observe();
    assert.equal(observed.latest.epoch.running, true);
    assert.ok(
      observed.transportFrame >= frame && observed.transportFrame < (frame < 30 ? 29 : 89),
      "PCM must be captured on the intended master plateau",
    );
    assert.ok(
      Math.abs(observed.mean - expected) < 1e-6,
      `native post-master PCM ${observed.mean}, expected ${expected}`,
    );
    if (expected === 0) assert.equal(observed.peak, 0);
    await page.click('button[aria-label="Pause"]');
    await waitAck();
    return observed;
  };
  const capture = () => page.evaluate(async () => window.fl98Monitor.capture());
  const pcm = (id, control) =>
    page.evaluate(async ({ id, control }) => window.fl98Monitor.renderCaptured(id, control), {
      id,
      control,
    });
  const assertPcm = (result, muted = false) => {
    assert.equal(result.channels, 2);
    assert.equal(result.sampleRate, 48000);
    assert.equal(result.frames, 144000);
    assert.equal(
      result.fullDigest,
      result.windowDigest,
      "full and windowed native decode/mix PCM must agree",
    );
    for (const channel of result.probes) {
      assert.ok(Math.abs(channel[0] - (muted ? 0 : 0.0125)) < 1e-6);
      assert.ok(Math.abs(channel[1] - (muted ? 0 : 0.125)) < 1e-6);
    }
    if (muted) {
      assert.equal(result.allZero, true);
      assert.equal(result.passthrough, false);
    }
  };
  try {
    monitorWav = Buffer.from(await page.evaluate(async () => window.fl98Monitor.wavBytes()));
    await page.evaluate(({ projectId, src }) => window.fl98Monitor.open(projectId, src), {
      projectId,
      src: `${origin}/__fl98__/constant.wav`,
    });
    const baseline = await capture(),
      baselinePcm = await pcm(baseline.id);
    assertPcm(baselinePcm);
    // Resume real audio with a native gesture before checking monitor-only epoch stability.
    witnesses.push({ primed: await preview(15, 0.0125) });
    const beforeVolume = await observe();
    await page.click('button[aria-label="Volume"]');
    const drag = await page.evaluate(() => {
      const thumb = document.querySelector('[role="dialog"] [role="slider"]');
      if (!thumb) throw new Error("one native monitor slider required");
      const slider = thumb.closest(".touch-none");
      if (!slider) throw new Error("Native Radix slider track is missing");
      const bounds = thumb.getBoundingClientRect(),
        track = slider.getBoundingClientRect();
      return {
        from: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        to: { x: track.x + track.width / 2, y: track.y + track.height / 2 },
      };
    });
    await page.drag(drag.from, drag.to);
    try {
      await page.waitForFunction(() => window.fl98Monitor.state().volume === 0.5);
    } catch (error) {
      console.error(
        "FL98_VOLUME_FAILURE",
        JSON.stringify({
          requestedVolume: 0.5,
          drag,
          state: await api(),
          geometry: await page.evaluate(() => {
            const thumb = document.querySelector('[role="slider"]');
            const track = thumb?.closest(".touch-none");
            return {
              thumb: thumb?.getBoundingClientRect().toJSON(),
              track: track?.getBoundingClientRect().toJSON(),
              valueNow: thumb?.getAttribute("aria-valuenow"),
            };
          }),
        }),
      );
      throw error;
    }
    assert.equal(
      (await observe()).epochCount,
      beforeVolume.epochCount,
      "monitor volume must not republish project master epochs",
    );
    await page.click('button[aria-label="Volume"]');
    if (counterfactual === "state-only")
      await page.evaluate(() => window.fl98Monitor.disconnectTapForControl());
    witnesses.push({ halfLow: await preview(15, 0.00625) });
    if (counterfactual === "stale-epoch")
      await page.evaluate(() => window.fl98Monitor.replayNextForControl());
    witnesses.push({ halfHigh: await preview(45, 0.0625) });
    await page.evaluate(() => window.fl98Monitor.replayStale());
    await page.waitForFunction(() => window.fl98Monitor.observation().staleRejected);
    witnesses.push({ staleReplayRejectedByNativeProcessor: await observe() });
    const beforeMute = await observe();
    await page.click('button[aria-label="Volume"]');
    await page.click('[role="dialog"] button[aria-label="Mute"]');
    await page.waitForFunction(() => window.fl98Monitor.state().muted);
    assert.equal(
      (await observe()).epochCount,
      beforeMute.epochCount,
      "monitor mute must not republish project master epochs",
    );
    await page.click('button[aria-label="Volume"]');
    witnesses.push({ monitorMuted: await preview(45, 0) });
    const second = await capture(),
      secondPcm = await pcm(
        second.id,
        counterfactual === "monitor-leak" ? counterfactual : undefined,
      );
    assert.deepEqual(
      second.snapshot,
      baseline.snapshot,
      "UI monitor changes and seeks must not change captured project master",
    );
    assertPcm(secondPcm);
    assert.equal(
      secondPcm.fullDigest,
      baselinePcm.fullDigest,
      "export PCM must ignore device monitor changes",
    );
    await page.evaluate(() => window.fl98Monitor.setProjectMute(true));
    const muted = await capture(),
      mutedPcm = await pcm(muted.id);
    assertPcm(mutedPcm, true);
    const frozen = await pcm(
      baseline.id,
      counterfactual === "mutate-capture" ? counterfactual : undefined,
    );
    assert.deepEqual(
      frozen.snapshot,
      baseline.snapshot,
      "live project edits must not mutate a captured local job",
    );
    assert.equal(frozen.fullDigest, baselinePcm.fullDigest);
    await page.evaluate(() => window.fl98Monitor.setProjectMute(false));
    const saved = await page.evaluate(async () => window.fl98Monitor.save());
    assert.deepEqual(saved.device, { volume: 0.5, muted: true });
    assert.equal(saved.storage.state.volume, 0.5);
    assert.equal(saved.storage.state.muted, true);
    for (const field of ["masterBusDb", "masterBusMuted", "masterGainEnvelope"])
      assert.equal(field in saved.storage.state, false);
    await page.evaluate(async () => window.fl98Monitor.dispose());
    await page.goto(url);
    await page.waitForFunction(() => !!window.fl98Monitor);
    await page.evaluate(({ projectId, src }) => window.fl98Monitor.open(projectId, src, true), {
      projectId,
      src: `${origin}/__fl98__/constant.wav`,
    });
    const reloaded = await api();
    assert.equal(reloaded.volume, 0.5);
    assert.equal(reloaded.muted, true);
    const third = await capture(),
      thirdPcm = await pcm(third.id);
    assert.deepEqual(
      third.snapshot,
      baseline.snapshot,
      "OPFS project master survives actual same-context navigation reload",
    );
    assertPcm(thirdPcm);
    assert.equal(thirdPcm.fullDigest, baselinePcm.fullDigest);
    await page.click('button[aria-label="Volume"]');
    await page.click('[role="dialog"] button[aria-label="Unmute"]');
    await page.click('button[aria-label="Volume"]');
    witnesses.push({
      reloadLow: await preview(15, 0.00625),
      reloadHigh: await preview(45, 0.0625),
      baseline,
      second,
      third,
      baselinePcm,
      secondPcm,
      thirdPcm,
      mutedPcm,
      saved,
    });
    const audioRequests = harness.observations.filter((item) => item.kind === "override");
    assert.ok(audioRequests.length > 0);
    assert.ok(audioRequests.every((item) => item.url === `${origin}/__fl98__/constant.wav`));
    assert.deepEqual(
      harness.observations.filter((item) => ["blocked", "error", "tunnelled"].includes(item.kind)),
      [],
    );
  } finally {
    await page.evaluate(async () => window.fl98Monitor?.dispose());
  }
}
try {
  const harnessOrigin = await harness.listen();
  driver = await openPage(harnessOrigin, undefined, {
    browser,
    endpoint: process.env.WEBDRIVER_ENDPOINT,
  });
  const page = driver.page;
  const browserProvenance = driver.browser;
  const url = `${origin}/studio-engine/test/editor-controls.browser.html`;
  const startupRequestOffset = harness.observations.length;
  const startupStarted = Date.now();
  let startupPhase = "navigation";
  try {
    await page.goto(url);
    startupPhase = "fixture-global";
    await page.waitForFunction(() => !!window.fl100Editor);
  } catch (error) {
    if (scenario === "monitor") {
      const sanitize = (value) =>
        String(value)
          .replace(/\?[^\s"'<>]*/g, "?[redacted]")
          .slice(0, 2048);
      const requests = harness.observations.slice(startupRequestOffset);
      let nativeStartup;
      let diagnosticTimer;
      try {
        nativeStartup = await Promise.race([
          page.evaluate(() => {
            const clean = (value) =>
              String(value)
                .replace(/\?[^\s"'<>]*/g, "?[redacted]")
                .slice(0, 2048);
            const resources = performance.getEntriesByType("resource");
            return {
              readyState: document.readyState,
              fixtureGlobal: !!window.fl100Editor,
              elapsed: performance.now(),
              errorOverlay: clean(
                document.querySelector("vite-error-overlay")?.shadowRoot?.querySelector(".message")
                  ?.textContent ?? "",
              ),
              resourceCount: resources.length,
              failedResources: resources
                .filter((entry) => entry.responseStatus >= 400)
                .slice(-20)
                .map((entry) => ({ url: clean(entry.name), status: entry.responseStatus })),
              slowResources: [...resources]
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 20)
                .map((entry) => ({
                  url: clean(entry.name),
                  duration: entry.duration,
                  status: entry.responseStatus ?? null,
                })),
            };
          }),
          new Promise((_, reject) => {
            diagnosticTimer = setTimeout(
              () => reject(new Error("Startup diagnostic collection exceeded 2000ms")),
              2000,
            );
          }),
        ]);
      } catch (diagnosticError) {
        nativeStartup = { unavailable: sanitize(diagnosticError) };
      } finally {
        clearTimeout(diagnosticTimer);
      }
      console.error(
        "FL98_STARTUP_FAILURE",
        JSON.stringify({
          phase: startupPhase,
          elapsed: Date.now() - startupStarted,
          error: sanitize(error),
          consoleAndPageErrors: "not exposed by existing driver",
          requestCounts: requests.reduce(
            (counts, request) => ({
              ...counts,
              [request.kind]: (counts[request.kind] ?? 0) + 1,
            }),
            {},
          ),
          rejectedRequests: requests
            .filter((request) => ["blocked", "error", "tunnelled"].includes(request.kind))
            .slice(-20)
            .map((request) => ({
              kind: request.kind,
              method: request.method,
              url: sanitize(request.url),
              error: request.error && sanitize(request.error),
            })),
          recentRequests: requests.slice(-20).map((request) => ({
            kind: request.kind,
            method: request.method,
            url: sanitize(request.url),
          })),
          nativeStartup,
        }),
      );
    }
    throw error;
  }
  if (scenario === "monitor") {
    await qualifyMonitor(page, url);
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        path.join(evidence, `${browser}-monitor.json`),
        JSON.stringify(
          {
            browserProvenance,
            witnesses,
            requests: harness.observations,
            serverRevisionExport: "not-qualified",
          },
          null,
          2,
        ),
      );
    }
    console.log(
      JSON.stringify({
        browser,
        browserProvenance,
        passed: true,
        localMonitorSeekReloadCapturedPcm: true,
        serverRevisionExport: "not-qualified",
        witnesses,
      }),
    );
  } else {
    const baseline = await page.evaluate(async () => window.fl100Editor.renderHero());
    assert.equal(baseline.pose.x, 0);
    assert.equal(baseline.maxDelta, 0);
    for (const parentId of ["null", "group-instance"]) {
      await page.evaluate(() => window.fl100Editor.mount("compose", true));
      const coords = await page.evaluate((parentId) => {
        const from = document
          .querySelector('button[aria-label="Parent pick whip for Hero rectangle"]')
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
        assigned.items.find((item) => item.id === "hero").transformParent?.parentItemId,
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
      await page.evaluate(({ parentId, dx }) => window.fl100Editor.moveParent(parentId, dx), {
        parentId,
        dx: parentDx,
      });
      const moved = await page.evaluate(async () => window.fl100Editor.renderHero());
      assert.equal(moved.pose.x, 16, "actual hierarchy follows a parent translated sixteen pixels");
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
    await page.click('button[aria-label="Create Layer Group from selected layers"]');
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
        label: document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(),
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
      selected: document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(),
      saved: window.fl100Editor.state().mode,
    }));
    assert.deepEqual(restored, { selected: "Split", saved: "split" });
    witnesses.push({ preferenceRestoredAfterNavigation: restored });
    assert.equal(harness.observations.filter((item) => item.kind === "override").length, 0);
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
  }
} finally {
  try {
    await driver?.close();
  } finally {
    await harness.close();
  }
}
