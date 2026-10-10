// FL-97: execute only after full prepare, correct adapted digest and exclusive GPU window.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { chromeLaunchArgs } from "../engine/headless/lib/cli.mjs";
import { testedSource } from "./lib/working-domain-report.mjs";
const source = await testedSource(new URL(import.meta.url));
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const origin = process.env.STUDIO_TEST_ORIGIN || "http://127.0.0.1:5186";
const browser = await chromium.launch({
  headless: true,
  args: chromeLaunchArgs(),
});
try {
  const page = await browser.newPage();
  await page.route(origin + "/linear-additive-probe", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type;
window.__vite_plugin_react_preamble_installed__=true;</script>`,
    }),
  );
  await page.goto(origin + "/linear-additive-probe");
  await page.waitForFunction(
    () => window.__vite_plugin_react_preamble_installed__ === true,
  );
  const result = await page.evaluate(async () => {
    const { EffectsPipeline } =
      await import("/src/infrastructure/gpu-effects/effects-pipeline.ts");
    const { TransitionPipeline } =
      await import("/src/infrastructure/gpu-transitions/transition-pipeline.ts");
    const { HdrRenderUnavailableError } =
      await import("/src/shared/graphics/color/managed-color.ts");
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error("WebGPU required");
    // Diagnostic-only viewport injection on the third (transition) pass. The two
    // production ingress passes keep their native texel coordinates. At output
    // pixel x=1, shifted viewport UV=.5 forces actual bilinear filtering between
    // hidden and visible columns in the unchanged production transition shader.
    let fractionalDraw = false;
    let shiftedPasses = 0;
    const probeDevice = new Proxy(device, {
      get(target, key) {
        if (key === "createCommandEncoder")
          return (...args) => {
            const encoder = target.createCommandEncoder(...args);
            let passes = 0;
            return new Proxy(encoder, {
              get(e, k) {
                if (k === "beginRenderPass")
                  return (...a) => {
                    const pass = e.beginRenderPass(...a);
                    const index = ++passes;
                    return new Proxy(pass, {
                      get(r, m) {
                        if (m === "draw")
                          return (...drawArgs) => {
                            if (fractionalDraw && index === 3) {
                              r.setViewport(0.5, 0, 2, 2, 0, 1);
                              shiftedPasses++;
                            }
                            return r.draw(...drawArgs);
                          };
                        const value = Reflect.get(r, m, r);
                        return typeof value === "function"
                          ? value.bind(r)
                          : value;
                      },
                    });
                  };
                const value = Reflect.get(e, k, e);
                return typeof value === "function" ? value.bind(e) : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pipeline = TransitionPipeline.create(probeDevice);
    if (!pipeline) throw new Error("Transition pipeline required");
    const textures = [];
    const buffers = [];
    const texture = (rgba, format = "rgba16float") => {
      const t = device.createTexture({
        size: [2, 2],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      textures.push(t);
      if (rgba)
        device.queue.writeTexture(
          { texture: t },
          new Float16Array(
            (Array.isArray(rgba[0])
              ? rgba
              : Array.from({ length: 4 }, () => rgba)
            ).flat(),
          ),
          { bytesPerRow: 16 },
          [2, 2],
        );
      return t;
    };
    const direct = async (
      left,
      right,
      p,
      alpha = "straight",
      range = "hdr",
      fractional = false,
    ) => {
      fractionalDraw = fractional;
      const before = shiftedPasses;
      pipeline.setWorkingRange(range);
      const out = texture();
      device.pushErrorScope("validation");
      if (
        !pipeline.renderTexturesToTexture(
          "additiveDissolve",
          texture(left),
          texture(right),
          out,
          p,
          2,
          2,
          undefined,
          undefined,
          alpha,
          "straight",
        )
      )
        throw new Error("Transition rejected");
      const buffer = device.createBuffer({
        size: 512,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(buffer);
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: out },
        { buffer, bytesPerRow: 256 },
        [2, 2],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const values = Array.from(
        new Float16Array(buffer.getMappedRange(), fractional ? 8 : 0, 4),
      );
      buffer.unmap();
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      if (fractional && shiftedPasses !== before + 1)
        throw new Error("Expected exactly one transition viewport injection");
      fractionalDraw = false;
      return values;
    };
    try {
      const opaque = [2, -0.5, 0.25, 1];
      const other = [-0.25, 3, -1, 1];
      const endpoints = [];
      for (const p of [0, 0.5, 1])
        endpoints.push(await direct(opaque, other, p));
      const reference = await direct([1, 1, 1, 1], [1, 1, 1, 1], 0.5);
      const unequal = await direct(
        [2, -0.5, 0.25, 0.5],
        [4, 0.25, -1, 0.25],
        0.5,
      );
      const premultiplied = await direct(
        [1, -0.25, 0.125, 0.5],
        [0, 0, 0, 0],
        0.5,
        "premultiplied",
      );
      const hidden = await direct(
        [100, -100, 20, 0],
        [2, -0.5, 0.25, 0.5],
        0.5,
      );
      const hiddenPremultiplied = await direct(
        [100, -100, 20, 0],
        [1, -0.25, 0.125, 0.5],
        0.5,
        "premultiplied",
      );
      const zero = [];
      for (const p of [0, 0.5, 1])
        zero.push(
          await direct(
            [100, -100, 20, 0],
            [-100, 100, -20, 0],
            p,
            "premultiplied",
          ),
        );
      // Half-float minimum positive subnormal (2^-24) must survive ingress;
      // at midpoint mixed coverage 2^-25 rounds to zero, with canonical zero RGB.
      const tinyCoverage = 2 ** -24;
      const tiny = [];
      for (const p of [0, 0.5, 1])
        tiny.push(
          await direct([2, -2, 4, tinyCoverage], [100, -100, 20, 0], p),
        );
      const subnormalTies = [];
      for (const units of [3, 5, 7])
        subnormalTies.push(
          await direct([2, -2, 4, units * tinyCoverage], [100, -100, 20, 0], 0.5),
        );
      // Also retain representable small positive midpoint coverage, not only zero.
      const small = await direct(
        [2, -0.5, 0.25, 2 ** -10],
        [100, -100, 20, 0],
        0.5,
      );
      const columns = (hidden, visible) => [hidden, visible, hidden, visible];
      const spatial = [];
      for (const alpha of ["straight", "premultiplied"]) {
        const visible =
          alpha === "straight" ? [2, -0.5, 0.25, 0.5] : [1, -0.25, 0.125, 0.5];
        spatial.push(
          await direct(
            columns([100, -100, 20, 0], visible),
            [0, 0, 0, 0],
            0,
            alpha,
            "hdr",
            true,
          ),
        );
      }
      const sdr = await direct(
        [0.8, 0.6, 0.2, 1],
        [0.8, 0.6, 0.2, 1],
        0.5,
        "straight",
        "sdr",
      );
      pipeline.setWorkingRange("hdr");
      const refusals = [];
      for (const id of [
        "nonAdditiveDissolve",
        "lightLeakBurn",
        "filmGateSlip",
        "sparkles",
        "chromatic",
        "lensWarpZoom",
        "liquidDistort",
        "dissolve",
      ]) {
        let error;
        try {
          pipeline.renderTexturesToTexture(
            id,
            texture(opaque),
            texture(opaque),
            texture(),
            0.5,
            2,
            2,
          );
        } catch (e) {
          error = e;
        }
        if (!(error instanceof HdrRenderUnavailableError))
          throw new Error("Missing typed refusal " + id);
        refusals.push(id);
      }
      for (const route of ["canvas", "rgba8-output"]) {
        let error;
        try {
          if (route === "canvas")
            pipeline.render(
              "additiveDissolve",
              new OffscreenCanvas(2, 2),
              new OffscreenCanvas(2, 2),
              0.5,
              2,
              2,
            );
          else
            pipeline.renderTexturesToTexture(
              "additiveDissolve",
              texture(opaque),
              texture(opaque),
              texture(null, "rgba8unorm"),
              0.5,
              2,
              2,
            );
        } catch (e) {
          error = e;
        }
        if (!(error instanceof HdrRenderUnavailableError))
          throw new Error("Missing boundary refusal " + route);
      }
      // A real top-level image transition must pass caller admission and boost white above 203 nits.
      const { createCompositionRenderer } =
        await import("/src/features/export/utils/client-render-engine.ts");
      const imageCanvas = new OffscreenCanvas(16, 16);
      const imageCtx = imageCanvas.getContext("2d");
      imageCtx.fillStyle = "#fff";
      imageCtx.fillRect(0, 0, 16, 16);
      const blob = await imageCanvas.convertToBlob({ type: "image/png" });
      const url = URL.createObjectURL(blob);
      const clip = (id, from) => ({
        id,
        type: "image",
        trackId: "clips",
        from,
        durationInFrames: 40,
        label: id,
        src: url,
        sourceWidth: 16,
        sourceHeight: 16,
        transform: {
          x: 0,
          y: 0,
          width: 16,
          height: 16,
          rotation: 0,
          opacity: 1,
        },
      });
      const composition = {
        fps: 30,
        width: 16,
        height: 16,
        durationInFrames: 80,
        backgroundColor: "#000000",
        colorManagement: { workingRange: "hdr", referenceWhiteNits: 203 },
        keyframes: [],
        tracks: [
          {
            id: "clips",
            name: "clips",
            height: 60,
            locked: false,
            visible: true,
            muted: false,
            solo: false,
            order: 0,
            items: [clip("left", 0), clip("right", 40)],
          },
        ],
        transitions: [
          {
            id: "cut",
            type: "crossfade",
            presentation: "additiveDissolve",
            timing: "linear",
            trackId: "clips",
            leftClipId: "left",
            rightClipId: "right",
            durationInFrames: 10,
            alignment: 0.5,
          },
        ],
      };
      const canvas = new OffscreenCanvas(16, 16);
      const renderer = await createCompositionRenderer(
        composition,
        canvas,
        canvas.getContext("2d"),
        { mode: "export" },
      );
      let composed;
      try {
        await renderer.preload?.();
        const frame = await renderer.renderFrameSignal(40, "pq");
        composed = Array.from(frame.rgba).slice(
          (8 * 16 + 8) * 4,
          (8 * 16 + 8) * 4 + 4,
        );
      } finally {
        renderer.dispose();
      }
      // Inject a float-render failure at the production pipeline boundary. A fresh
      // composition renderer must propagate the typed refusal without Canvas output.
      const renderTextures =
        TransitionPipeline.prototype.renderTexturesToTexture;
      const hasTransition = TransitionPipeline.prototype.has;
      let failureRefusal;
      let unavailableRefusal;
      let injectedFailures = 0;
      let failedRenderer;
      try {
        TransitionPipeline.prototype.renderTexturesToTexture = function (
          id,
          ...args
        ) {
          if (id === "additiveDissolve") {
            injectedFailures++;
            return false;
          }
          return renderTextures.call(this, id, ...args);
        };
        const failedCanvas = new OffscreenCanvas(16, 16);
        failedRenderer = await createCompositionRenderer(
          composition,
          failedCanvas,
          failedCanvas.getContext("2d"),
          { mode: "export" },
        );
        await failedRenderer.preload?.();
        try {
          await failedRenderer.renderFrameSignal(40, "pq");
          throw new Error("Failed HDR float route unexpectedly completed");
        } catch (error) {
          if (!(error instanceof HdrRenderUnavailableError)) throw error;
          failureRefusal = { errorType: error.name, reason: error.message };
        }
        if (injectedFailures !== 1)
          throw new Error("Expected one real composition float failure");
        failedRenderer.dispose();
        TransitionPipeline.prototype.renderTexturesToTexture = renderTextures;
        TransitionPipeline.prototype.has = function (id) {
          return id === "additiveDissolve"
            ? false
            : hasTransition.call(this, id);
        };
        const unavailableCanvas = new OffscreenCanvas(16, 16);
        failedRenderer = await createCompositionRenderer(
          composition,
          unavailableCanvas,
          unavailableCanvas.getContext("2d"),
          { mode: "export" },
        );
        await failedRenderer.preload?.();
        try {
          await failedRenderer.renderFrameSignal(40, "pq");
          throw new Error("Unavailable HDR float route unexpectedly completed");
        } catch (error) {
          if (!(error instanceof HdrRenderUnavailableError)) throw error;
          if (
            error.message !==
            "Linear HDR additive transition could not render to a float texture"
          )
            throw error;
          unavailableRefusal = { errorType: error.name, reason: error.message };
        }
      } finally {
        TransitionPipeline.prototype.renderTexturesToTexture = renderTextures;
        TransitionPipeline.prototype.has = hasTransition;
        failedRenderer?.dispose();
        URL.revokeObjectURL(url);
      }
      return {
        browser: { userAgent: navigator.userAgent },
        gpu: device.adapterInfo
          ? {
              vendor: device.adapterInfo.vendor,
              architecture: device.adapterInfo.architecture,
              device: device.adapterInfo.device,
              description: device.adapterInfo.description,
            }
          : null,
        endpoints,
        reference,
        unequal,
        premultiplied,
        hidden,
        hiddenPremultiplied,
        zero,
        tiny,
        subnormalTies,
        small,
        spatial,
        shiftedPasses,
        sdr,
        refusals,
        composed,
        failureRefusal,
        unavailableRefusal,
        injectedFailures,
      };
    } finally {
      pipeline.destroy();
      textures.forEach((t) => t.destroy());
      buffers.forEach((b) => b.destroy());
    }
  });
  const near = (got, want, tolerance = 0.004) =>
    got.forEach((v, i) =>
      assert.ok(Math.abs(v - want[i]) <= tolerance, `${got} != ${want}`),
    );
  near(result.endpoints[0], [2, -0.5, 0.25, 1]);
  near(result.endpoints[1], [1.26, 1.8, -0.54, 1]);
  near(result.endpoints[2], [-0.25, 3, -1, 1]);
  near(result.reference, [1.44, 1.44, 1.44, 1]);
  near(result.unequal, [3.84, -0.36, -0.24, 0.375]);
  for (const key of ["premultiplied", "hidden", "hiddenPremultiplied"])
    near(result[key], [2.88, -0.72, 0.36, 0.25]);
  near(result.tiny[0], [2, -2, 4, 2 ** -24], 0);
  near(result.tiny[1], [0, 0, 0, 0], 0);
  near(result.tiny[2], [0, 0, 0, 0], 0);
  result.subnormalTies.forEach((got, i) => {
    near(got, [2.88, -2.88, 5.76, [2, 2, 4][i] * 2 ** -24]);
    assert.equal(got[3], [2, 2, 4][i] * 2 ** -24);
  });
  near(result.small, [2.88, -0.72, 0.36, 2 ** -11]);
  assert.equal(result.small[3], 2 ** -11);
  result.spatial.forEach((got) => near(got, [2, -0.5, 0.25, 0.25]));
  assert.equal(result.shiftedPasses, 2);
  result.zero.forEach((got) => near(got, [0, 0, 0, 0], 0));
  near(result.sdr, [1, 0.864, 0.288, 1]);
  // PQ 203 cd/m² is .580688881: a cut/SDR clamp cannot satisfy this positive flash control.
  assert(
    result.composed.slice(0, 3).every((v) => v > 0.6 && v < 0.64),
    `top-level HDR transition ${result.composed}`,
  );
  assert.deepEqual(
    await testedSource(new URL(import.meta.url)),
    source,
    "prepared inputs changed during measurement",
  );
  const report = {
    toolchain: { execPath: process.execPath, node: process.version },
    browserVersion: await browser.version(),
    source,
    result,
    check:
      "dedicated additive linear HDR GPU readback and real composition admission",
  };
  if (process.env.STUDIO_ADDITIVE_REPORT)
    await writeFile(process.env.STUDIO_ADDITIVE_REPORT, JSON.stringify(report));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
