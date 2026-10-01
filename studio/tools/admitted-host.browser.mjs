import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
import { createHarness } from "./lib/cross-browser-harness.mjs";
import { createChromiumDriver, createWebDriverClassicDriver } from "./lib/browser-driver.mjs";
const scenario = process.env.STUDIO_HOST_SCENARIO ?? "track";
assert.ok(["track", "auto-key", "ease-out"].includes(scenario));
const dependencyRoot = process.env.STUDIO_DEPENDENCY_ROOT ?? root;
const require = createRequire(dependencyRoot + "/studio/engine/package.json");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const sharp = require("sharp");
const base = process.env.HOST_ORIGIN;
assert.ok(base);
assert.ok(process.env.STUDIO_HOST_EVIDENCE);
const evidence = path.resolve(process.env.STUDIO_HOST_EVIDENCE);
await mkdir(evidence, { recursive: true });
const dir = pathToFileURL(evidence + "/");
assert.ok(process.env.STUDIO_GPU_REPORT && process.env.STUDIO_METAL_REPORT);
const gpu = JSON.parse(await readFile(process.env.STUDIO_GPU_REPORT));
const metal = JSON.parse(await readFile(process.env.STUDIO_METAL_REPORT));
assert.equal(metal.devices.length, 1);
assert.equal(metal.devices[0].name, "Apple M2 Max");
assert.ok(BigInt(metal.devices[0].recommendedMaxWorkingSetSize) >= 2147483648n);
assert.equal(gpu.adapter.isFallbackAdapter, false);
assert.equal(gpu.adapter.vendor, "apple");
const catalogue = JSON.parse(await readFile(root + "/studio/engine-build.json"));
assert.equal(gpu.sourceSha256, catalogue.sourceSha256);
assert.equal(gpu.engineRevision, catalogue.upstreamCommit);
assert.ok(
  Date.now() - Date.parse(gpu.finishedAt) >= 0 && Date.now() - Date.parse(gpu.finishedAt) < 3600000,
  "fresh actual current-engine GPU report required",
);
let auth, worker, browser, page;
const requests = [],
  errors = [];
const api = async (
  path,
  { body, method = body ? "POST" : "GET", token = auth?.accessToken } = {},
) => {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.text();
  assert.ok(r.ok, `${path} ${r.status} ${b}`);
  return b ? JSON.parse(b) : null;
};
try {
  try {
    await api("/auth/admin-sign-up", {
      body: {
        email: "admitted-host@example.test",
        password: "Fixture-host-only-password-24!",
        name: "Admitted host",
      },
      token: null,
    });
  } catch (e) {
    if (!e.message.includes("400")) throw e;
  }
  auth = await api("/auth/login", {
    body: {
      email: "admitted-host@example.test",
      password: "Fixture-host-only-password-24!",
    },
    token: null,
  });
  await api("/system-metadata/admin-onboarding", {
    body: { isOnboarded: true },
  });
  const enrolled = await api("/admin/render-workers", {
    body: {
      name: "Genuine measured SDR host fixture",
      destination: "local",
      kinds: ["studio_export"],
      engineDigest: gpu.sourceSha256,
      conformanceMaxAgeMs: 3600000,
      gpuMemoryBytes: "2147483648",
      maxConcurrentOperations: 1,
      maxWallClockMs: "60000",
      maxOutputBytes: "33554432",
    },
  });
  worker = enrolled.worker;
  await api("/render-workers/admission", {
    token: null,
    body: {
      workerId: worker.id,
      enrolmentSecret: enrolled.enrolmentSecret,
      engineDigest: gpu.sourceSha256,
      conformanceReportedAt: gpu.finishedAt,
      softwareRenderer: false,
      gpuMemoryBytes: "2147483648",
      codecs: ["webcodecs-avc"],
      formats: ["mp4"],
      colorPrecision: { maxBitDepth: 8, hdr10: false, dolbyVision: false },
    },
  });
  const capabilities = await api("/ml-destinations/capabilities");
  assert.equal(capabilities.studio.gpuWorker, true);
  assert.equal(capabilities.studio.renderWorker, true);
  let asset;
  if (scenario !== "ease-out") {
    const bytes = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: "#cc4422" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("assetData", new Blob([bytes], { type: "image/png" }), "host-immutable.png");
    form.append("fileCreatedAt", new Date().toISOString());
    form.append("fileModifiedAt", new Date().toISOString());
    const ur = await fetch(base + "/api/assets", {
      method: "POST",
      headers: { authorization: "Bearer " + auth.accessToken },
      body: form,
    });
    assert.ok(ur.ok);
    asset = await ur.json();
  }
  const clientId = randomUUID();
  const graph = {
    schemaVersion: 15,
    id: "host-qualification",
    name: "Actual editor acceptance",
    description: "",
    createdAt: 0,
    updatedAt: 0,
    duration: 1,
    metadata: { width: 1280, height: 720, fps: 24 },
    timeline: {
      tracks: [
        {
          id: "v1",
          name: "V1",
          kind: "video",
          height: 80,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
        },
      ],
      items: [
        {
          id: "still",
          type: "image",
          mediaId: scenario === "ease-out" ? undefined : asset.id,
          trackId: "v1",
          from: 0,
          durationInFrames: 24,
        },
      ],
      transitions: [],
      keyframes: [],
    },
  };
  if (scenario !== "track") {
    graph.timeline.tracks[0].height = 100;
    graph.timeline.tracks[0].items = [];
    graph.timeline.tracks[0].syncLock = true;
    graph.timeline.tracks[0].volume = 0;
    graph.timeline.items[0].label = "Host still";
    graph.duration = 2;
    graph.metadata.fps = 30;
    graph.timeline.items[0].durationInFrames = 60;
    graph.timeline.keyframes = [
      {
        itemId: "still",
        animationVersion: 2,
        properties: [
          {
            property: "opacity",
            keyframes: [{ id: "opacity-k0", frame: 0, value: 1, easing: "linear" }],
          },
        ],
        vectorProperties: [
          {
            property: "position",
            keyframes: [
              { id: "k0", frame: 0, value: { x: -24, y: 0 }, easing: "linear" },
              {
                id: "k30",
                frame: 30,
                value: { x: 24, y: 0 },
                easing: "linear",
              },
            ],
          },
        ],
      },
    ];
  }
  if (scenario === "ease-out") {
    graph.metadata.width = 128;
    graph.metadata.height = 96;
    graph.timeline.items[0] = {
      id: "still",
      type: "shape",
      trackId: "v1",
      label: "Hero rectangle",
      from: 0,
      durationInFrames: 60,
      shapeType: "rectangle",
      fillColor: "#ff0000",
      strokeEnabled: false,
      transform: { x: 0, y: 0, width: 16, height: 16, rotation: 0, opacity: 1 },
    };
  }
  const initialKeys = structuredClone(graph.timeline.keyframes);
  function keyEntry(graph) {
    const timelines = [
      graph.timeline,
      ...(graph.timeline?.compositions ?? []),
      ...(graph.compositions ?? []),
    ];
    const entries = timelines
      .flatMap((t) => t?.keyframes ?? [])
      .filter((e) => e.itemId === "still");
    assert.equal(entries.length, 1, "one unflattened stored still lane");
    return entries[0];
  }
  function assertAutoKey(graph, expectedInteriorId) {
    const entry = keyEntry(graph);
    assert.equal(entry.animationVersion, 2);
    assert.deepEqual(entry.properties, initialKeys[0].properties);
    const positions = entry.vectorProperties.filter((l) => l.property === "position");
    assert.equal(positions.length, 1);
    const keys = positions[0].keyframes;
    assert.deepEqual(
      keys.map((k) => k.frame),
      [0, 15, 30],
    );
    assert.deepEqual(keys[0], initialKeys[0].vectorProperties[0].keyframes[0]);
    assert.deepEqual(keys[2], initialKeys[0].vectorProperties[0].keyframes[1]);
    assert.deepEqual(keys[1].value, {
      x: process.env.FL100_HOST_COUNTERFACTUAL === "no-interior-key" ? 0 : 12,
      y: 0,
    });
    assert.ok(keys[1].id);
    if (expectedInteriorId) assert.equal(keys[1].id, expectedInteriorId);
    return keys[1].id;
  }
  async function nativeFrame15(frame) {
    await frame.getByRole("button", { name: "Go To Start", exact: true }).click();
    await expect(
      frame.getByRole("button", { name: "00:00:00 / 00:01:29", exact: true }),
    ).toBeVisible();
    for (let i = 1; i <= 15; i++) {
      await frame.getByRole("button", { name: "Next Frame", exact: true }).click();
      await expect(
        frame.getByRole("button", {
          name: `00:00:${String(i).padStart(2, "0")} / 00:01:29`,
          exact: true,
        }),
      ).toBeVisible();
    }
  }
  async function deselectPreview(frame, viewport) {
    const background = frame.getByLabel("Video Preview", { exact: true });
    await expect(background).toHaveCount(1);
    await expect(background).toBeVisible();
    const backgroundBounds = await background.boundingBox();
    const viewportBounds = await viewport.boundingBox();
    assert.ok(backgroundBounds && viewportBounds);
    const point = { x: backgroundBounds.x + 5, y: backgroundBounds.y + 5 };
    assert.ok(
      point.x < viewportBounds.x ||
        point.x >= viewportBounds.x + viewportBounds.width ||
        point.y < viewportBounds.y ||
        point.y >= viewportBounds.y + viewportBounds.height,
      "native background click must be outside the rendered viewport",
    );
    await background.click({ position: { x: 5, y: 5 } });
    await expect(
      frame.getByRole("button", { name: "Move selected element", exact: true }),
    ).toHaveCount(0);
    await expect(frame.getByTestId("motion-path-overlay")).toHaveCount(0);
    await expect(
      frame.getByRole("button", { name: "00:00:15 / 00:01:29", exact: true }),
    ).toBeVisible();
    return { backgroundBounds, viewportBounds, point };
  }
  const project = await api("/studio/projects", {
    body: {
      name: "Actual Svelte editor acceptance",
      clientId,
      envelope: {
        schemaVersion: 1,
        engine: "freecut",
        engineRevision: gpu.engineRevision,
        graph,
      },
    },
  });
  await api(`/studio/projects/${project.id}/lease/release`, {
    body: { clientId },
  });
  if (scenario === "ease-out") {
    await runEaseOutHost(project, graph);
  } else {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(() => {
      window.__hostWitness = [];
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (message, ...args) {
        if (message && typeof message === "object" && message.name === "stageDraft")
          window.__hostWitness.push({
            type: message.type,
            name: message.name,
            args: message.args,
          });
        return post.call(this, message, ...args);
      };
    });
    await context.addCookies([
      {
        name: "immich_access_token",
        value: auth.accessToken,
        url: base,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "immich_auth_type",
        value: "password",
        url: base,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "immich_is_authenticated",
        value: "true",
        url: base,
        sameSite: "Lax",
      },
    ]);
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      const u = new URL(r.url());
      requests.push({
        path: u.pathname,
        status: r.status(),
        method: r.request().method(),
      });
    });
    await page.goto(base + "/studio?project=" + project.id);
    await page.getByTestId("studio-editor-frame").waitFor({ timeout: 30000 });
    await page.waitForTimeout(6000);
    if (process.env.EXPECT_PROJECT_ONLY_MISSING === "1") {
      const f = page.frames().find((f) => f !== page.mainFrame());
      const body = await f.locator("body").innerText();
      assert.ok(body.includes("Missing media"));
      const check = await fetch(base + "/api/assets/" + asset.id, {
        headers: { authorization: "Bearer " + auth.accessToken },
      });
      assert.equal(check.status, 200);
      await page.screenshot({
        path: new URL("project-only-red.png", dir).pathname,
        fullPage: true,
      });
      await writeFile(
        new URL("project-only-red.json", dir),
        JSON.stringify(
          {
            projectId: project.id,
            assetId: asset.id,
            capabilities,
            body,
            requests,
            errors,
            originalAssetReadable: true,
            responseOverrides: 0,
          },
          null,
          2,
        ),
      );
      console.log(
        "PASS counterfactual actual project-only missing source with caller-readable asset",
      );
      throw new Error("EXPECTED_PROJECT_ONLY_RED");
    }
    await page.screenshot({
      path: new URL("mounted.png", dir).pathname,
      fullPage: true,
    });
    await writeFile(
      new URL("mounted.json", dir),
      JSON.stringify(
        {
          projectId: project.id,
          capabilities,
          requests,
          errors,
          frames: page.frames().map((f) => ({ url: f.url() })),
          body: await page.locator("body").innerText(),
        },
        null,
        2,
      ),
    );
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      await writeFile(
        new URL("frame-controls.json", dir),
        JSON.stringify(
          {
            body: await f.locator("body").innerText(),
            buttons: await f.locator("button").evaluateAll((es) =>
              es.map((e) => ({
                text: e.innerText,
                label: e.getAttribute("aria-label"),
                title: e.getAttribute("title"),
              })),
            ),
          },
          null,
          2,
        ),
      );
    }
    const frame = page.frameLocator("[data-testid=studio-editor-frame]");
    if (scenario === "auto-key") {
      await frame.locator('[data-item-id="still"]').click();
      await frame
        .getByRole("toolbar", { name: "Controls", exact: true })
        .getByRole("button", { name: "Show keyframe panel", exact: true })
        .click();
      await nativeFrame15(frame);
      const sheet = frame.getByTestId("dopesheet-scroll-area");
      await sheet
        .getByRole("button", {
          name: "Enable auto-key for Position",
          exact: true,
        })
        .click();
      const revisionResponse = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === `/api/studio/projects/${project.id}/revisions` &&
          r.status() === 201,
      );
      await sheet.getByLabel("Position X", { exact: true }).fill("12");
      await sheet
        .getByRole("button", {
          name: "Auto-key enabled for Position",
          exact: true,
        })
        .click();
      await frame.getByRole("button", { name: "Save project", exact: true }).click();
      await revisionResponse;
    } else {
      console.log("EDIT disable");
      await frame
        .getByRole("button", { name: "Disable track", exact: true })
        .click({ timeout: 10000 });
      console.log("WAIT enabled");
      await frame
        .getByRole("button", { name: "Enable track", exact: true })
        .waitFor({ timeout: 10000 });
      await page.waitForTimeout(4000);
      console.log("UNDO");
      await frame.getByRole("button", { name: /^Undo(?: |$)/ }).click({ timeout: 10000 });
      console.log("WAIT restored");
      await frame
        .getByRole("button", { name: "Disable track", exact: true })
        .waitFor({ timeout: 10000 });
      await page.waitForTimeout(4000);
      await frame.getByRole("button", { name: "Lock Track", exact: true }).click();
      await frame.getByRole("button", { name: "Unlock Track", exact: true }).waitFor();
      await frame.getByRole("button", { name: "Save project", exact: true }).click();
      await page.waitForTimeout(4000);
    }
    const saved = await api(`/studio/projects/${project.id}`);
    await writeFile(new URL("saved.json", dir), JSON.stringify(saved, null, 2));
    assert.ok(saved.revision >= 2);
    const stored = saved.envelope?.graph ?? saved.document?.graph ?? saved.graph;
    await writeFile(new URL("saved-shape.json", dir), JSON.stringify(Object.keys(saved)));
    assert.ok(stored, "stored graph");
    let interiorId;
    if (scenario === "auto-key") {
      interiorId = assertAutoKey(stored);
      assert.deepEqual(stored.timeline.tracks, graph.timeline.tracks);
      for (const original of graph.timeline.items) {
        const actual = stored.timeline.items.find((i) => i.id === original.id);
        assert.ok(actual);
        for (const [key, value] of Object.entries(original)) assert.deepEqual(actual[key], value);
      }
    } else {
      assert.equal(stored.timeline.tracks[0].visible, true);
      assert.equal(stored.timeline.tracks[0].locked, true);
    }
    const draftWitness = await page
      .frames()
      .find((f) => f !== page.mainFrame())
      .evaluate(() => window.__hostWitness ?? []);
    if (scenario === "auto-key") {
      const candidates = draftWitness.filter((w) =>
        w.args?.[0]?.timeline?.keyframes?.some(
          (e) =>
            e.itemId === "still" &&
            e.vectorProperties?.some((l) => l.keyframes?.some((k) => k.frame === 15)),
        ),
      );
      assert.ok(candidates.length);
      for (const w of candidates) assertAutoKey(w.args[0], interiorId);
    } else {
      assert.ok(draftWitness.some((w) => w.args?.[0]?.timeline?.tracks?.[0]?.visible === false));
      assert.ok(
        draftWitness.some(
          (w) =>
            w.args?.[0]?.timeline?.tracks?.[0]?.visible === true &&
            w.args?.[0]?.timeline?.tracks?.[0]?.locked === true,
        ),
      );
    }
    await writeFile(new URL("stage-drafts.json", dir), JSON.stringify(draftWitness, null, 2));
    await page.screenshot({
      path: new URL("edited.png", dir).pathname,
      fullPage: true,
    });
    const renderFrame = page.frames().find((f) => f !== page.mainFrame());
    const canvases = await renderFrame.locator("canvas,img,video").evaluateAll((es) =>
      es.map((e, i) => ({
        index: i,
        width: e.width,
        height: e.height,
        visible: e.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }),
        tag: e.tagName,
        rect: {
          width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height,
        },
      })),
    );
    await writeFile(new URL("canvases.json", dir), JSON.stringify(canvases, null, 2));
    const preview = renderFrame.locator("[data-player-container]:has([data-player-container])");
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible();
    const deselectionBefore =
      scenario === "auto-key" ? await deselectPreview(renderFrame, preview) : null;
    await writeFile(
      new URL("viewport-before.json", dir),
      JSON.stringify(
        {
          deselection: deselectionBefore,
          bounds: await preview.boundingBox(),
          children: await preview.locator("canvas,img,video").evaluateAll((es) =>
            es.map((e) => ({
              tag: e.tagName,
              width: e.width,
              height: e.height,
              visible: e.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
            })),
          ),
        },
        null,
        2,
      ),
    );
    await preview.screenshot({
      path: new URL("render-before.png", dir).pathname,
    });
    console.log(
      scenario === "auto-key"
        ? "PASS native auto-key stored in real revision"
        : "PASS edit undo real revision",
    );
    await page.goto(base + "/photos");
    const reopenRequestOffset = requests.length;
    await page.goto(base + "/studio?project=" + project.id);
    assert.equal(new URL(page.url()).searchParams.has("assets"), false);
    if (scenario === "auto-key") {
      const f = page.frameLocator("[data-testid=studio-editor-frame]");
      await f.locator("[data-item-id=still]").waitFor({ timeout: 30000 });
      await f.locator("[data-item-id=still]").click();
      await f
        .getByRole("toolbar", { name: "Controls", exact: true })
        .getByRole("button", { name: "Show keyframe panel", exact: true })
        .click();
      await nativeFrame15(f);
      await expect(
        f.getByTestId("dopesheet-scroll-area").getByLabel("Position X", { exact: true }),
      ).toHaveValue("12");
    } else {
      await page
        .frameLocator("[data-testid=studio-editor-frame]")
        .getByRole("button", { name: "Unlock Track", exact: true })
        .waitFor({ timeout: 30000 });
    }
    await page.waitForTimeout(2500);
    const reloadFrame = page.frames().find((f) => f !== page.mainFrame());
    const reopenedPreview = reloadFrame.locator(
      "[data-player-container]:has([data-player-container])",
    );
    await expect(reopenedPreview).toHaveCount(1);
    await expect(reopenedPreview).toBeVisible();
    const deselectionAfter =
      scenario === "auto-key" ? await deselectPreview(reloadFrame, reopenedPreview) : null;
    await writeFile(
      new URL("viewport-after.json", dir),
      JSON.stringify(
        {
          deselection: deselectionAfter,
          bounds: await reopenedPreview.boundingBox(),
          children: await reopenedPreview.locator("canvas,img,video").evaluateAll((es) =>
            es.map((e) => ({
              tag: e.tagName,
              width: e.width,
              height: e.height,
              visible: e.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
            })),
          ),
        },
        null,
        2,
      ),
    );
    await reopenedPreview.screenshot({
      path: new URL("render-after.png", dir).pathname,
    });
    const beforePixels = await sharp(new URL("render-before.png", dir).pathname)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const afterPixels = await sharp(new URL("render-after.png", dir).pathname)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(afterPixels.info, beforePixels.info);
    let differing = 0,
      maxEdgeDifference = 0,
      interiorDiffering = 0;
    const differingRows = new Set();
    for (let i = 0; i < beforePixels.data.length; i++) {
      const delta = Math.abs(beforePixels.data[i] - afterPixels.data[i]);
      if (delta) {
        differing++;
        const row = Math.floor(i / (beforePixels.info.width * beforePixels.info.channels));
        differingRows.add(row);
        maxEdgeDifference = Math.max(maxEdgeDifference, delta);
        if (row > 0 && row < beforePixels.info.height - 1) interiorDiffering++;
      }
    }
    assert.equal(interiorDiffering, 0, "displayed interior render pixels differ");
    const midpoint =
      (Math.floor(beforePixels.info.height / 2) * beforePixels.info.width +
        Math.floor(beforePixels.info.width / 2)) *
      beforePixels.info.channels;
    const center = [...beforePixels.data.subarray(midpoint, midpoint + 3)];
    assert.ok(
      center.every((v, i) => Math.abs(v - [204, 68, 34][i]) <= 5),
      "actual source image render",
    );
    const reloaded = await api(`/studio/projects/${project.id}`);
    const reopenedGraph = reloaded.envelope?.graph ?? reloaded.document?.graph ?? reloaded.graph;
    assert.deepEqual(reopenedGraph, stored);
    if (scenario === "auto-key") assertAutoKey(reopenedGraph, interiorId);
    const reopenRequests = requests.slice(reopenRequestOffset);
    assert.deepEqual(
      reopenRequests.filter(
        (r) =>
          r.method === "GET" &&
          (r.path === "/api/assets" ||
            r.path === "/api/assets/search" ||
            r.path === "/api/search" ||
            r.path.startsWith("/api/search/")),
      ),
      [],
      "project-only reopen must not search or list assets",
    );
    await page.screenshot({
      path: new URL("reloaded.png", dir).pathname,
      fullPage: true,
    });
    await writeFile(
      new URL("host-result.json", dir),
      JSON.stringify(
        {
          source: process.env.SOURCE_SHA,
          scenario,
          interiorId,
          projectId: project.id,
          revision: saved.revision,
          capabilities,
          draftWitness,
          requests,
          errors,
          graph: stored,
          reloadedGraphEqual: true,
          reopenRequests,
          projectOnlyReopenWithoutAssetSearch: true,
          renderInteriorEqual: true,
          renderCenter: center,
          renderBoundary: {
            differing,
            maxEdgeDifference,
            differingRows: [...differingRows],
            pixelIdentity: false,
          },
          responseOverrides: 0,
        },
        null,
        2,
      ),
    );
    console.log(
      scenario === "auto-key"
        ? "PASS native auto-key→stageDraft→real revision→project-only reopen same v2 key"
        : "PASS actual edit→undo→second edit→stageDraft→real revision→navigate/reload same graph",
    );
  }
} catch (error) {
  if (error.message !== "EXPECTED_PROJECT_ONLY_RED") throw error;
} finally {
  if (page) {
    await page
      .screenshot({
        path: new URL("terminal.png", dir).pathname,
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      new URL("terminal-ui.json", dir),
      JSON.stringify(
        {
          url: page.url(),
          body: await page.locator("body").innerText(),
          frames: await Promise.all(
            page.frames().map(async (f) => ({
              url: f.url(),
              body: await f
                .locator("body")
                .innerText()
                .catch(() => ""),
              draftWitness: await f.evaluate(() => window.__hostWitness ?? []).catch(() => []),
              buttons: await f
                .locator("button")
                .evaluateAll((es) =>
                  es.map((e) => ({
                    label: e.getAttribute("aria-label"),
                    text: e.innerText,
                    disabled: e.disabled,
                  })),
                )
                .catch(() => []),
            })),
          ),
        },
        null,
        2,
      ),
    );
  }
  if (browser) await browser.close();
  if (worker && auth) await api("/admin/render-workers/" + worker.id, { method: "DELETE" });
  await writeFile(new URL("partial.json", dir), JSON.stringify({ requests, errors }, null, 2));
}

/** Actual host/native edits only; no fixture store hook or substituted render. */
async function runEaseOutHost(project, graph) {
  const browserName = process.env.BROWSER ?? "chromium";
  assert.ok(["chromium", "firefox"].includes(browserName));
  const harness = createHarness({ upstream: base });
  const harnessOrigin = await harness.listen();
  let driver, host;
  const renders = {};
  const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 60; i++) {
    const t = (lo + hi) / 2;
    if (cubic(t, 0, 0.58) < 0.5) lo = t;
    else hi = t;
  }
  const expectedX = -24 + 48 * cubic((lo + hi) / 2, 0, 1);
  assert.ok(Math.abs(expectedX - 8.8628729965) < 1e-8);
  const graphOf = (detail) => detail.envelope?.graph ?? detail.document?.graph ?? detail.graph;
  const assertEasing = (stored, easing) => {
    assert.equal(stored.metadata.width, 128);
    assert.equal(stored.metadata.height, 96);
    assert.equal(stored.metadata.fps, 30);
    const entry = stored.timeline.keyframes.find((e) => e.itemId === "still");
    assert.equal(entry.animationVersion, 2);
    assert.deepEqual(entry.properties, graph.timeline.keyframes[0].properties);
    const lane = entry.vectorProperties.find((p) => p.property === "position");
    assert.deepEqual(
      lane.keyframes,
      graph.timeline.keyframes[0].vectorProperties[0].keyframes.map((k, i) => ({
        ...k,
        ...(i === 0 ? { easing } : {}),
      })),
    );
    assert.deepEqual(stored.timeline.tracks, graph.timeline.tracks);
    for (const [key, value] of Object.entries(graph.timeline.items[0]))
      assert.deepEqual(stored.timeline.items[0][key], value);
  };
  const readRevision = async (easing) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const detail = await api(`/studio/projects/${project.id}`);
      try {
        assertEasing(graphOf(detail), easing);
        return detail;
      } catch (error) {
        if (Date.now() + 100 >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("real saved revision did not settle");
  };
  const button = (label) => `button[aria-label=${JSON.stringify(label)}]`;
  const selectInline = async (frame) => {
    await frame.waitForFunction(() => !!document.querySelector('[data-item-id="still"]'));
    await frame.click('[data-item-id="still"]');
    await frame.waitForFunction(
      () =>
        !!document.querySelector(
          '[role="toolbar"][aria-label="Controls"] button[aria-label$="keyframe panel"]',
        ),
    );
    const alreadyOpen = await frame.evaluate(
      () =>
        !!document.querySelector(
          '[role="toolbar"][aria-label="Controls"] button[aria-label="Hide keyframe panel"][aria-pressed="true"]',
        ),
    );
    if (!alreadyOpen)
      await frame.click(
        '[role="toolbar"][aria-label="Controls"] button[aria-label="Show keyframe panel"]',
      );
    await frame.waitForFunction(
      () => !!document.querySelector('[data-testid="row-keyframe-x-k0"]'),
    );
    await frame.click('[data-testid="row-keyframe-x-k0"]');
  };
  const seek = async (frame, n) => {
    // Same native timecode acknowledgement as the owner runner; the portable driver reads
    // the unique visible button via W3C rather than Playwright expect. Never add seek clicks.
    const acknowledge = async (index) => {
      const timecode = `00:${String(Math.floor(index / 30)).padStart(2, "0")}:${String(index % 30).padStart(2, "0")} / 00:01:29`;
      const deadline = Date.now() + 30000;
      for (;;) {
        const count = await frame.evaluate(
          (expected) =>
            [...document.querySelectorAll("button")].filter(
              (button) => button.checkVisibility() && button.textContent.trim() === expected,
            ).length,
          timecode,
        );
        if (count === 1) return;
        assert.ok(
          Date.now() < deadline,
          `native timecode acknowledgement ${timecode}: ${count} visible buttons`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await frame.click(button("Go To Start"));
    await acknowledge(0);
    for (let i = 1; i <= n; i++) {
      await frame.click(button("Next Frame"));
      await acknowledge(i);
    }
  };
  const pixelRead = async (frame, x, label) => {
    const deadline = Date.now() + 30000;
    let result;
    while (Date.now() < deadline) {
      result = await frame.evaluate(async (expected) => {
        const viewports = [
          ...document.querySelectorAll("[data-player-container]:has([data-player-container])"),
        ].filter((viewport) => viewport.checkVisibility());
        if (viewports.length !== 1)
          return { error: `expected one visible native viewport; got${viewports.length}` };
        const canvases = [...viewports[0].querySelectorAll("canvas")].filter((c) =>
          c.checkVisibility(),
        );
        if (canvases.length !== 1)
          return { error: `expected one visible native preview; got${canvases.length}` };
        const canvas = canvases[0];
        const rawPng = canvas.toDataURL("image/png");
        const bounds = (element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        const evidence = {
          rawPng,
          backing: { width: canvas.width, height: canvas.height },
          canvasCss: bounds(canvas),
          viewportCss: bounds(viewports[0]),
          dpr: window.devicePixelRatio,
        };
        const image = new Image();
        image.src = rawPng;
        await image.decode();
        const raw = new OffscreenCanvas(canvas.width, canvas.height);
        const rawContext = raw.getContext("2d");
        rawContext.drawImage(image, 0, 0);
        const hash = async (bytes) =>
          [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
        evidence.rawDigest = await hash(
          rawContext.getImageData(0, 0, canvas.width, canvas.height).data,
        );
        const padX = (canvas.width - 128) / 2;
        const padY = (canvas.height - 96) / 2;
        if (!Number.isInteger(padX) || padX !== padY || padX < 1 || padX > 256)
          return {
            ...evidence,
            error: `invalid symmetric preview padding mapping: ${padX},${padY}`,
          };
        const mapping = {
          sourceRect: { x: padX, y: padY, width: 128, height: 96 },
          destinationRect: { x: 0, y: 0, width: 128, height: 96 },
          scale: 1,
        };
        const actual = new OffscreenCanvas(128, 96),
          ctx = actual.getContext("2d");
        // Match copyPreviewDisplayCanvasContent: retain every authored edge pixel, without scaling.
        ctx.drawImage(raw, padX, padY, 128, 96, 0, 0, 128, 96);
        const oracle = new OffscreenCanvas(128, 96),
          ref = oracle.getContext("2d");
        // Compare RGB on opaque black background, including native subpixel edge coverage.
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 128, 96);
        ref.fillStyle = "#000";
        ref.fillRect(0, 0, 128, 96);
        ref.fillStyle = "#ff0000";
        ref.fillRect(64 + expected - 8, 48 - 8, 16, 16);
        const pixels = ctx.getImageData(0, 0, 128, 96).data,
          expectedPixels = ref.getImageData(0, 0, 128, 96).data;
        let maxDelta = 0;
        for (let i = 0; i < pixels.length; i++)
          maxDelta = Math.max(maxDelta, Math.abs(pixels[i] - expectedPixels[i]));
        const digest = await hash(pixels);
        const png = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          actual
            .convertToBlob({ type: "image/png" })
            .then((blob) => reader.readAsDataURL(blob), reject);
        });
        return { ...evidence, mapping, maxDelta, digest, png, expectedX: expected };
      }, x);
      if (!result.error && result.maxDelta <= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await writeFile(
      new URL(`${browserName}-${label}-measurement.json`, dir),
      JSON.stringify(result, null, 2),
    );
    if (result.rawPng)
      await writeFile(
        new URL(`${browserName}-${label}-padded-raw.png`, dir),
        Buffer.from(result.rawPng.split(",")[1], "base64"),
      );
    if (result.png)
      await writeFile(
        new URL(`${browserName}-${label}.png`, dir),
        Buffer.from(result.png.split(",")[1], "base64"),
      );
    assert.ok(!result.error, result.error);
    assert.ok(
      result.maxDelta <= 1,
      `${label}: independent actual preview pixel delta ${result.maxDelta}`,
    );
    renders[label] = result;
    return result;
  };
  try {
    driver =
      browserName === "chromium"
        ? await createChromiumDriver({ harnessOrigin, chromium })
        : await createWebDriverClassicDriver({
            endpoint: process.env.WEBDRIVER_ENDPOINT,
            harnessOrigin,
            capabilities: {
              browserName: "firefox",
              "moz:firefoxOptions": {
                binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
                args: ["-headless"],
                prefs: { "network.proxy.allow_hijacking_localhost": true },
              },
            },
          });
    host = await driver.newPage();
    await host.goto(base + "/auth/login");
    await host.waitForFunction(() => !!document.querySelector("#auth-email"));
    await host.fill("#auth-email", "admitted-host@example.test");
    await host.fill("#auth-password", "Fixture-host-only-password-24!");
    await host.click('button.auth-submit[type="submit"]');
    await host.waitForFunction(() => location.pathname !== "/auth/login");
    if (await host.evaluate(() => location.pathname === "/auth/onboarding")) {
      await host.waitForFunction(() => {
        const buttons = [
          ...document.querySelectorAll(".frs-tool-root .frs-tool-foot button.primary"),
        ];
        return (
          buttons.length === 1 &&
          buttons[0].checkVisibility() &&
          !buttons[0].disabled &&
          buttons[0].textContent.trim() === "Done"
        );
      });
      await host.click(".frs-tool-root .frs-tool-foot button.primary");
    }
    await host.waitForFunction(() => !location.pathname.startsWith("/auth/"));
    await host.goto(base + "/studio?project=" + project.id);
    await host.waitForFunction(
      () => !!document.querySelector('[data-testid="studio-editor-frame"]'),
    );
    // Pass-through status observation only: preserves every fetch request/response unchanged.
    await host.evaluate(() => {
      window.__fl112Responses = [];
      const original = window.fetch;
      window.fetch = async function (...args) {
        const response = await original.apply(this, args);
        window.__fl112Responses.push({ url: response.url, status: response.status });
        return response;
      };
    });
    await host.inFrame('[data-testid="studio-editor-frame"]', async (frame) => {
      const support = await frame.evaluate(() => ({
        webGpu: !!navigator.gpu,
        webCodecs: typeof VideoDecoder === "function",
      }));
      assert.ok(
        support.webGpu && support.webCodecs,
        `${browserName} genuine local preview unavailable; remote worker execution required, no fixture fallback`,
      );
      await selectInline(frame);
      await seek(frame, 15);
      const baseline = await pixelRead(frame, 0, "baseline");
      await frame.click(button("Set interpolation to Ease Out"));
      await frame.waitForFunction(
        () =>
          document
            .querySelector('button[aria-label="Set interpolation to Ease Out"]')
            ?.getAttribute("aria-pressed") === "true",
      );
      const oracle = process.env.FL112_HOST_COUNTERFACTUAL === "linear-ease-out" ? 0 : expectedX;
      const changed = await pixelRead(frame, oracle, "ease-out");
      assert.notEqual(changed.digest, baseline.digest);
      await frame.shortcut("z");
      await frame.waitForFunction(
        () =>
          document
            .querySelector('button[aria-label="Set interpolation to Linear"]')
            ?.getAttribute("aria-pressed") === "true",
      );
      assert.equal((await pixelRead(frame, 0, "undo")).digest, baseline.digest);
      await frame.shortcut("z", true);
      await frame.waitForFunction(
        () =>
          document
            .querySelector('button[aria-label="Set interpolation to Ease Out"]')
            ?.getAttribute("aria-pressed") === "true",
      );
      assert.equal((await pixelRead(frame, expectedX, "redo")).digest, changed.digest);
      await seek(frame, 0);
      await pixelRead(frame, -24, "start");
      await seek(frame, 30);
      await pixelRead(frame, 24, "end");
      // Save remains the actual editor control; no API graph writes after initial seed.
      await frame.click(button("Save project"));
    });
    const saved = await readRevision("ease-out");
    assert.ok(saved.revision >= 2);
    const statuses = await host.evaluate(() => window.__fl112Responses);
    assert.ok(
      statuses.some(
        (r) =>
          new URL(r.url).pathname === `/api/studio/projects/${project.id}/revisions` &&
          r.status === 201,
      ),
      "actual browser revision201",
    );
    await host.goto(base + "/photos");
    const offset = harness.observations.length;
    await host.goto(base + "/studio?project=" + project.id);
    await host.waitForFunction(
      () => !!document.querySelector('[data-testid="studio-editor-frame"]'),
    );
    assert.equal(
      await host.evaluate(() => new URL(location.href).searchParams.has("assets")),
      false,
    );
    // Second navigation to the same real project is an actual host reload, not local JSON seeding.
    await host.goto(base + "/studio?project=" + project.id);
    await host.inFrame('[data-testid="studio-editor-frame"]', async (frame) => {
      await selectInline(frame);
      await frame.waitForFunction(
        () =>
          document
            .querySelector('button[aria-label="Set interpolation to Ease Out"]')
            ?.getAttribute("aria-pressed") === "true",
      );
      await seek(frame, 15);
      assert.equal(
        (await pixelRead(frame, expectedX, "reopen")).digest,
        renders["ease-out"].digest,
      );
    });
    const reopened = await api(`/studio/projects/${project.id}`);
    assert.deepEqual(graphOf(reopened), graphOf(saved));
    const reopenRequests = harness.observations.slice(offset);
    assert.deepEqual(
      reopenRequests.filter(
        (r) =>
          r.method === "GET" &&
          /^\/api\/(?:assets(?:\/search)?|search(?:\/.*)?)$/.test(new URL(r.url).pathname),
      ),
      [],
    );
    assert.equal(harness.observations.filter((r) => r.kind === "override").length, 0);
    await writeFile(
      new URL(`${browserName}-ease-out-host.json`, dir),
      JSON.stringify(
        {
          browser: browserName,
          source: process.env.SOURCE_SHA,
          fixture: "readme.keyframe-animation.2/ease-out",
          expectedX,
          userAgent: await host.evaluate(() => navigator.userAgent),
          projectId: project.id,
          saved,
          reopened,
          statuses,
          renders,
          reopenRequests,
          requests: harness.observations,
          responseOverrides: 0,
          backendProjectPersistence: "real revision/reopen",
          export: "not-tested",
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (host)
      await writeFile(
        new URL(`${browserName}-terminal.png`, dir),
        Buffer.from(await host.screenshot(), "base64"),
      ).catch(() => {});
    if (host) {
      await writeFile(
        new URL(`${browserName}-terminal-ui.json`, dir),
        JSON.stringify(
          {
            main: await host
              .evaluate(() => ({
                url: location.href,
                body: document.body.innerText,
                userAgent: navigator.userAgent,
              }))
              .catch((error) => ({ error: String(error) })),
            frame: await host
              .inFrame('[data-testid="studio-editor-frame"]', (frame) =>
                frame.evaluate(() => ({
                  body: document.body.innerText,
                  buttons: [...document.querySelectorAll("button")].map((button) => ({
                    label: button.getAttribute("aria-label"),
                    disabled: button.disabled,
                  })),
                  canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
                    width: canvas.width,
                    height: canvas.height,
                    visible: canvas.checkVisibility(),
                  })),
                })),
              )
              .catch((error) => ({ error: String(error) })),
          },
          null,
          2,
        ),
      );
    }
    if (driver) await driver.close();
    await harness.close();
    await writeFile(
      new URL(`${browserName}-requests.json`, dir),
      JSON.stringify(harness.observations, null, 2),
    );
  }
}
