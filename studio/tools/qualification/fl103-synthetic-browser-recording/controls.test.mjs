import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOUNDS,
  PINS,
  WAV_SHA256,
  assertCaptureArgs,
  assertPins,
  assertProxy,
  bounded,
  captureArgs,
  captureWav,
  cleanupAll,
  ownedProcesses,
  signalOwnedProcesses,
  recordingBytes,
  reportBytes,
  sha,
} from './controls.mjs'

test('deterministic mono PCM fixture has valid headers and nonzero bounded samples', () => {
  const wav = captureWav()
  assert.equal(wav.length, 576044)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  assert.equal(wav.readUInt32LE(24), 48000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(sha(wav), sha(captureWav()))
  assert.equal(sha(wav), WAV_SHA256)
  let energy = 0
  for (let i = 44; i < wav.length; i += 2) {
    const sample = wav.readInt16LE(i)
    assert(Math.abs(sample) <= 12000)
    energy += sample * sample
  }
  assert(energy > 0)
})
test('all identity fields fail closed on a wrong pin', () => {
  assertPins(PINS)
  for (const key of Object.keys(PINS))
    assert.throws(() => assertPins({ ...PINS, [key]: 'wrong' }), /pin/)
})
test('capture cannot acquire real devices or auto-grant fake permission UI', () => {
  const wav = '/owned/capture.wav',
    args = captureArgs(wav)
  assertCaptureArgs(args, wav)
  for (const wrong of [
    args.slice(1),
    [...args, '--use-fake-ui-for-media-stream'],
    [...args, '--use-file-for-fake-audio-capture=/other.wav'],
  ]) {
    assert.throws(() => assertCaptureArgs(wrong, wav))
  }
  assert.throws(() => captureArgs('relative.wav'))
})
test('proxy receipt requires entry traffic and refuses every non-proxied request', () => {
  const origin = 'http://127.0.0.1:12345'
  const entry = { kind: 'proxied', method: 'GET', url: origin + '/' }
  assertProxy([entry], origin)
  assert.throws(() => assertProxy([], origin))
  for (const kind of ['blocked', 'error', 'tunnelled', 'override'])
    assert.throws(() => assertProxy([entry, { ...entry, kind }], origin))
  assert.throws(() => assertProxy([entry, { ...entry, url: 'https://outside.test/' }], origin))
})
test('cleanup preserves order and attempts owners after errors and hangs', async () => {
  const order = []
  const result = await cleanupAll(
    [
      [
        'fixture',
        () => {
          order.push('fixture')
          throw Error('fixture refused')
        },
      ],
      [
        'context',
        () => {
          order.push('context')
          return new Promise(() => {})
        },
      ],
      [
        'browser',
        () => {
          order.push('browser')
        },
      ],
      [
        'proxy',
        () => {
          order.push('proxy')
        },
      ],
      [
        'server',
        () => {
          order.push('server')
        },
      ],
    ],
    10,
  )
  assert.deepEqual(order, ['fixture', 'context', 'browser', 'proxy', 'server'])
  assert.deepEqual(
    result.failures.map((x) => x.name),
    ['fixture', 'context'],
  )
  assert.deepEqual(result.completed, ['browser', 'proxy', 'server'])
})
test('missing witnesses time out and oversized reports cannot be published', async () => {
  await assert.rejects(
    bounded(() => new Promise(() => {}), 10, 'missing native event'),
    /timeout/,
  )
  assert.throws(() => reportBytes({ raw: 'x'.repeat(BOUNDS.report) }), /report exceeds/)
  assert(JSON.parse(reportBytes({ passed: false })).passed === false)
})
test('observed detached descendants remain owned after reparenting; PID reuse is excluded', () => {
  const child = { pid: 10, parent: 1, group: 10, started: 'child-start' }
  const known = new Map([[child.pid, child.started]])
  const browser = { pid: 11, parent: 10, group: 10, started: 'browser-start' }
  const detached = { pid: 12, parent: 11, group: 12, started: 'detached-start' }
  assert.equal(ownedProcesses([detached, browser, child], known).length, 3)
  assert.deepEqual(ownedProcesses([{ ...detached, parent: 1 }], known), [
    { ...detached, parent: 1 },
  ])
  assert.deepEqual(ownedProcesses([{ ...detached, started: 'new-unrelated-process' }], known), [])
})
test('native recording transport refuses changed, malformed or oversized bytes', () => {
  const bytes = Buffer.from('owned synthetic encoded specimen')
  const audio = {
    encodedBase64: bytes.toString('base64'),
    bytes: bytes.length,
    sha256: sha(bytes),
  }
  assert.deepEqual(recordingBytes(audio), bytes)
  for (const wrong of [
    { ...audio, sha256: 'bad' },
    { ...audio, bytes: 0 },
    { ...audio, encodedBase64: audio.encodedBase64 + '!' },
    { ...audio, encodedBase64: 'a'.repeat(349529) },
  ])
    assert.throws(() => recordingBytes(wrong))
})

test('retired original group never adopts or signals replacement group members', () => {
  const leader = { pid: 10, parent: 1, group: 10, started: 'original-leader' }
  const browser = { pid: 11, parent: 10, group: 10, started: 'original-browser' }
  const detached = { pid: 12, parent: 11, group: 12, started: 'owned-detached' }
  const known = new Map([[10, leader.started]])
  assert.equal(ownedProcesses([detached, browser, leader], known).length, 3)
  const replacement = { pid: 13, parent: 1, group: 10, started: 'unrelated-new-member' }
  const reusedLeader = { ...leader, started: 'unrelated-reused-leader' }
  const current = [{ ...detached, parent: 1 }, replacement, reusedLeader]
  const sent = []
  signalOwnedProcesses(current.slice(0, 2), known, 'SIGTERM', (...args) => sent.push(args))
  assert.deepEqual(sent, [[12, 'SIGTERM']])
  sent.length = 0
  signalOwnedProcesses(current, new Map(), 'SIGTERM', (...args) => sent.push(args))
  assert.deepEqual(sent, [])
  assert.deepEqual(
    signalOwnedProcesses(current, known, 'SIGTERM', (...args) => sent.push(args)),
    [current[0]],
  )
  assert.deepEqual(sent, [[12, 'SIGTERM']])
  assert.equal(known.has(13), false)
  const descendant = { pid: 14, parent: 12, group: 14, started: 'verified-descendant' }
  sent.length = 0
  signalOwnedProcesses([descendant, ...current], known, 'SIGKILL', (...args) => sent.push(args))
  assert.deepEqual(sent, [
    [14, 'SIGKILL'],
    [12, 'SIGKILL'],
  ])
  assert(sent.every(([pid]) => pid > 0 && ![10, 13].includes(pid)))
})
