import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { testedSource } from './lib/working-domain-report.mjs'
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs'
const { chromium } = createRequire(new URL('../engine/package.json', import.meta.url))('playwright')
const source = await testedSource(new URL(import.meta.url))
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5228'
const unit = 2 ** -24
const adjacent = (value, delta) => {
  const floats = new Float32Array([value])
  const bits = new Uint32Array(floats.buffer)
  bits[0] += delta
  return floats[0]
}
const alphas = [
  0,
  adjacent(unit / 2, -1),
  unit / 2,
  adjacent(unit / 2, 1),
  unit,
  unit * 1.5,
  unit * 2,
  unit * 2.5,
  unit * 3.5,
  unit * 1023,
  adjacent(unit * 1023.5, -1),
  unit * 1023.5,
  adjacent(unit * 1023.5, 1),
  unit * 1024,
  0.25,
  0.5,
  1,
]
const expectedHalf = Array.from(new Uint16Array(new Float16Array(alphas).buffer))
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() })
try {
  const page = await browser.newPage()
  await page.goto(origin)
  const report = await page.evaluate(async (alphas) => {
    const { effectRangeWgsl } = await import('/src/infrastructure/gpu-effects/common.ts')
    const adapter = await navigator.gpu.requestAdapter()
    const device = await adapter.requestDevice()
    const n = alphas.length
    const input = device.createBuffer({
      size: n * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    const output = device.createBuffer({
      size: n * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const read = device.createBuffer({
      size: n * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    const texture = device.createTexture({
      size: [n, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const texRead = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    const shader =
      effectRangeWgsl(true) +
      `
@group(0) @binding(0) var<storage,read> inputs:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> outputs:array<vec4f>;
@group(0) @binding(2) var tex:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  let c=inputs[id.x]; let value=fl_blur_output(c); outputs[id.x]=value;
  textureStore(tex,vec2i(i32(id.x),0),value);
}`
    try {
      device.queue.writeBuffer(
        input,
        0,
        new Float32Array(alphas.flatMap((a) => [8 * a, -0.25 * a, 2 * a, a])),
      )
      device.pushErrorScope('validation')
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
      })
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: texture.createView() },
        ],
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(n)
      pass.end()
      enc.copyBufferToBuffer(output, 0, read, 0, n * 16)
      enc.copyTextureToBuffer({ texture }, { buffer: texRead, bytesPerRow: 256 }, [n, 1])
      device.queue.submit([enc.finish()])
      const error = await device.popErrorScope()
      if (error) throw Error(error.message)
      await read.mapAsync(GPUMapMode.READ)
      const mapped = read.getMappedRange()
      const values = Array.from(new Float32Array(mapped))
      const bits = Array.from(new Uint32Array(mapped))
      read.unmap()
      await texRead.mapAsync(GPUMapMode.READ)
      const halfBits = Array.from(new Uint16Array(texRead.getMappedRange(), 0, n * 4))
      texRead.unmap()
      return {
        values,
        bits,
        halfBits,
        adapter: {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
        },
      }
    } finally {
      input.destroy()
      output.destroy()
      read.destroy()
      texture.destroy()
      texRead.destroy()
      device.destroy()
    }
  }, alphas)
  const receipt = {
    source,
    browser: browser.version(),
    backendArgs: chromeLaunchArgs(),
    alphas,
    expectedHalf,
    ...report,
  }
  if (process.env.STUDIO_MEASUREMENT_REPORT)
    await writeFile(process.env.STUDIO_MEASUREMENT_REPORT, JSON.stringify(receipt, null, 2))
  for (let i = 0; i < alphas.length; i++) {
    assert.equal(report.halfBits[i * 4 + 3], expectedHalf[i], `case${i} stored half coverage`)
    const expected = Number(new Float16Array(alphas)[i])
    assert.equal(report.values[i * 4 + 3], expected, `case${i} independently rounded f32 coverage`)
    assert.deepEqual(
      report.values.slice(i * 4, i * 4 + 3),
      expected === 0 ? [0, 0, 0] : [8, -0.25, 2],
      `case${i} straight signed/headroom RGB and zero-coverage clearing`,
    )
  }
  assert.equal(expectedHalf[2], 0)
  assert.equal(expectedHalf[3], 1)
  assert.equal(expectedHalf[5], 2)
  assert.equal(expectedHalf[7], 2)
  assert.equal(expectedHalf[8], 4)
  assert.equal(expectedHalf[11], 1024)
  console.log(JSON.stringify({ cases: alphas.length, result: 'passed', adapter: report.adapter }))
} finally {
  await browser.close()
}
