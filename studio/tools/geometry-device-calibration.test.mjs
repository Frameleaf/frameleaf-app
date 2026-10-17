import assert from 'node:assert/strict'
import test from 'node:test'
import { validateGeometryCalibration as validate } from './geometry-device-calibration.mjs'
import { readFileSync } from 'node:fs'
const envelope = JSON.parse(
  readFileSync(new URL('./geometry-raster-envelopes.json', import.meta.url)),
)
function validateGeometryCalibration(row, w, h, entry, index) {
  const fixed = envelope.envelopes.find((e) => e.backend === 'swift' && e.W === w && e.H === h)
  return validate(row, w, h, entry, index, {
    width: w,
    height: h,
    components: fixed.components,
    state: { ...fixed.state, alphaToCoverageEnabled: false },
  })
}

const cases = [
  ...[1, -10, 10].map((amount) => ({
    type: 'gpu-twirl',
    params: { amount, radius: 0.5, centerX: 0.5, centerY: 0.5 },
  })),
  ...[0.02, 0, 0.1].map((amplitude) => ({
    type: 'gpu-wave',
    params: { amplitudeX: amplitude, amplitudeY: amplitude, frequencyX: 5, frequencyY: 5 },
  })),
  ...[0.5, 0.1, 3].map((amount) => ({
    type: 'gpu-bulge',
    params: { amount, radius: 0.5, centerX: 0.5, centerY: 0.5 },
  })),
]
// Synthetic admission fixtures only; actual same-device evidence is produced by the browser runner.
function fixture(entry, caseIndex) {
  const f = Math.fround,
    type = ['gpu-twirl', 'gpu-wave', 'gpu-bulge'].indexOf(entry.type),
    p = entry.params
  const packed = Array.from(
    new Float32Array(
      type === 1
        ? [p.amplitudeX, p.amplitudeY, p.frequencyX, p.frequencyY]
        : [p.amount, p.radius, p.centerX, p.centerY],
    ),
  )
  const values = Array.from({ length: 4 }, (_, i) => {
    const r = Array(32).fill(0),
      u = ((i % 2) + 0.5) / 2,
      v = (Math.floor(i / 2) + 0.5) / 2
    r.splice(0, 7, i, caseIndex, type, 2, 2, u, v)
    r.splice(21, 4, ...packed)
    r[27] = (i % 2) + 0.5
    r[28] = Math.floor(i / 2) + 0.5
    r[29] = Math.floor(i / 2) > i % 2 ? 0 : 1
    if (type === 1) {
      const [ax, ay, fx, fy] = packed
      r[7] = 1
      r[12] = f(f(u * fx) * f(2 * Math.PI))
      r[13] = f(Math.sin(r[12]))
      r[11] = f(v + f(r[13] * ax))
      r[14] = f(f(r[11] * fy) * f(2 * Math.PI))
      r[15] = f(Math.sin(r[14]))
      r[16] = f(u + f(r[15] * ay))
      r[17] = r[11]
    } else {
      const [amount, radius, cx, cy] = packed
      r[8] = f(u - cx)
      r[9] = f(v - cy)
      r[10] = f(Math.hypot(r[8], r[9]))
      r[7] = 1
      if (type === 0) {
        r[11] = f(1 - Math.min(f(r[10] / radius), 1))
        r[12] = f(f(amount * r[11]) * r[11])
        r[14] = r[12]
        r[13] = f(Math.cos(r[12]))
        r[15] = f(Math.sin(r[12]))
        r[16] = f(cx + f(f(r[8] * r[13]) - f(r[9] * r[15])))
        r[17] = f(cy + f(f(r[8] * r[15]) + f(r[9] * r[13])))
      } else {
        r[11] = Math.max(r[10], f(0.0001))
        r[18] = f(r[11] / radius)
        r[12] = r[18]
        r[13] = f(Math.log2(r[18]))
        r[14] = f(amount * r[13])
        r[15] = f(2 ** r[14])
        r[19] = f(r[18] ** amount)
        r[20] = f(r[19] * radius)
        r[16] = f(cx + f(f(r[8] / r[11]) * r[20]))
        r[17] = f(cy + f(f(r[9] / r[11]) * r[20]))
      }
    }
    r[25] = f(f(r[16] * 2) - 0.5)
    r[26] = f(f(r[17] * 2) - 0.5)
    return r
  }).flat()
  return {
    stage: 'fragment',
    rasterState: {
      ...envelope.envelopes.find((e) => e.backend === 'swift' && e.W === 2 && e.H === 2).state,
      alphaToCoverageEnabled: false,
    },
    type: entry.type,
    params: { ...p },
    width: 2,
    height: 2,
    caseIndex,
    packed: [2, 2, type, caseIndex, ...packed],
    values,
  }
}

test('all nine admission fixtures retain identities, intermediates, finite bounds and local outside-domain policy', () => {
  cases.forEach((entry, i) => {
    const accepted = validateGeometryCalibration(fixture(entry, i), 2, 2, entry, i)
    assert.equal(accepted.coordinates.length, 4)
    assert.equal(accepted.errors.length, 4)
    assert.equal(accepted.primitivePolicy.sinCos, 2 ** -11)
    assert.ok(
      accepted.errors.every((row) => Number.isFinite(row.boundU) && Number.isFinite(row.boundV)),
    )
    if (entry.type === 'gpu-wave') assert.ok(accepted.outsideDomain.length > 0)
  })
})
for (const [name, mutate] of [
  [
    'swapped case',
    (r) => {
      r.caseIndex = 1
    },
  ],
  [
    'swapped pixel',
    (r) => {
      r.values[0] = 1
    },
  ],
  [
    'wrong dimensions',
    (r) => {
      r.width = 3
    },
  ],
  [
    'wrong packed parameter',
    (r) => {
      r.values[21] += 0.1
    },
  ],
  [
    'nonfinite witness',
    (r) => {
      r.values[16] = NaN
    },
  ],
  [
    'forged coordinates',
    (r) => {
      r.values[16] += 0.02
    },
  ],
  [
    'wrong branch',
    (r) => {
      r.values[7] = 0
    },
  ],
  [
    'out-of-policy cosine',
    (r) => {
      r.values[13] = Math.fround(r.values[13] + 0.001)
    },
  ],
  [
    'wrong angle',
    (r) => {
      r.values[12] += 0.01
    },
  ],
])
  test(`calibration refuses ${name}`, () => {
    const r = fixture(cases[0], 0)
    mutate(r)
    assert.throws(() => validateGeometryCalibration(r, 2, 2, cases[0], 0), /CALIBRATION_/)
  })
test('sequential Wave refuses parallel second argument and reordered displacement', () => {
  const row = fixture(cases[5], 5)
  row.values[14] = Math.fround(row.values[6] * 5 * Math.fround(2 * Math.PI))
  assert.throws(
    () => validateGeometryCalibration(row, 2, 2, cases[5], 5),
    /CALIBRATION_WAVE_SEQUENTIAL_ARG2/,
  )
})
test('Bulge refuses forged logarithm, power and final direction independently', () => {
  for (const offset of [13, 19, 16]) {
    const row = fixture(cases[6], 6)
    row.values[offset] += 0.01
    assert.throws(() => validateGeometryCalibration(row, 2, 2, cases[6], 6), /CALIBRATION_/)
  }
})

test('outside-pi sine still refuses errors above fixed 2^-11 local policy', () => {
  const row = fixture(cases[3], 3)
  assert.ok(Math.abs(row.values[12]) > Math.PI)
  row.values[13] = Math.fround(row.values[13] + 0.001)
  assert.throws(() => validateGeometryCalibration(row, 2, 2, cases[3], 3), /CALIBRATION_TRIG_sin/)
})
test('a finite double pretending to be an f32 witness is refused', () => {
  const row = fixture(cases[0], 0)
  row.values[16] += Number.EPSILON
  assert.throws(
    () => validateGeometryCalibration(row, 2, 2, cases[0], 0),
    /CALIBRATION_FINITE_SIZE/,
  )
})
