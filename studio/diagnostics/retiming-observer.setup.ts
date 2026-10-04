import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll } from 'vite-plus/test'
import { TimeStretchProcessor } from '@/infrastructure/audio/time-stretch'

// Hosted diagnostic only. No processor replacement, parameters, buffers or
// selected offsets are written. WeakMap bookkeeping is external to the DSP.
const observed = process.env.FL103_OBSERVER === '1'
const reportPath = process.env.FL103_OBSERVER_REPORT
if (!reportPath) throw new Error('Missing diagnostic report path')
const states = new WeakMap<object, any>()
const records: any[] = []
const prototype = TimeStretchProcessor.prototype
const originalProcess = prototype.process
const stretchPrototype = Object.getPrototypeOf(new TimeStretchProcessor(8, 48_000).stretch)
const originalSeek = stretchPrototype.seekBestOverlapPosition
const interval = [48_000, 52_800] // Original FFT at [72000,76800), minus clip placement 24000.

function snapshot(stretch: any) {
  const fields = Object.entries(stretch)
  const arrays = fields.filter(([, value]) => ArrayBuffer.isView(value))
    .map(([key, value]) => [key, new (value as any).constructor(value)] as const)
  const buffers = [stretch.inputBuffer, stretch.outputBuffer]
    .map((buffer: any) => ({ buffer, fields: Object.entries(buffer), bytes: buffer.vector.slice() }))
  return { fields, arrays, buffers }
}

function unchanged(stretch: any, before: ReturnType<typeof snapshot>) {
  const sameFields = (object: any, fields: [string, unknown][]) => {
    if (Object.keys(object).length !== fields.length || fields.some(([key, value]) => !Object.is(object[key], value)))
      throw new Error('Observer mutated processor fields')
  }
  const sameArray = (actual: any, expected: any) => {
    if (actual.length !== expected.length) throw new Error('Observer resized PCM')
    for (let i = 0; i < actual.length; i++)
      if (!Object.is(actual[i], expected[i])) throw new Error('Observer mutated PCM')
  }
  sameFields(stretch, before.fields)
  for (const [key, bytes] of before.arrays) sameArray(stretch[key], bytes)
  for (const { buffer, fields, bytes } of before.buffers) {
    sameFields(buffer, fields)
    sameArray(buffer.vector, bytes)
  }
}

function alignment(stretch: any, offset: number) {
  const input = stretch.inputBuffer
  return Array.from({ length: stretch.channels }, (_, channel) => {
    let product = 0
    let inputEnergy = 0
    let referenceEnergy = 0
    for (let frame = 1; frame < stretch.overlapLength; frame++) {
      const weight = frame * (stretch.overlapLength - frame)
      const current = input.vector[input.startIndex + (offset + frame) * stretch.channels + channel]
      const reference = stretch.midBuffer[frame * stretch.channels + channel]
      product += current * reference * weight
      inputEnergy += current * current * weight
      referenceEnergy += reference * reference * weight
    }
    return inputEnergy && referenceEnergy ? product / Math.sqrt(inputEnergy * referenceEnergy) : null
  })
}

stretchPrototype.seekBestOverlapPosition = function (...args: any[]) {
  // Invoke the genuine search exactly once, before any read-only comparison.
  const selected = originalSeek.apply(this, args)
  const state = states.get(this)
  if (!state || !observed) return selected
  const start = state.outputFrames + this.outputBuffer.frameCount - state.callStartOutputCount
  const end = start + this.outputChunkSize
  if (start >= interval[1] || end <= interval[0]) return selected
  const before = snapshot(this)
  const selectedScore = this.calculateCrossCorrelationStereo(selected * this.channels, this.refMidBuffer)
  let exhaustiveOffset = 0
  let exhaustiveScore = -Infinity
  for (let offset = 0; offset < this.seekLength; offset++) {
    const score = this.calculateCrossCorrelationStereo(offset * this.channels, this.refMidBuffer)
    if (score > exhaustiveScore) { exhaustiveScore = score; exhaustiveOffset = offset }
  }
  const row = {
    outputInterval: [start, end], selected, selectedScore, exhaustiveOffset, exhaustiveScore,
    selectedAlignment: alignment(this, selected), exhaustiveAlignment: alignment(this, exhaustiveOffset),
    seekLength: this.seekLength, overlapLength: this.overlapLength,
  }
  unchanged(this, before)
  state.overlaps.push(row)
  return selected // Observation never substitutes the exhaustive optimum.
}

prototype.process = function (...args: any[]) {
  if (this.channels !== 8 || this.sampleRate !== 48_000 || this._tempo !== 4 || this._rate !== 0.5)
    return originalProcess.apply(this, args)
  let state = states.get(this.stretch)
  if (!state) {
    state = { outputFrames: 0, callStartOutputCount: 0, digest: createHash('sha256'), overlaps: [] }
    states.set(this.stretch, state)
    records.push(state)
  }
  state.callStartOutputCount = this.outputBuffer.frameCount
  const result = originalProcess.apply(this, args)
  const count = this.outputBuffer.frameCount - state.callStartOutputCount
  if (count < 0) throw new Error('Unexpected DSP output consumption inside process')
  const start = this.outputBuffer.startIndex + state.callStartOutputCount * this.channels
  const bytes = this.outputBuffer.vector.subarray(start, start + count * this.channels)
  state.digest.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  state.outputFrames += count
  return result
}

afterAll(() => {
  prototype.process = originalProcess
  stretchPrototype.seekBestOverlapPosition = originalSeek
  const report = {
    diagnosticOnly: true, observed, fftProcessorInterval: interval,
    records: records.map(({ outputFrames, digest, overlaps }) => ({
      outputFrames, pcmSha256: digest.digest('hex'), overlaps,
    })),
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  if (records.length !== 1) throw new Error('Expected exactly the failing-case processor; test selection changed')
  if (observed && !records[0].overlaps.length) throw new Error('Observer missed failing FFT interval')
})
