// Test-only independent device math. No production shader, geometry, or color imports.
// Accuracy source: https://www.w3.org/TR/WGSL/#floating-point-accuracy
export async function probeGeometryCoordinates(device, width, height, cases) {
  const shader = device.createShaderModule({
    code: `
struct Params { shape: vec4f, effect: vec4f };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let count = u32(p.shape.x * p.shape.y); if (id.x >= count) { return; }
  let at = id.x * 32u;
  let uv = (vec2f(f32(id.x % u32(p.shape.x)), f32(id.x / u32(p.shape.x))) + vec2f(0.5)) / p.shape.xy;
  var result = uv; var delta = vec2f(0.0); var dist = 0.0; var branch = 1.0;
  var middle = 0.0; var arg1 = 0.0; var primitive1 = 0.0; var arg2 = 0.0; var primitive2 = 0.0;
  var base = 0.0; var power = 0.0; var next = 0.0;
  if (p.shape.z == 1.0) {
    arg1 = uv.x * p.effect.z * 6.283185307179586;
    primitive1 = sin(arg1); middle = uv.y + primitive1 * p.effect.x;
    arg2 = middle * p.effect.w * 6.283185307179586;
    primitive2 = sin(arg2); result = vec2f(uv.x + primitive2 * p.effect.y, middle);
  } else {
    delta = uv - p.effect.zw; dist = length(delta);
    branch = select(0.0, 1.0, dist < p.effect.y);
    if (p.shape.z == 0.0) {
      middle = 1.0 - min(dist / max(p.effect.y, 0.0001), 1.0);
      arg1 = p.effect.x * middle * middle; primitive1 = cos(arg1);
      arg2 = arg1; primitive2 = sin(arg2);
      let rotated = vec2f(delta.x * primitive1 - delta.y * primitive2, delta.x * primitive2 + delta.y * primitive1);
      result = select(uv, p.effect.zw + rotated, branch == 1.0);
    } else {
      branch = select(0.0, 1.0, dist < p.effect.y && dist > 0.0);
      middle = max(dist, 0.0001); base = middle / p.effect.y;
      arg1 = base; primitive1 = log2(base); arg2 = p.effect.x * primitive1; primitive2 = exp2(arg2);
      power = pow(base, p.effect.x); next = power * p.effect.y;
      result = select(uv, p.effect.zw + delta / middle * next, branch == 1.0);
    }
  }
  output[at] = f32(id.x); output[at+1u] = p.shape.w; output[at+2u] = p.shape.z;
  output[at+3u] = p.shape.x; output[at+4u] = p.shape.y;
  output[at+5u] = uv.x; output[at+6u] = uv.y; output[at+7u] = branch;
  output[at+8u] = delta.x; output[at+9u] = delta.y; output[at+10u] = dist; output[at+11u] = middle;
  output[at+12u] = arg1; output[at+13u] = primitive1; output[at+14u] = arg2; output[at+15u] = primitive2;
  output[at+16u] = result.x; output[at+17u] = result.y;
  output[at+18u] = base; output[at+19u] = power; output[at+20u] = next;
  output[at+21u] = p.effect.x; output[at+22u] = p.effect.y; output[at+23u] = p.effect.z; output[at+24u] = p.effect.w;
  let point = result * p.shape.xy - vec2f(0.5);
  output[at+25u] = point.x; output[at+26u] = point.y;
  for (var n = 27u; n < 32u; n++) { output[at+n] = 0.0; }
}`,
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' },
  })
  const rows = []
  for (const [caseIndex, entry] of cases.entries()) {
    const type = ['gpu-twirl', 'gpu-wave', 'gpu-bulge'].indexOf(entry.type)
    if (type < 0) throw Error('UNKNOWN_CALIBRATION_TYPE')
    const p = entry.params
    const packed =
      type === 1
        ? [p.amplitudeX, p.amplitudeY, p.frequencyX, p.frequencyY]
        : [p.amount, p.radius, p.centerX, p.centerY]
    const parameters = new Float32Array([width, height, type, caseIndex, ...packed])
    const bytes = width * height * 32 * 4
    const uniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const output = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const read = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    try {
      device.pushErrorScope('validation')
      device.queue.writeBuffer(uniform, 0, parameters)
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: output } },
        ],
      })
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil((width * height) / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes)
      device.queue.submit([encoder.finish()])
      const error = await device.popErrorScope()
      if (error) throw Error(error.message)
      await read.mapAsync(GPUMapMode.READ)
      const values = Array.from(new Float32Array(read.getMappedRange()))
      read.unmap()
      rows.push({
        type: entry.type,
        params: { ...p },
        width,
        height,
        caseIndex,
        packed: Array.from(parameters),
        values,
      })
    } finally {
      uniform.destroy()
      output.destroy()
      read.destroy()
    }
  }
  return rows
}

export function validateGeometryCalibration(row, width, height, entry, caseIndex) {
  let currentPixel = -1
  const measurements = []
  const check = (condition, label) => {
    if (!condition) throw Error('CALIBRATION_' + label)
  }
  const ulp = (value) => {
    if (value === 0) return 2 ** -149
    const magnitude = Math.abs(value),
      exponent = Math.floor(Math.log2(magnitude))
    // WGSL defines the minimum adjacent spacing: at an exact binade boundary
    // the lower neighbour is closer. Do not silently double its admission bound.
    return 2 ** Math.max(-149, exponent - (magnitude === 2 ** exponent ? 24 : 23))
  }
  const close = (actual, expected, bound, label) => {
    const error = Math.abs(actual - expected)
    check(Number.isFinite(actual) && error <= bound, label)
    measurements.push({ pixel: currentPixel, label, actual, expected, bound, error })
    return error
  }
  const rounded = (actual, expected, units, label) =>
    close(actual, expected, units * ulp(expected), label)
  const type = ['gpu-twirl', 'gpu-wave', 'gpu-bulge'].indexOf(entry.type),
    p = entry.params
  const packed = Array.from(
    new Float32Array(
      type === 1
        ? [p.amplitudeX, p.amplitudeY, p.frequencyX, p.frequencyY]
        : [p.amount, p.radius, p.centerX, p.centerY],
    ),
  )
  check(
    row.type === entry.type &&
      JSON.stringify(row.params) === JSON.stringify(p) &&
      row.width === width &&
      row.height === height &&
      row.caseIndex === caseIndex,
    'IDENTITY',
  )
  check(
    JSON.stringify(row.packed) === JSON.stringify([width, height, type, caseIndex, ...packed]),
    'PARAMETERS',
  )
  check(
    row.values.length === width * height * 32 &&
      row.values.every((value) => Number.isFinite(value) && Math.fround(value) === value),
    'FINITE_SIZE',
  )
  const coordinates = [],
    outsideDomain = [],
    errors = []
  const trig = (actual, arg, kind, pixel) => {
    const error = close(actual, Math[kind](arg), 2 ** -11, 'TRIG_' + kind)
    if (Math.abs(arg) > Math.PI)
      outsideDomain.push({
        pixel,
        kind,
        arg,
        error,
        policy: 'strict-local-2^-11; not WGSL domain guarantee',
      })
    return error
  }
  const sumRound = (center, a, b) =>
    ulp(a) + ulp(b) + ulp(a + b) + ulp(center + a) + ulp(center + b) + ulp(center + a + b)
  for (let i = 0; i < width * height; i++) {
    currentPixel = i
    const r = row.values.slice(i * 32, (i + 1) * 32),
      [amount, radius, cx, cy] = packed
    check(
      JSON.stringify(r.slice(0, 5)) === JSON.stringify([i, caseIndex, type, width, height]),
      'PIXEL_ID',
    )
    check(
      JSON.stringify(r.slice(21, 25)) === JSON.stringify(packed) &&
        r.slice(27).every((v) => v === 0),
      'PARAMETER_ECHO',
    )
    const u = ((i % width) + 0.5) / width,
      v = (Math.floor(i / width) + 0.5) / height
    const eu = rounded(r[5], u, 2.5, 'CENTER_U'),
      ev = rounded(r[6], v, 2.5, 'CENTER_V')
    let boundU = eu,
      boundV = ev
    if (type === 1) {
      const [ax, ay, fx, fy] = packed,
        tau = Math.fround(2 * Math.PI)
      const a = r[5] * fx,
        b = r[11] * fy
      const arg1Bound = ulp(a) * Math.abs(tau) + ulp(a * tau)
      const arg2Bound = ulp(b) * Math.abs(tau) + ulp(b * tau)
      close(r[12], a * tau, arg1Bound, 'WAVE_ARG1')
      trig(r[13], r[12], 'sin', i)
      const first = r[13] * ax
      close(r[11], r[6] + first, ulp(first) + ulp(r[6] + first), 'WAVE_FIRST_DISPLACEMENT')
      close(r[14], b * tau, arg2Bound, 'WAVE_SEQUENTIAL_ARG2')
      trig(r[15], r[14], 'sin', i)
      const second = r[15] * ay
      close(r[16], r[5] + second, ulp(second) + ulp(r[5] + second), 'WAVE_U')
      close(r[17], r[11], 0, 'WAVE_V')
      // First displacement uncertainty changes the SECOND argument; no parallel-wave oracle.
      boundV =
        ev +
        Math.abs(ax) *
          (2 ** -11 +
            arg1Bound +
            eu * Math.abs(fx * tau) +
            Math.abs(r[5] * fx) * Math.abs(tau - 2 * Math.PI)) +
        ulp(first) +
        ulp(r[11])
      boundU =
        eu +
        Math.abs(ay) *
          (2 ** -11 +
            arg2Bound +
            boundV * Math.abs(fy * tau) +
            Math.abs(r[11] * fy) * Math.abs(tau - 2 * Math.PI)) +
        ulp(second) +
        ulp(r[16])
    } else {
      const dx = r[5] - cx,
        dy = r[6] - cy
      rounded(r[8], dx, 1, 'DELTA_X')
      rounded(r[9], dy, 1, 'DELTA_Y')
      const dot = r[8] * r[8] + r[9] * r[9],
        distance = Math.sqrt(dot)
      const dotError = ulp(r[8] * r[8]) + ulp(r[9] * r[9]) + ulp(dot)
      const reciprocal = 1 / distance
      const distanceBound =
        dotError / (2 * Math.sqrt(Math.max(Number.MIN_VALUE, dot - dotError))) +
        2 * ulp(reciprocal) * distance * distance +
        2.5 * ulp(distance)
      close(r[10], distance, distanceBound, 'LENGTH')
      const branch = r[10] < radius && (type === 0 || r[10] > 0) ? 1 : 0
      check(r[7] === branch, 'RADIUS_BRANCH')
      if (type === 0) {
        const ratio = r[10] / Math.max(radius, Math.fround(0.0001)),
          factor = 1 - Math.min(ratio, 1)
        close(r[11], factor, 2.5 * ulp(ratio) + ulp(factor), 'TWIRL_FACTOR')
        const product = amount * r[11],
          angle = product * r[11],
          angleBound = ulp(product) * Math.abs(r[11]) + ulp(angle)
        close(r[12], angle, angleBound, 'TWIRL_ANGLE')
        close(r[14], r[12], 0, 'TWIRL_SHARED_ANGLE')
        trig(r[13], r[12], 'cos', i)
        trig(r[15], r[14], 'sin', i)
        const x1 = r[8] * r[13],
          x2 = -r[9] * r[15],
          y1 = r[8] * r[15],
          y2 = r[9] * r[13]
        close(r[16], branch ? cx + x1 + x2 : r[5], branch ? sumRound(cx, x1, x2) : 0, 'TWIRL_U')
        close(r[17], branch ? cy + y1 + y2 : r[6], branch ? sumRound(cy, y1, y2) : 0, 'TWIRL_V')
        const deltaError = eu + ev + ulp(dx) + ulp(dy),
          factorError =
            (distanceBound + deltaError) / Math.max(radius, 0.0001) + 2.5 * ulp(ratio) + ulp(factor)
        const argumentError =
          Math.abs(amount) * (2 * Math.abs(factor) * factorError + factorError * factorError) +
          angleBound
        const rotationError =
          (Math.abs(dx) + Math.abs(dy)) * (2 ** -11 + argumentError) + deltaError
        boundU = branch ? rotationError + sumRound(cx, x1, x2) : eu
        boundV = branch ? rotationError + sumRound(cy, y1, y2) : ev
      } else {
        close(r[11], Math.max(r[10], Math.fround(0.0001)), 0, 'BULGE_SAFE_DISTANCE')
        const base = r[11] / radius
        rounded(r[18], base, 2.5, 'BULGE_BASE')
        close(r[12], r[18], 0, 'BULGE_LOG_ARGUMENT')
        check(r[18] > 0, 'BULGE_POSITIVE_BASE')
        const log = Math.log2(r[18]),
          logBound = r[18] >= 0.5 && r[18] <= 2 ? 2 ** -21 : 3 * ulp(log)
        close(r[13], log, logBound, 'BULGE_LOG')
        const exponent = amount * r[13]
        rounded(r[14], exponent, 1, 'BULGE_EXPONENT')
        const power = 2 ** r[14],
          expBound = (3 + 2 * Math.abs(r[14])) * ulp(power)
        close(r[15], power, expBound, 'BULGE_EXP2')
        // pow is permitted to implement exp2(amount*log2(base)); independently propagate that chain.
        const eError = Math.abs(amount) * logBound + ulp(exponent)
        const powBound =
          Math.max(
            Math.abs(2 ** (amount * log - eError) - r[18] ** amount),
            Math.abs(2 ** (amount * log + eError) - r[18] ** amount),
          ) + expBound
        close(r[19], r[18] ** amount, powBound, 'BULGE_POW')
        rounded(r[20], r[19] * radius, 1, 'BULGE_NEW_DISTANCE')
        const x = (r[8] / r[11]) * r[20],
          y = (r[9] / r[11]) * r[20]
        const bx = 2.5 * ulp(r[8] / r[11]) * Math.abs(r[20]) + ulp(x) + ulp(cx + x),
          by = 2.5 * ulp(r[9] / r[11]) * Math.abs(r[20]) + ulp(y) + ulp(cy + y)
        close(r[16], branch ? cx + x : r[5], branch ? bx : 0, 'BULGE_U')
        close(r[17], branch ? cy + y : r[6], branch ? by : 0, 'BULGE_V')
        const dError = distanceBound + eu + ev + ulp(dx) + ulp(dy),
          safeLow = Math.max(0.0001, r[11] - dError)
        const baseError = dError / radius + 2.5 * ulp(base)
        const low = Math.max(Number.MIN_VALUE, r[18] - baseError),
          high = r[18] + baseError
        const totalPowerError =
          Math.max(
            Math.abs(low ** amount - r[18] ** amount),
            Math.abs(high ** amount - r[18] ** amount),
          ) + powBound
        const newError = totalPowerError * Math.abs(radius) + ulp(r[20])
        const directionError = (delta, error) =>
          error / safeLow +
          (Math.abs(delta) * dError) / (safeLow * r[11]) +
          2.5 * ulp(delta / r[11])
        boundU = branch
          ? directionError(r[8], eu + ulp(dx)) * (Math.abs(r[20]) + newError) +
            Math.abs(r[8] / r[11]) * newError +
            bx
          : eu
        boundV = branch
          ? directionError(r[9], ev + ulp(dy)) * (Math.abs(r[20]) + newError) +
            Math.abs(r[9] / r[11]) * newError +
            by
          : ev
      }
    }
    let idealU = u,
      idealV = v
    if (type === 1) {
      idealV += Math.sin(u * packed[2] * 2 * Math.PI) * packed[0]
      idealU += Math.sin(idealV * packed[3] * 2 * Math.PI) * packed[1]
    } else {
      const dx = u - cx,
        dy = v - cy,
        distance = Math.hypot(dx, dy)
      const branch = distance < radius && (type === 0 || distance > 0)
      check(r[7] === Number(branch), 'IDEAL_RADIUS_BRANCH')
      if (branch && type === 0) {
        const factor = 1 - Math.min(distance / Math.max(radius, 0.0001), 1),
          angle = amount * factor * factor
        idealU = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
        idealV = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
      } else if (branch) {
        const safe = Math.max(distance, 0.0001),
          next = (safe / radius) ** amount * radius
        idealU = cx + (dx / safe) * next
        idealV = cy + (dy / safe) * next
      }
    }
    close(r[16], idealU, boundU, 'COMPLETE_U')
    close(r[17], idealV, boundV, 'COMPLETE_V')
    // Operation-specific bounds are recorded; primitive and complete chains above are gates, not tolerances on colors.
    check(Number.isFinite(boundU) && Number.isFinite(boundV), 'PROPAGATED_BOUND')
    const sx = r[16] * width,
      sy = r[17] * height
    close(r[25], sx - 0.5, ulp(sx) + ulp(sx - 0.5), 'SAMPLER_X')
    close(r[26], sy - 0.5, ulp(sy) + ulp(sy - 0.5), 'SAMPLER_Y')
    coordinates.push([r[16], r[17], r[25], r[26]])
    errors.push({ pixel: i, boundU, boundV, centerErrors: [eu, ev] })
  }
  return {
    coordinates,
    errors,
    outsideDomain,
    measurements,
    maxErrors: Object.fromEntries(
      [...new Set(measurements.map((m) => m.label))].map((label) => [
        label,
        Math.max(...measurements.filter((m) => m.label === label).map((m) => m.error)),
      ]),
    ),
    primitivePolicy: { sinCos: 2 ** -11, outsideDomain: 'strict-local-policy' },
  }
}
