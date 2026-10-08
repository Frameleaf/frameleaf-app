import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { validateBaseRaster } from './geometry-raster-calibration.mjs'
const envelope = JSON.parse(
  readFileSync(new URL('./geometry-raster-envelopes.json', import.meta.url)),
)
const args = {
  swift: [
    '--enable-unsafe-webgpu',
    '--use-angle=swiftshader',
    '--use-vulkan=swiftshader',
    '--enable-features=Vulkan',
    '--disable-accelerated-2d-canvas',
  ],
  metal: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
  ],
}
const binding = (backend) => ({
  browser: '148.0.7778.96',
  sourceSha256: 'e38c2512b0ac3b16f37488192687977440f0e083bac4e4456b71e0adf5c00689',
  quadSha256: envelope.receipts[0].quadSha256,
  backendArgs: args[backend],
})
const fromBits = (b) => new Float32Array(new Uint32Array([b]).buffer)[0]
const bits = (v) => new Uint32Array(new Float32Array([v]).buffer)[0]
// Synthetic validator fixtures only; live same-device captures are browser evidence.
function fixture(fixed) {
  const values = []
  for (let i = 0; i < fixed.W * fixed.H; i++) {
    const x = i % fixed.W,
      y = Math.floor(i / fixed.W)
    values.push(
      fromBits(fixed.components[i * 2].witnessBits),
      fromBits(fixed.components[i * 2 + 1].witnessBits),
      x + 0.5,
      y + 0.5,
      i,
      (2 * y + 1) * fixed.W > (2 * x + 1) * fixed.H ? 0 : 1,
      fixed.W,
      fixed.H,
    )
  }
  const state = { ...fixed.state, alphaToCoverageEnabled: false }
  return {
    adapter:
      fixed.backend === 'swift'
        ? { vendor: 'google', architecture: 'swiftshader' }
        : { vendor: 'apple', architecture: 'metal-3' },
    rows: [
      {
        states: state,
        results: ['independent', 'production', 'productionTriangle'].map((kind) => ({
          kind,
          state,
          values: [...values],
          bits: values.map(bits),
        })),
      },
    ],
  }
}
test('all fixed local shapes/backends admit exact source/state/pixel/triangle/UV fixtures', () => {
  for (const f of envelope.envelopes)
    assert.equal(
      validateBaseRaster(fixture(f), envelope, binding(f.backend)).components.length,
      f.components.length,
    )
})
test('both U and V endpoints refuse at every pixel and preserve immutable tables', () => {
  const original = JSON.stringify(envelope)
  let controls = 0
  for (const f of envelope.envelopes) {
    for (const c of f.components) {
      for (const delta of [-1, 1]) {
        const r = fixture(f),
          at = c.pixel * 8 + c.component,
          v = fromBits(delta < 0 ? c.lowBits - 1 : c.highBits + 1)
        r.rows[0].results[0].values[at] = v
        r.rows[0].results[0].bits[at] = bits(v)
        assert.throws(() => validateBaseRaster(r, envelope, binding(f.backend)), /RASTER_UV/)
        controls++
      }
    }
  }
  assert.equal(controls, 2464)
  assert.equal(JSON.stringify(envelope), original)
})
for (const [name, mutate] of [
  [
    'unknown browser',
    (r, b) => {
      b.browser = '149'
    },
  ],
  [
    'unknown source',
    (r, b) => {
      b.sourceSha256 = '0'.repeat(64)
    },
  ],
  [
    'wrong quad',
    (r, b) => {
      b.quadSha256 = '0'.repeat(64)
    },
  ],
  [
    'wrong backend args',
    (r, b) => {
      b.backendArgs = []
    },
  ],
  [
    'unknown adapter',
    (r) => {
      r.adapter.vendor = 'unknown'
    },
  ],
  [
    'sample count',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, sampleCount: 4 }
    },
  ],
  [
    'sample mask',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, sampleMask: 0 }
    },
  ],
  [
    'alpha to coverage',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, alphaToCoverageEnabled: true }
    },
  ],
  [
    'scissor',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, scissor: [1, 0, 7, 6] }
    },
  ],
  [
    'viewport',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, viewport: [0, 0, 9, 6, 0, 1] }
    },
  ],
  [
    'topology',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, topology: 'triangle-strip' }
    },
  ],
  [
    'draw count',
    (r) => {
      r.rows[0].states = { ...r.rows[0].states, drawVertices: 3 }
    },
  ],
  [
    'swapped pixel',
    (r) => {
      r.rows[0].results[0].values[4] = 1
    },
  ],
  [
    'builtin position',
    (r) => {
      r.rows[0].results[0].values[2] = 1
    },
  ],
  [
    'triangle',
    (r) => {
      r.rows[0].results[0].values[5] = 1 - r.rows[0].results[0].values[5]
    },
  ],
  [
    'clipped capture',
    (r) => {
      r.rows[0].results[0].values.fill(0, 0, 8)
    },
  ],
  [
    'forged bits',
    (r) => {
      r.rows[0].results[0].bits[0]++
    },
  ],
])
  test(`raster admission refuses ${name}`, () => {
    const f = envelope.envelopes[0],
      r = fixture(f),
      b = binding(f.backend)
    mutate(r, b)
    assert.throws(() => validateBaseRaster(r, envelope, b))
  })
