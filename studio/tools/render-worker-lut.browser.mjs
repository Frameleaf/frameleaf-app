// Actual GPU numerical oracle for the execution-only raw-output Cube representation.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { withEffectsMatrixPage } from "./effects-matrix.browser.mjs";
export async function runFileLutMatrix(
  origin = process.env.STUDIO_TEST_ORIGIN || "http://127.0.0.1:5186",
) {
  const report = await withEffectsMatrixPage({ origin }, (page) =>
    page.evaluate(async () => {
      const { EffectsPipeline } =
        await import("/src/infrastructure/gpu-effects/index.ts");
      const { materializeCubeFileLut } =
        await import("/src/infrastructure/gpu-effects/lut/file-lut.ts");
      const { getGpuEffect, getGpuEffectsByCategory } =
        await import("/src/infrastructure/gpu-effects/registry.ts");
      if (
        !getGpuEffect("gpu-file-lut-v1") ||
        getGpuEffectsByCategory("color").some((e) => e.id === "gpu-file-lut-v1")
      )
        throw new Error("PRIVATE_EFFECT_REGISTRATION");
      const pipeline = await EffectsPipeline.create();
      if (!pipeline) throw new Error("WEBGPU_REQUIRED");
      const device = pipeline.getDevice();
      const usage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT;
      const source = device.createTexture({
        size: [4, 2],
        format: "rgba16float",
        usage,
      });
      const target = device.createTexture({
        size: [4, 2],
        format: "rgba16float",
        usage,
      });
      const buffer = device.createBuffer({
        size: 512,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const inputs = [
        -1, 2, 10, 0.5, 0, 3, 12, 0.25, 1, 4, 14, 0.75, -2, 5, 16, 1,
      ];
      device.queue.writeTexture(
        { texture: source },
        new Float16Array([...inputs, ...inputs]),
        { bytesPerRow: 32 },
        [4, 2],
      );
      const cube = `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1 ? 1 : -1} ${i & 2 ? 2 : -2} ${i & 4 ? 3 : -3}`).join("\n")}`;
      const materialized = materializeCubeFileLut(cube, {
        size: 2,
        domainMin: [-1, 2, 10],
        domainMax: [1, 4, 14],
      });
      const cases = [];
      try {
        for (const intensity of [0, 0.5, 1]) {
          device.pushErrorScope("validation");
          const accepted = pipeline.applyTextureEffectsToTexture(
            source,
            [
              {
                id: "file",
                type: "gpu-file-lut-v1",
                enabled: true,
                params: { ...materialized, intensity },
              },
            ],
            target,
            4,
            2,
          );
          if (!accepted) throw new Error("FILE_LUT_NOT_RENDERED");
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture: target },
            { buffer, bytesPerRow: 256 },
            [4, 2],
          );
          device.queue.submit([encoder.finish()]);
          const validation = await device.popErrorScope();
          if (validation) throw new Error(validation.message);
          await buffer.mapAsync(GPUMapMode.READ);
          const pixels = Array.from(
            new Float16Array(buffer.getMappedRange(), 0, 16),
          );
          buffer.unmap();
          const expected = inputs.map((value, i) => {
            const c = i % 4;
            if (c === 3) return value;
            const lo = [-1, 2, 10][c],
              hi = [1, 4, 14][c];
            const u = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
            const graded = (u * 2 - 1) * (c + 1);
            return value + (graded - value) * intensity;
          });
          const maxError = Math.max(
            ...pixels.map((v, i) => Math.abs(v - expected[i])),
          );
          if (maxError > 0.01)
            throw new Error(`FILE_LUT_NUMERICAL_ERROR:${maxError}`);
          cases.push({ intensity, pixels, expected, maxError });
        }
        let invalid = false;
        try {
          pipeline.applyTextureEffectsToTexture(
            source,
            [
              {
                id: "file",
                type: "gpu-file-lut-v1",
                enabled: true,
                params: { ...materialized, fileLutData: "AA==" },
              },
            ],
            target,
            4,
            2,
          );
        } catch {
          invalid = true;
        }
        if (!invalid) throw new Error("INVALID_FILE_LUT_DID_NOT_REFUSE");
        pipeline.setWorkingRange("hdr");
        let hdr = false;
        try {
          pipeline.applyTextureEffectsToTexture(
            source,
            [
              {
                id: "file",
                type: "gpu-file-lut-v1",
                enabled: true,
                params: materialized,
              },
            ],
            target,
            4,
            2,
          );
        } catch (error) {
          hdr = error.name === "HdrRenderUnavailableError";
        }
        if (!hdr) throw new Error("FILE_LUT_HDR_TYPED_REFUSAL_REQUIRED");
        return { cases, invalidRefused: invalid, hdrTypedRefused: hdr };
      } finally {
        source.destroy();
        target.destroy();
        buffer.destroy();
        pipeline.destroy();
      }
    }),
  );
  assert.equal(report.cases.length, 3);
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  console.log(JSON.stringify(await runFileLutMatrix(), null, 2));
