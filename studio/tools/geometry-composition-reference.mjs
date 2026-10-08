import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { geometryReference } from './geometry-reference.mjs'
import { validateBaseRaster } from './geometry-raster-calibration.mjs'
import { validateGeometryCalibration } from './geometry-device-calibration.mjs'
export const COMPOSITION_SOURCES = {
  'src/features/export/utils/hdr-raster-sources.ts':
    '7390a3c1456f3d0171441bd5b9a2b13edc9d9fed9084df028e291094b686d868',
  'src/features/export/utils/canvas-item-renderer/gpu.ts':
    'd1843c356eb48c35db04be1b8df139fdf07301f4a70412d9cfaeee357f9660f8',
  'src/features/export/utils/client-render-engine.ts':
    '835bcd71dd75201c1749509df64d413e66423d7b3f5ba897a0805b4c400c5458',
  'src/infrastructure/gpu-media/media-render-pipeline.ts':
    '7bb7481cf141a07ec99c83c768c48feed16a686fb2fe33ec00b9d623faa79cef',
  'src/infrastructure/gpu-compositor/compositor-pipeline.ts':
    '0d356402131d82975985f8feec82dd26b718dc3729af3c02699bd2f46f7ed34b',
  'src/infrastructure/gpu-shared/blend-modes.ts':
    '3f0a28b7f83985e196ae0381ccaeb1973582f1c4a6c526c21190f55e56593fca',
  'src/infrastructure/gpu-color/color-output-pipeline.ts':
    'e2d037d60366e431895f63585fc7127104debbe5c66fc2934bf54e150c01d2ba',
  'src/infrastructure/gpu-color/managed-color-wgsl.ts':
    'bbcc16001151ba9b236a811391f6833c86e441fdc9180d26537d36c9c169cabd',
  'src/infrastructure/gpu-effects/effects-pipeline.ts':
    '25a213b66f9d64da566de1d0a50cd860947bf6a36e260733b4b85381bf8dee1d',
  'src/infrastructure/gpu-effects/effects/distort.ts':
    'e7561f89bcfc363ae65b4fe11df919d87e002bc97e09e25e04a46e8f9dda4eb9',
  'src/infrastructure/gpu-effects/common.ts':
    'aa331c3e74e465b567a2e319d8227001e33ed9be927970e89014edb621fa6410',
  'src/infrastructure/gpu-shared/fullscreen-quad.ts':
    '225ac84918c7188feb887cd5da4cd6823e463a677c497d61da2062b2afd41b30',
}
const envelopeBytes = readFileSync(new URL('./geometry-raster-envelopes.json', import.meta.url))
assert.equal(
  createHash('sha256').update(envelopeBytes).digest('hex'),
  '2489f7711756e8c30f7b98dd94475f881fdb460a0cfb373206ef1f8fceeb5382',
)
const envelope = JSON.parse(envelopeBytes)
export const compositionInputSha = (values) =>
  createHash('sha256')
    .update(new Uint8Array(new Float32Array(values).buffer))
    .digest('hex')

// Test-only observer: records actual commands/parameters and texture identities, never pixels.
// Install before pipeline creation. It owns no device and restores every wrapper on dispose.
export function observeGeometryComposition(device, classes) {
  const restores = [],
    textureViews = new WeakMap(),
    pipelines = new WeakMap(),
    textureIds = new WeakMap(),
    samplers = new WeakMap()
  let serial = 0,
    active = null,
    stage = null
  const id = (t) => {
    if (!textureIds.has(t)) textureIds.set(t, ++serial)
    return textureIds.get(t)
  }
  const tex = (t) => ({ id: id(t), width: t.width, height: t.height, format: t.format })
  function wrap(object, key, fn) {
    const previous = object[key]
    object[key] = function (...args) {
      return fn.call(this, previous, args)
    }
    restores.push(() => {
      object[key] = previous
    })
  }
  wrap(device, 'createTexture', function (original, args) {
    const texture = original.apply(this, args)
    wrap(texture, 'createView', function (view, args) {
      const result = view.apply(this, args)
      textureViews.set(result, tex(texture))
      return result
    })
    return texture
  })
  wrap(device, 'createSampler', function (original, args) {
    const sampler = original.apply(this, args)
    const d = args[0] ?? {}
    samplers.set(sampler, {
      magFilter: d.magFilter ?? 'nearest',
      minFilter: d.minFilter ?? 'nearest',
      mipmapFilter: d.mipmapFilter ?? 'nearest',
      addressModeU: d.addressModeU ?? 'clamp-to-edge',
      addressModeV: d.addressModeV ?? 'clamp-to-edge',
      addressModeW: d.addressModeW ?? 'clamp-to-edge',
      maxAnisotropy: d.maxAnisotropy ?? 1,
    })
    return sampler
  })
  wrap(device, 'createRenderPipeline', function (original, args) {
    const d = args[0],
      p = original.apply(this, args)
    pipelines.set(p, {
      topology: d.primitive?.topology ?? 'triangle-list',
      sampleCount: d.multisample?.count ?? 1,
      sampleMask: d.multisample?.mask ?? 4294967295,
      alphaToCoverageEnabled: d.multisample?.alphaToCoverageEnabled ?? false,
      format: d.fragment?.targets?.[0]?.format,
    })
    return p
  })
  wrap(device, 'createCommandEncoder', function (original, args) {
    const encoder = original.apply(this, args)
    wrap(encoder, 'beginRenderPass', function (begin, args) {
      const pass = begin.apply(this, args)
      const target = textureViews.get(args[0].colorAttachments[0]?.view)
      let pipeline,
        viewport = target ? [0, 0, target.width, target.height, 0, 1] : null,
        scissor = target ? [0, 0, target.width, target.height] : null
      wrap(pass, 'setPipeline', function (set, args) {
        pipeline = pipelines.get(args[0])
        return set.apply(this, args)
      })
      wrap(pass, 'setViewport', function (set, args) {
        viewport = [...args]
        return set.apply(this, args)
      })
      wrap(pass, 'setScissorRect', function (set, args) {
        scissor = [...args]
        return set.apply(this, args)
      })
      wrap(pass, 'draw', function (draw, args) {
        if (active)
          active.draws.push({
            stage,
            target,
            pipeline,
            viewport,
            scissor,
            draw: [args[0], args[1] ?? 1, args[2] ?? 0, args[3] ?? 0],
          })
        return draw.apply(this, args)
      })
      wrap(pass, 'drawIndexed', function (draw, args) {
        if (active) throw Error('UNEXPECTED_COMPOSITION_INDEXED_DRAW')
        return draw.apply(this, args)
      })
      return pass
    })
    return encoder
  })
  function operation(type, object, key, describe) {
    wrap(object.prototype, key, function (original, args) {
      if (!active) return original.apply(this, args)
      assertDevice(this)
      const previousStage = stage
      stage = type
      const event = { type, ...describe(args) }
      if (type === 'media' || type === 'composite') event.sampler = samplers.get(this.sampler)
      active.operations.push(event)
      try {
        const result = original.apply(this, args)
        if (type === 'upload') event.output = result ? tex(result.texture) : null
        if (type === 'composite') event.output = result ? tex(result.texture) : null
        return result
      } finally {
        stage = previousStage
      }
    })
  }
  function assertDevice(instance) {
    if (instance.device !== undefined && instance.device !== device)
      throw Error('COMPOSITION_DEVICE_CHANGED')
  }
  operation('upload', classes.HdrRasterSources, 'frameTexture', (args) => ({
    mediaId: args[0],
    referenceWhite: args[1],
  }))
  operation('media', classes.MediaRenderPipeline, 'renderTextureToTexture', (args) => ({
    input: tex(args[0]),
    output: tex(args[1]),
    params: { ...args[2], maskTexture: args[2].maskTexture ? true : null },
  }))
  operation('effect', classes.EffectsPipeline, 'applyTextureEffectsToTexture', (args) => ({
    input: tex(args[0]),
    output: tex(args[2]),
    effects: structuredClone(args[1]),
    dimensions: [args[3], args[4]],
  }))
  operation('composite', classes.CompositorPipeline, 'compositeToTexture', (args) => ({
    dimensions: [args[1], args[2]],
    layers: args[0].map((l) => ({
      params: { ...l.params },
      input: textureViews.get(l.textureView),
      external: !!l.externalTexture,
    })),
  }))
  operation('output', classes.ColorOutputPipeline, 'convert', (args) => ({
    input: tex(args[0]),
    output: tex(args[1]),
    target: args[2],
    color: { ...args[3] },
  }))
  return {
    begin() {
      if (active) throw Error('COMPOSITION_AUDIT_ALREADY_ACTIVE')
      active = { operations: [], draws: [] }
    },
    end() {
      const result = active
      active = null
      if (!result) throw Error('COMPOSITION_AUDIT_NOT_ACTIVE')
      return result
    },
    dispose() {
      active = null
      for (const restore of restores.reverse()) restore()
    },
  }
}

export function validateCompositionContract(values, width, height, entry, capture, row, contract) {
  assert.deepEqual([width, height], [8, 6], 'local measured composition shape')
  assert.equal(values.length, width * height * 4)
  assert(
    values.every((value) => Number.isFinite(value) && Math.fround(value) === value),
    'canonical Float32 source bytes',
  )
  assert.equal(contract.inputSha256, compositionInputSha(values), 'composition input checksum')
  assert.deepEqual(contract.sourceHashes, COMPOSITION_SOURCES, 'composition pass source hashes')
  assert.deepEqual(contract.entry, entry, 'authored parameters')
  const d = contract.declaration
  assert.deepEqual(
    [d.width, d.height, d.fps, d.durationInFrames, d.backgroundColor],
    [width, height, 30, 1, '#000000'],
  )
  assert.deepEqual(d.colorManagement, {
    workingRange: 'hdr',
    referenceWhiteNits: 203,
    masteringPeakNits: 1000,
    sdrMonitoring: 'none',
  })
  assert.equal(d.tracks.length, 1)
  assert.equal(d.tracks[0].items.length, 1)
  assert.deepEqual(d.keyframes, [])
  assert.deepEqual(d.transitions, [])
  const item = d.tracks[0].items[0]
  assert.deepEqual(
    [
      item.id,
      item.mediaId,
      item.type,
      item.from,
      item.durationInFrames,
      item.sourceWidth,
      item.sourceHeight,
    ],
    ['image', 'image', 'image', 0, 1, width, height],
  )
  assert.deepEqual(item.transform, { x: 0, y: 0, width, height, rotation: 0, opacity: 1 })
  assert.equal(item.effects.length, 1)
  assert.deepEqual(item.effects[0], {
    id: 'blur',
    enabled: true,
    effect: { type: 'gpu-effect', gpuEffectType: entry.type, params: entry.params },
  })
  const raster = validateBaseRaster(capture, envelope, contract.binding)
  assert.deepEqual([raster.width, raster.height], [width, height])
  const calibration = validateGeometryCalibration(
    row,
    width,
    height,
    entry,
    contract.caseIndex,
    raster,
  )
  const state = raster.state
  const operations = contract.audit.operations
  assert.deepEqual(
    operations.map((o) => o.type),
    ['upload', 'media', 'effect', 'composite', 'output'],
    'composition pass order',
  )
  const [upload, media, effect, composite, output] = operations
  for (const o of [media, composite])
    assert.deepEqual(
      o.sampler,
      {
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
        maxAnisotropy: 1,
      },
      'sampler binding',
    )
  assert.equal(upload.mediaId, 'image')
  assert.equal(upload.referenceWhite, 203)
  assert(upload.output)
  for (const t of [
    upload.output,
    media.input,
    media.output,
    effect.input,
    effect.output,
    composite.output,
    output.input,
  ]) {
    assert.deepEqual([t.width, t.height, t.format], [width, height, 'rgba16float'])
  }
  assert.equal(media.input.id, upload.output.id, 'upload -> placement')
  assert.equal(effect.input.id, media.output.id, 'placement -> geometry')
  assert.equal(output.input.id, composite.output.id, 'composite -> PQ')
  assert.notEqual(media.input.id, media.output.id)
  assert.notEqual(effect.input.id, effect.output.id)
  assert.notEqual(output.input.id, output.output.id)
  const rect = { x: 0, y: 0, width, height },
    p = media.params
  assert.deepEqual(
    [p.sourceWidth, p.sourceHeight, p.outputWidth, p.outputHeight],
    [width, height, width, height],
  )
  for (const key of ['sourceRect', 'destRect', 'transformRect']) assert.deepEqual(p[key], rect, key)
  assert.deepEqual(p.featherPixels, { left: 0, right: 0, top: 0, bottom: 0 })
  assert.equal(p.opacity, 1)
  assert.equal(p.rotationRad, 0)
  assert.equal(p.flipX, false)
  assert.equal(p.flipY, false)
  assert.equal(p.cornerRadius, 0)
  assert.equal(p.maskTexture, null)
  assert(!p.cornerPin && !p.maskInvert, 'unexpected media modifier')
  assert.deepEqual(effect.dimensions, [width, height])
  assert.equal(effect.effects.length, 1)
  const e = effect.effects[0]
  assert.equal(e.enabled, true)
  assert.equal(e.type, entry.type)
  assert.deepEqual(e.params, entry.params)
  assert.deepEqual(composite.dimensions, [width, height])
  assert.equal(composite.layers.length, 2, 'opaque black + image')
  assert.equal(composite.layers[1].input.id, effect.output.id, 'geometry -> layer')
  for (const l of composite.layers) {
    assert.equal(l.external, false)
    const p = l.params
    for (const [k, v] of Object.entries({
      opacity: 1,
      blendMode: 'normal',
      posX: 0,
      posY: 0,
      scaleX: 1,
      scaleY: 1,
      rotationZ: 0,
      sourceAspect: width / height,
      outputAspect: width / height,
      hasMask: false,
      maskInvert: false,
      rotationX: 0,
      rotationY: 0,
      perspective: 0,
      maskFeather: 0,
      time: 0,
    }))
      assert.equal(p[k], v, 'composite ' + k)
  }
  assert.equal(output.target, 'pq')
  assert.deepEqual(
    [output.output.width, output.output.height, output.output.format],
    [width, height, 'rgba32float'],
  )
  assert.equal(output.color.workingRange, 'hdr')
  assert.equal(output.color.referenceWhiteNits, 203)
  assert.equal(output.color.masteringPeakNits, 1000)
  assert(contract.audit.draws.length > 0)
  for (const draw of contract.audit.draws) {
    assert(draw.stage && draw.target && draw.pipeline, 'untracked raster command')
    assert.deepEqual([draw.target.width, draw.target.height], [width, height])
    assert.deepEqual(draw.viewport, state.viewport)
    assert.deepEqual(draw.scissor, state.scissor)
    for (const key of ['topology', 'sampleCount', 'sampleMask', 'alphaToCoverageEnabled'])
      assert.equal(draw.pipeline[key], state[key], key)
    assert.deepEqual(draw.draw, [6, 1, 0, 0])
    assert.equal(draw.pipeline.format, draw.target.format)
    assert.equal(draw.target.format, draw.stage === 'output' ? 'rgba32float' : 'rgba16float')
  }
  for (const type of ['media', 'effect', 'composite', 'output'])
    assert(
      contract.audit.draws.some((d) => d.stage === type),
      'missing ' + type + ' raster',
    )
  return { raster, calibration }
}

// Independent interpolation equations. Media zeroing uses RAW alpha; geometry alone
// uses rounded binary16 coverage. Compositor samples straight RGBA before source-over.
const f = Math.fround,
  half = (v) => new Float16Array([v])[0]
function bilinear(values, width, height, x, y, premultiplied) {
  const left = Math.floor(x),
    top = Math.floor(y),
    fx = x - left,
    fy = y - top,
    sum = [0, 0, 0, 0]
  for (const [dx, dy, weight] of [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ]) {
    const at =
      (Math.max(0, Math.min(height - 1, top + dy)) * width +
        Math.max(0, Math.min(width - 1, left + dx))) *
      4
    sum[3] += values[at + 3] * weight
    for (let c = 0; c < 3; c++)
      sum[c] += values[at + c] * (premultiplied ? values[at + 3] : 1) * weight
  }
  return sum
}
export function geometryCompositionStages(values, width, height, entry, effectCoordinates, baseUV) {
  assert.equal(baseUV.length, width * height)
  assert.equal(effectCoordinates.length, width * height)
  const media = baseUV.flatMap(([u, v]) => {
    const px = f(u * width),
      py = f(v * height)
    const lx = f(f(width / 2) + f(px - f(width / 2))),
      ly = f(f(height / 2) + f(py - f(height / 2)))
    const su = f(f(f(lx / width) * width) / width),
      sv = f(f(f(ly / height) * height) / height)
    const sum = bilinear(
      values,
      width,
      height,
      f(f(su * width) - 0.5),
      f(f(sv * height) - 0.5),
      true,
    )
    return sum[3] > 0
      ? [...sum.slice(0, 3).map((c) => half(c / sum[3])), half(sum[3])]
      : [0, 0, 0, 0]
  })
  const geometry = geometryReference(
    media,
    width,
    height,
    entry.type,
    entry.params,
    effectCoordinates,
  ).map(half)
  const composite = baseUV.flatMap(([u, v]) => {
    const tu = f(f(u - 0.5) + 0.5),
      tv = f(f(v - 0.5) + 0.5)
    const rgba = bilinear(
      geometry,
      width,
      height,
      f(f(tu * width) - 0.5),
      f(f(tv * height) - 0.5),
      false,
    )
    return [...rgba.slice(0, 3).map((c) => half(c * rgba[3])), 1]
  })
  return { media, geometry, composite }
}
export function geometryCompositionReference(values, width, height, entry, capture, row, contract) {
  const { raster, calibration } = validateCompositionContract(
    values,
    width,
    height,
    entry,
    capture,
    row,
    contract,
  )
  const base = capture.rows[0].results.find((r) => r.kind === 'independent').values
  const baseUV = Array.from({ length: width * height }, (_, i) => base.slice(i * 8, i * 8 + 2))
  return {
    ...geometryCompositionStages(values, width, height, entry, calibration.coordinates, baseUV),
    arithmeticPolicy: {
      baseUv: 'immutable per-component/per-pixel raster envelope',
      coordinate:
        'explicit f32 placement operations; existing operation-specific geometry error propagation',
      primitiveSinCosBound: 2 ** -11,
      geometryErrors: calibration.errors,
      interpolation:
        'independent weighted light in double precision; premultiplied media/geometry and straight compositor',
      stores:
        'IEEE754 binary16 round-to-nearest ties-to-even at each pass; media raw-alpha zero vs geometry rounded-alpha zero',
      fullPqAbsoluteBound: 0.004,
    },
    raster,
    primitivePolicy: calibration.primitivePolicy,
  }
}
