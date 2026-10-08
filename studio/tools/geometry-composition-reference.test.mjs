import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { geometryReference } from './geometry-reference.mjs'
import {
  compositionInputSha,
  COMPOSITION_SOURCES,
  geometryCompositionReference,
  geometryCompositionStages,
} from './geometry-composition-reference.mjs'
const envelope = JSON.parse(
  readFileSync(new URL('./geometry-raster-envelopes.json', import.meta.url)),
)
const W = 8,
  H = 6,
  f = Math.fround,
  half = (x) => new Float16Array([x])[0]
const entry = {
  type: 'gpu-wave',
  params: { amplitudeX: 0, amplitudeY: 0, frequencyX: 5, frequencyY: 5 },
}
// Synthetic admission fixtures only. Fresh live GPU evidence comes from the browser runner.
function fixture(e = entry) {
  const fixed = envelope.envelopes.find((r) => r.backend === 'swift' && r.W === W && r.H === H),
    state = { ...fixed.state, alphaToCoverageEnabled: false }
  const input = Array.from({ length: W * H }, (_, i) => {
    const x = i % W,
      y = Math.floor(i / W)
    return [x < 4 ? 8 : 32, y < 3 ? -0.25 : 4, (x + y) % 2 ? -2 : 2, [0, 0.25, 0.5, 1][(x + y) % 4]]
  }).flat()
  const fromBits = (b) => new Float32Array(new Uint32Array([b]).buffer)[0]
  const bits = (v) => new Uint32Array(new Float32Array([v]).buffer)[0]
  const base = Array.from({ length: W * H }, (_, i) => [
    fromBits(fixed.components[i * 2].witnessBits),
    fromBits(fixed.components[i * 2 + 1].witnessBits),
    (i % W) + 0.5,
    Math.floor(i / W) + 0.5,
    i,
    (2 * Math.floor(i / W) + 1) * W > (2 * (i % W) + 1) * H ? 0 : 1,
    W,
    H,
  ]).flat()
  const capture = {
    adapter: { vendor: 'google', architecture: 'swiftshader' },
    rows: [
      {
        states: state,
        results: ['independent', 'production', 'productionTriangle'].map((kind) => ({
          kind,
          state,
          values: [...base],
          bits: base.map(bits),
        })),
      },
    ],
  }
  const p = e.params,
    packed = [p.amplitudeX, p.amplitudeY, p.frequencyX, p.frequencyY].map(f)
  const values = Array.from({ length: W * H }, (_, i) => {
    const r = Array(32).fill(0),
      u = base[i * 8],
      v = base[i * 8 + 1]
    r.splice(0, 7, i, 0, 1, W, H, u, v)
    r[7] = 1
    r.splice(21, 4, ...packed)
    r[12] = f(f(u * packed[2]) * f(2 * Math.PI))
    r[13] = f(Math.sin(r[12]))
    r[11] = f(v + f(r[13] * packed[0]))
    r[14] = f(f(r[11] * packed[3]) * f(2 * Math.PI))
    r[15] = f(Math.sin(r[14]))
    r[16] = f(u + f(r[15] * packed[1]))
    r[17] = r[11]
    r[25] = f(f(r[16] * W) - 0.5)
    r[26] = f(f(r[17] * H) - 0.5)
    r[27] = (i % W) + 0.5
    r[28] = Math.floor(i / W) + 0.5
    r[29] = base[i * 8 + 5]
    return r
  }).flat()
  const row = {
    type: e.type,
    params: e.params,
    caseIndex: 0,
    width: W,
    height: H,
    stage: 'fragment',
    rasterState: state,
    packed: [W, H, 1, 0, ...packed],
    values,
  }
  const tex = (id) => ({ id, width: W, height: H, format: 'rgba16float' }),
    rect = { x: 0, y: 0, width: W, height: H }
  const sampler = {
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    maxAnisotropy: 1,
  }
  const layerParams = {
    opacity: 1,
    blendMode: 'normal',
    posX: 0,
    posY: 0,
    scaleX: 1,
    scaleY: 1,
    rotationZ: 0,
    sourceAspect: W / H,
    outputAspect: W / H,
    hasMask: false,
    maskInvert: false,
    rotationX: 0,
    rotationY: 0,
    perspective: 0,
    maskFeather: 0,
    time: 0,
  }
  const color = {
    workingRange: 'hdr',
    referenceWhiteNits: 203,
    masteringPeakNits: 1000,
    sdrMonitoring: 'none',
  }
  const operations = [
    { type: 'upload', mediaId: 'image', referenceWhite: 203, output: tex(1) },
    {
      type: 'media',
      input: tex(1),
      output: tex(2),
      sampler,
      params: {
        sourceWidth: W,
        sourceHeight: H,
        outputWidth: W,
        outputHeight: H,
        sourceRect: rect,
        destRect: rect,
        transformRect: rect,
        featherPixels: { left: 0, right: 0, top: 0, bottom: 0 },
        opacity: 1,
        rotationRad: 0,
        flipX: false,
        flipY: false,
        cornerRadius: 0,
        maskTexture: null,
      },
    },
    {
      type: 'effect',
      input: tex(2),
      output: tex(3),
      dimensions: [W, H],
      effects: [{ ...e, enabled: true }],
    },
    {
      type: 'composite',
      output: tex(4),
      dimensions: [W, H],
      sampler,
      layers: [
        { params: layerParams, input: tex(9), external: false },
        { params: layerParams, input: tex(3), external: false },
      ],
    },
    {
      type: 'output',
      input: tex(4),
      output: { ...tex(5), format: 'rgba32float' },
      target: 'pq',
      color,
    },
  ]
  const draws = ['media', 'effect', 'composite', 'output'].map((stage) => ({
    stage,
    target: { ...tex(10), format: stage === 'output' ? 'rgba32float' : 'rgba16float' },
    pipeline: {
      topology: state.topology,
      sampleCount: state.sampleCount,
      sampleMask: state.sampleMask,
      alphaToCoverageEnabled: false,
      format: stage === 'output' ? 'rgba32float' : 'rgba16float',
    },
    viewport: state.viewport,
    scissor: state.scissor,
    draw: [6, 1, 0, 0],
  }))
  const declaration = {
    width: W,
    height: H,
    fps: 30,
    durationInFrames: 1,
    backgroundColor: '#000000',
    colorManagement: color,
    tracks: [
      {
        items: [
          {
            id: 'image',
            mediaId: 'image',
            type: 'image',
            from: 0,
            durationInFrames: 1,
            sourceWidth: W,
            sourceHeight: H,
            transform: { x: 0, y: 0, width: W, height: H, rotation: 0, opacity: 1 },
            effects: [
              {
                id: 'blur',
                enabled: true,
                effect: { type: 'gpu-effect', gpuEffectType: e.type, params: e.params },
              },
            ],
          },
        ],
      },
    ],
    keyframes: [],
    transitions: [],
  }
  const contract = {
    inputSha256: compositionInputSha(input),
    sourceHashes: COMPOSITION_SOURCES,
    entry: e,
    caseIndex: 0,
    declaration,
    binding: {
      browser: '148.0.7778.96',
      sourceSha256: 'e38c2512b0ac3b16f37488192687977440f0e083bac4e4456b71e0adf5c00689',
      quadSha256: envelope.receipts[0].quadSha256,
      backendArgs: [
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--use-vulkan=swiftshader',
        '--enable-features=Vulkan',
        '--disable-accelerated-2d-canvas',
      ],
    },
    audit: { operations, draws },
  }
  return { input, capture, row, contract }
}
const render = (a, e = entry) =>
  geometryCompositionReference(a.input, W, H, e, a.capture, a.row, a.contract)
test('composition includes independent media, geometry and final layer placement', () => {
  const a = fixture(),
    out = render(a)
  assert.equal(out.media[91], 2 ** -22)
  assert.equal(out.geometry[91], 2 ** -21)
  assert.equal(out.composite[88], half(32 * 3 * 2 ** -22))
  assert.equal(out.composite[91], 1)
  assert.notEqual(out.composite[88], 32 * 2 ** -22, 'old one-pass red')
})
for (const [name, mutate] of [
  ['omitted media', (a) => a.contract.audit.operations.splice(1, 1)],
  ['omitted compositor', (a) => a.contract.audit.operations.splice(3, 1)],
  ['stage order', (a) => a.contract.audit.operations.reverse()],
  [
    'swapped source/output',
    (a) => {
      const m = a.contract.audit.operations[1]
      ;[m.input, m.output] = [m.output, m.input]
    },
  ],
  ['foreign input bytes', (a) => a.input[0]++],
  ['forged checksum', (a) => (a.contract.inputSha256 = '0'.repeat(64))],
  [
    'changed producer',
    (a) =>
      (a.contract.sourceHashes = {
        ...a.contract.sourceHashes,
        [Object.keys(COMPOSITION_SOURCES)[0]]: '0'.repeat(64),
      }),
  ],
  ['unknown source', (a) => (a.contract.binding.sourceSha256 = '0'.repeat(64))],
  ['unknown browser', (a) => (a.contract.binding.browser = '149')],
  ['foreign layer resource', (a) => (a.contract.audit.operations[3].layers[1].input.id = 999)],
  [
    'nearest sampler',
    (a) =>
      (a.contract.audit.operations[1].sampler = {
        ...a.contract.audit.operations[1].sampler,
        minFilter: 'nearest',
      }),
  ],
  ['alpha-to-coverage', (a) => (a.contract.audit.draws[0].pipeline.alphaToCoverageEnabled = true)],
  ['sample mask', (a) => (a.contract.audit.draws[0].pipeline.sampleMask = 0)],
  ['viewport', (a) => (a.contract.audit.draws[0].viewport = [0, 0, 4, H, 0, 1])],
  ['scissor', (a) => (a.contract.audit.draws[0].scissor = [0, 0, 4, H])],
  ['draw topology', (a) => (a.contract.audit.draws[0].pipeline.topology = 'triangle-strip')],
  ['missing pass raster', (a) => a.contract.audit.draws.pop()],
  [
    'forged authored params',
    (a) => (a.contract.entry = { ...entry, params: { ...entry.params, frequencyX: 4 } }),
  ],
  [
    'wrong effect',
    (a) => (a.contract.audit.operations[2].effects[0].params = { ...entry.params, frequencyX: 4 }),
  ],
  ['wrong opacity', (a) => (a.contract.audit.operations[1].params.opacity = 0.5)],
  [
    'different placement',
    (a) => (a.contract.audit.operations[1].params.destRect = { x: 1, y: 0, width: W, height: H }),
  ],
  ['different project background', (a) => (a.contract.declaration.backgroundColor = '#ffffff')],
  ['unknown project timing', (a) => (a.contract.declaration.fps = 24)],
  ['unsafe source dimensions', (a) => (a.contract.declaration.tracks[0].items[0].sourceWidth = 16)],
  ['forged effect coordinate', (a) => (a.row.values[16] += 0.01)],
  ['forged base U', (a) => (a.capture.rows[0].results[0].values[0] += 0.01)],
  ['forged base V', (a) => (a.capture.rows[0].results[0].values[1] += 0.01)],
])
  test(name + ' refuses before expected values', () => {
    const a = structuredClone(fixture())
    mutate(a)
    assert.throws(() => render(a))
  })
test('asymmetric data/effect separates order, omitted passes, straight/premultiplied and clipping', () => {
  const e = {
      type: 'gpu-wave',
      params: { amplitudeX: 0.12, amplitudeY: 0.03, frequencyX: 3, frequencyY: 7 },
    },
    a = fixture(e),
    expected = render(a, e),
    base = a.capture.rows[0].results[0].values,
    uv = Array.from({ length: W * H }, (_, i) => base.slice(i * 8, i * 8 + 2)),
    points = Array.from({ length: W * H }, (_, i) =>
      a.row.values
        .slice(i * 32 + 16, i * 32 + 18)
        .concat(a.row.values.slice(i * 32 + 25, i * 32 + 27)),
    )
  const different = (v) =>
    assert(
      v.some((x, i) => x !== expected.composite[i]),
      'mutation must change pixels, not only metadata',
    )
  const old = geometryReference(a.input, W, H, e.type, e.params, points).flatMap((v, i, all) =>
    i % 4 === 3 ? [1] : [half(v * all[Math.floor(i / 4) * 4 + 3])],
  )
  different(old)
  const precomposited = geometryCompositionStages(
    a.input,
    W,
    H,
    entry,
    uv.map(([u, v]) => [u, v, f(f(u * W) - 0.5), f(f(v * H) - 0.5)]),
    uv,
  )
  const reversed = geometryReference(precomposited.composite, W, H, e.type, e.params, points).map(
    half,
  )
  different(reversed)
  different(
    expected.geometry.map((v, i) =>
      i % 4 === 3 ? 1 : half(v * expected.geometry[Math.floor(i / 4) * 4 + 3]),
    ),
  )
  different(expected.composite.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(1, v)))))
  const straight = geometryCompositionStages(
    a.input.map((v, i) => (i % 4 === 3 ? 1 : v)),
    W,
    H,
    e,
    points,
    uv,
  )
  different(straight.composite)
  assert(expected.composite.some((v) => v < 0))
  assert(expected.composite.some((v) => v > 1))
})
test('transparent bright texels cannot contaminate premultiplied media interpolation', () => {
  const input = [65504, 4, -2, 0, 8, -0.25, 2, 1, 65504, 4, -2, 0, 8, -0.25, 2, 1]
  const uv = Array.from({ length: 4 }, () => [0.5, 0.5]),
    points = uv.map(() => [0.5, 0.5, 0.5, 0.5])
  const actual = geometryCompositionStages(input, 2, 2, entry, points, uv)
  assert.deepEqual(actual.media.slice(0, 4), [8, -0.25, 2, 0.5])
  assert.deepEqual(actual.composite.slice(0, 4), [4, -0.125, 1, 1])
  const wronglyStraightRed = half((65504 + 8) / 2)
  assert.notEqual(actual.media[0], wronglyStraightRed)
})
test('media uses raw-alpha zero rule before store; geometry uses rounded coverage', () => {
  const input = Array.from({ length: 4 }, () => [8, -0.25, 2, 2 ** -25]).flat(),
    uv = Array.from({ length: 4 }, (_, i) => [((i % 2) + 0.5) / 2, (Math.floor(i / 2) + 0.5) / 2]),
    points = uv.map(([u, v]) => [u, v, u * 2 - 0.5, v * 2 - 0.5])
  const actual = geometryCompositionStages(input, 2, 2, entry, points, uv)
  assert.deepEqual(actual.media.slice(0, 4), [8, -0.25, 2, 0])
  assert.deepEqual(actual.geometry, Array(16).fill(0))
  assert.deepEqual(actual.composite.slice(0, 4), [0, 0, 0, 1])
})
test('production readbacks are not reference inputs', () => {
  const a = fixture(),
    before = render(a)
  a.contract.audit.operations.forEach((o) => {
    o.pixels = Array(W * H * 4).fill(999)
  })
  assert.deepEqual(render(a), before)
})
test('noncanonical Float32 aliases refuse instead of changing checksum-bound expected math', () => {
  const a = fixture()
  a.input[0] += 1e-12
  assert.equal(compositionInputSha(a.input), a.contract.inputSha256)
  assert.throws(() => render(a))
})
