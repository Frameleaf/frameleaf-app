import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const PINS = Object.freeze({
  source: '5b29142999ca0f06d8d9f151ad0bfeae95b6b75892b70c38a9532b2152de32ec',
  baseline: 'd93bdd45453983700b23ff423b45a92ce0170fab',
  playwright: '1.60.0',
  revision: '1223',
  browser: '148.0.7778.96',
  executable: 'aa25f2e795c02d5cb5ef5d6987745cc5bbe7d8bea58827390c7a4c81c8d2dd7b',
})
export const BOUNDS = Object.freeze({
  overall: 180000,
  operation: 8000,
  case: 30000,
  cleanup: 10000,
  report: 1048576,
})
export const CASES = ['grant', 'denial', 'late-cancel', 'monitor', 'ownership']
export const WAV_SHA256 = 'de4c3c25a77c114b4c7ce27feb3879a9492b7af91edfb8baa83a0db6f19e86c4'
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Integer triangle wave: identical PCM bytes across runtimes, no private audio.
export function captureWav() {
  const rate = 48000,
    frames = rate * 6
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) {
    const phase = i % 100
    wav.writeInt16LE((phase < 50 ? phase : 100 - phase) * 480 - 12000, 44 + i * 2)
  }
  return wav
}

export function captureArgs(wav) {
  assert.match(wav, /^\//, 'owned absolute WAV required')
  assert(!['\r', '\n', '\0'].some((x) => wav.includes(x)))
  return [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--proxy-bypass-list=<-loopback>',
  ]
}
export function assertCaptureArgs(args, wav) {
  assert.deepEqual(args, captureArgs(wav), 'only reviewed synthetic capture flags are allowed')
}
export function assertPins(observed) {
  for (const name of Object.keys(PINS)) assert.equal(observed[name], PINS[name], `pin ${name}`)
}
export function assertProxy(observations, origin) {
  assert(
    observations.some((x) => x.kind === 'proxied' && x.method === 'GET' && x.url === `${origin}/`),
    'transparent browser entry GET required',
  )
  assert(
    observations.every((x) => x.kind === 'proxied' && new URL(x.url).origin === origin),
    'unexpected request, override, opaque tunnel or proxy error',
  )
}
export async function bounded(task, ms, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export async function cleanupAll(actions, ms = BOUNDS.cleanup) {
  const failures = [],
    completed = []
  // Attempt every owner even after an earlier rejection or timeout.
  for (const [name, action] of actions) {
    try {
      await bounded(action, ms, name)
      completed.push(name)
    } catch (error) {
      failures.push({ name, error: String(error) })
    }
  }
  return { completed, failures }
}
export function reportBytes(report) {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  assert(bytes.length <= BOUNDS.report, 'report exceeds bound')
  return bytes
}
export function recordingBytes(audio) {
  assert(
    typeof audio.encodedBase64 === 'string' && audio.encodedBase64.length <= 349528,
    'encoded artifact bound',
  )
  const bytes = Buffer.from(audio.encodedBase64, 'base64')
  assert.equal(bytes.toString('base64'), audio.encodedBase64, 'canonical recording bytes')
  assert(bytes.length > 0 && bytes.length <= 262144, 'recording byte bound')
  assert.equal(bytes.length, audio.bytes, 'recording byte count')
  assert.equal(sha(bytes), audio.sha256, 'recording digest')
  return bytes
}

// Remember start identity before any signal, including observed descendants that detach.
export function ownedProcesses(rows, group, known) {
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (
        row.group === group ||
        (known.has(row.parent) &&
          rows.some((x) => x.pid === row.parent && x.started === known.get(row.parent)))
      ) {
        if (!known.has(row.pid)) {
          known.set(row.pid, row.started)
          changed = true
        }
      }
    }
  }
  return rows.filter((row) => known.get(row.pid) === row.started)
}
