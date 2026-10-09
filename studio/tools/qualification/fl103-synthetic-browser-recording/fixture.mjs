import { MicRecorder } from '@/infrastructure/audio/mic-recorder/mic-recorder'
import { startMicLevelMonitor } from '@/infrastructure/audio/mic-recorder/monitor'
import * as controller from '@/features/timeline/services/mic-recording-controller'
import { useMicRecordingStore } from '@/shared/state/mic-recording-store'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { mediaProcessorService } from '@/features/media-library/services/media-processor-service'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { VirtualWorkspace } from '@fl103-adapter/virtual-workspace'
import { watchLocalImports } from '@fl103-adapter/project-imports'

const check = (value, message) => {
  if (!value) throw Error(message)
}
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const until = async (test, label, ms = 6000) => {
  const end = performance.now() + ms
  while (!test()) {
    check(performance.now() < end, `missing witness: ${label}`)
    await new Promise(requestAnimationFrame)
  }
}
const digest = async (blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('')
const streams = [],
  contexts = [],
  recorders = [],
  workers = [],
  events = [],
  uploads = [],
  uploadTasks = []
let delivery = null,
  activeRecorder = null,
  monitor = null,
  owner = null,
  watch = null
let levelCount = 0,
  maxLevel = 0,
  workspaceBarrier = null
const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)

// Observation wrappers delegate to native constructors and methods; no media objects are faked.
for (const [name, owners] of [
  ['AudioContext', contexts],
  ['MediaRecorder', recorders],
  ['Worker', workers],
]) {
  const Native = window[name]
  check(typeof Native === 'function', `native ${name} unavailable`)
  window[name] = new Proxy(Native, {
    construct(target, args) {
      const instance = Reflect.construct(target, args)
      owners.push(instance)
      if (name === 'MediaRecorder') {
        for (const event of ['start', 'pause', 'resume', 'dataavailable', 'stop', 'error'])
          instance.addEventListener(event, (e) => {
            events.push({
              event,
              trusted: e.isTrusted,
              at: performance.now(),
              recorder: owners.indexOf(instance),
              size: e.data?.size ?? null,
            })
          })
      }
      return instance
    },
  })
}
navigator.mediaDevices.getUserMedia = async (constraints) => {
  check(
    constraints.video === false && !!constraints.audio,
    'audio-only production capture required',
  )
  const gate = delivery
  const stream = await nativeGetUserMedia(constraints)
  streams.push(stream)
  events.push({
    event: 'native-capture-acquired',
    at: performance.now(),
    tracks: stream.getTracks().length,
  })
  if (gate) {
    gate.entered.resolve()
    await gate.release.promise
  }
  events.push({ event: 'capture-delivered', at: performance.now() })
  return stream
}
const levels = (value) => {
  levelCount++
  maxLevel = Math.max(maxLevel, value)
}
const startGate = () => {
  delivery = { entered: deferred(), release: deferred() }
  return delivery
}
const releaseGate = () => {
  delivery?.release.resolve()
  delivery = null
}
const sampleCapture = async () => {
  const started = performance.now()
  await until(
    () => maxLevel > 0.005 && performance.now() - started >= 350,
    'nonzero actual native meter samples',
  )
}
async function decoded(blob) {
  check(blob.size > 0, 'empty native recording')
  check(blob.size <= 262144, 'native recording exceeds specimen bound')
  const context = new AudioContext()
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    let peak = 0,
      squares = 0
    const samples = audio.getChannelData(0)
    for (const x of samples) {
      peak = Math.max(peak, Math.abs(x))
      squares += x * x
    }
    check(
      audio.length > 0 && audio.duration > 0 && Number.isFinite(audio.duration),
      'invalid decoded duration',
    )
    check(peak > 0.005 && squares / samples.length > 0.000001, 'synthetic signal absent')
    return {
      bytes: blob.size,
      mime: blob.type,
      sha256: await digest(blob),
      sampleRate: audio.sampleRate,
      channels: audio.numberOfChannels,
      frames: audio.length,
      duration: audio.duration,
      peak,
      meanSquare: squares / samples.length,
      encodedBase64: btoa(
        Array.from(new Uint8Array(await blob.arrayBuffer()), (x) => String.fromCharCode(x)).join(
          '',
        ),
      ),
    }
  } finally {
    await context.close()
  }
}
async function settled() {
  await until(
    () =>
      streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')) &&
      contexts.every((c) => c.state === 'closed'),
    'tracks ended and actual AudioContexts closed',
  )
  return {
    tracks: streams.flatMap((s) =>
      s
        .getTracks()
        .map((t) => ({ streamId: s.id, trackId: t.id, kind: t.kind, readyState: t.readyState })),
    ),
    contexts: contexts.map((c, id) => ({ id, state: c.state, sampleRate: c.sampleRate })),
  }
}
function emptyState() {
  controller.cancelMicRecording()
  controller.stopMicMonitor()
  useItemsStore.getState().setItems([])
  useItemsStore.getState().setTracks([])
  useSelectionStore.getState().clearSelection()
  useTimelineSettingsStore.setState({ fps: 30 })
  usePlaybackStore.getState().setCurrentFrame(12)
  useMicRecordingStore.setState({
    muteWhileRecording: false,
    noiseSuppression: false,
    autoGainControl: false,
    syncOffsetMs: 0,
  })
}
function workspace(root, project) {
  setWorkspaceRoot(root)
  useMediaLibraryStore.getState().setCurrentProject(project)
}
function installImportWatch(a) {
  const known = new Set()
  watch = watchLocalImports({
    workspace: a,
    media: { known: (id) => known.has(id), kept: (id) => known.add(id) },
    upload: (upload) => {
      const task = (async () => {
        uploads.push({
          id: upload.id,
          fileName: upload.fileName,
          bytes: upload.file.size,
          sha256: await digest(upload.file),
          scope: 'local-observation-sink-only',
        })
        return { id: upload.id }
      })()
      uploadTasks.push(task)
      return task
    },
    refused: (_file, reason) => {
      throw Error(`local handoff refused: ${reason}`)
    },
  })
}
// Keep actual VirtualWorkspace handle identity (its move implementation uses a WeakMap).
function barrierHandle(handle, path = []) {
  const directory = handle.getDirectoryHandle.bind(handle),
    file = handle.getFileHandle.bind(handle)
  handle.getDirectoryHandle = async (name, options) =>
    barrierHandle(await directory(name, options), [...path, name])
  handle.getFileHandle = async (name, options) => {
    const child = await file(name, options),
      writable = child.createWritable.bind(child)
    child.createWritable = async (options) => {
      const stream = await writable(options),
        close = stream.close.bind(stream)
      stream.close = async () => {
        await close()
        if (
          workspaceBarrier &&
          path.length === 2 &&
          path[0] === 'media' &&
          /\.(webm|ogg|m4a)$/.test(name)
        ) {
          const gate = workspaceBarrier
          gate.path = [...path, name]
          gate.entered.resolve()
          await gate.release.promise
        }
      }
      return stream
    }
    return child
  }
  return handle
}
const artifacts = async (a) => {
  const result = []
  for (const dir of a.list(['media']).filter((x) => x.kind === 'directory')) {
    for (const entry of a.list(['media', dir.name]).filter((x) => x.kind === 'file')) {
      const path = ['media', dir.name, entry.name],
        file = await a.readFile(path)
      check(file, 'missing enumerated artifact')
      result.push({ path, bytes: file.size, sha256: await digest(file) })
    }
  }
  return result
}
async function takeSample() {
  const before = contexts.length
  await controller.startMicRecording()
  check(useMicRecordingStore.getState().status === 'recording', 'real controller did not start')
  await until(
    () => useMicRecordingStore.getState().level > 0.005 && contexts.length > before,
    'controller actual meter',
  )
  const started = performance.now()
  await until(() => performance.now() - started >= 350, 'capture specimen interval')
}

const cases = {
  async grant() {
    activeRecorder = new MicRecorder()
    await activeRecorder.start({ noiseSuppression: false, autoGainControl: false, onLevel: levels })
    await sampleCapture()
    activeRecorder.pause()
    await until(() => events.some((x) => x.event === 'pause'), 'native pause event')
    activeRecorder.resume()
    await until(() => events.some((x) => x.event === 'resume'), 'native resume event')
    await sampleCapture()
    const result = await activeRecorder.stop()
    activeRecorder.dispose()
    check(result.mimeType && result.durationMs > 0, 'missing recording MIME/duration')
    check(
      events.some((x) => x.event === 'dataavailable' && x.size > 0) &&
        events.some((x) => x.event === 'stop'),
      'missing native terminal data/events',
    )
    return {
      audio: await decoded(result.blob),
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      levels: { count: levelCount, maximum: maxLevel },
      resources: await settled(),
    }
  },
  async denial() {
    activeRecorder = new MicRecorder()
    let failure
    try {
      await activeRecorder.start({ onLevel: levels })
    } catch (error) {
      failure = { name: error.name, message: error.message }
    }
    activeRecorder.dispose()
    check(failure?.name === 'NotAllowedError', 'native browser denial required')
    emptyState()
    const a = new VirtualWorkspace()
    owner = [a]
    workspace(a.handle(), '00000000-0000-4000-8000-00000000000a')
    installImportWatch(a)
    await controller.startMicRecording()
    check(
      useMicRecordingStore.getState().status === 'idle' &&
        useMicRecordingStore.getState().error !== null,
      'controller did not surface native refusal',
    )
    check(
      a.list(['media']).length === 0 &&
        uploads.length === 0 &&
        useItemsStore.getState().items.length === 0,
      'controller denial published artifact',
    )
    check(
      streams.length === 0 && contexts.length === 0 && recorders.length === 0 && levelCount === 0,
      'denial allocated capture resources',
    )
    return { failure, resources: await settled(), artifacts: 0 }
  },
  async 'late-cancel'() {
    const gate = startGate()
    activeRecorder = new MicRecorder()
    const starting = activeRecorder.start({ onLevel: levels }).then(
      () => 'resolved',
      (e) => e.name,
    )
    await gate.entered.promise
    activeRecorder.dispose()
    events.push({ event: 'disposed-before-native-stream-delivery', at: performance.now() })
    releaseGate()
    check((await starting) === 'AbortError', 'late acquisition must settle AbortError')
    check(
      contexts.length === 0 && recorders.length === 0 && levelCount === 0,
      'late acquisition revived native recording/meter',
    )
    return {
      artificialBarrier: 'delivery-of-real-native-getUserMedia-stream; not OS permission latency',
      resources: await settled(),
    }
  },
  async monitor() {
    const gate = startGate()
    let current = true
    const starting = startMicLevelMonitor({ onLevel: levels, isCurrent: () => current }).then(
      (x) => {
        monitor = x
        return 'resolved'
      },
      (e) => e.name,
    )
    await gate.entered.promise
    current = false
    releaseGate()
    check((await starting) === 'AbortError', 'retired monitor must refuse native late stream')
    check(contexts.length === 0 && levelCount === 0, 'retired monitor allocated native meter')
    await settled()
    monitor = await startMicLevelMonitor({
      noiseSuppression: false,
      autoGainControl: false,
      onLevel: levels,
    })
    await sampleCapture()
    monitor.stop()
    const count = levelCount
    await settled()
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    check(
      levelCount === count && recorders.length === 0,
      'monitor callback after stop or recording allocation',
    )
    return { retired: true, ordinaryLevels: count, resources: await settled() }
  },
  async ownership() {
    emptyState()
    const a = new VirtualWorkspace(),
      b = new VirtualWorkspace()
    owner = [a, b]
    const rootA = barrierHandle(a.handle()),
      rootB = b.handle()
    const projectA = '00000000-0000-4000-8000-00000000000a',
      projectB = '00000000-0000-4000-8000-00000000000b'
    workspace(rootA, projectA)
    installImportWatch(a)
    // Cancellation before native stream delivery must not create any source/upload/clip.
    const gate = startGate()
    const pending = controller.startMicRecording()
    await gate.entered.promise
    controller.cancelPendingMicRecording()
    releaseGate()
    await pending
    check(
      a.list(['media']).length === 0 &&
        uploads.length === 0 &&
        useItemsStore.getState().items.length === 0,
      'cancel-before-acquisition published artifact',
    )
    await settled()
    await takeSample()
    await controller.stopMicRecording()
    check(useMicRecordingStore.getState().error === null, 'ordinary real import failed')
    const ordinaryItems = useItemsStore.getState().items.map((x) => ({
      mediaId: x.mediaId,
      from: x.from,
      durationInFrames: x.durationInFrames,
    }))
    check(
      ordinaryItems.length === 1 && ordinaryItems[0].from === 12,
      'ordinary take placement/anchor',
    )
    await Promise.all(uploadTasks)
    const ordinary = await artifacts(a),
      mediaId = ordinaryItems[0].mediaId
    check(
      ordinary.some((x) => x.path[1] === mediaId && x.path[2] === 'metadata.json'),
      'real metadata missing',
    )
    const source = ordinary.find(
      (x) => x.path[1] === mediaId && /\.(webm|ogg|m4a)$/.test(x.path[2]),
    )
    check(
      source && uploads.length === 1 && uploads[0].sha256 === source.sha256,
      'actual source/handoff hash differs',
    )
    const audio = await decoded(await a.readFile(source.path))
    check(
      (await a.readText(['projects', projectA, 'media-links.json']))?.includes(mediaId),
      'origin project association missing',
    )
    useItemsStore.getState().setItems([])
    useItemsStore.getState().setTracks([])
    useSelectionStore.getState().clearSelection()
    usePlaybackStore.getState().setCurrentFrame(12)
    await takeSample()
    workspaceBarrier = { entered: deferred(), release: deferred() }
    const stop = controller.stopMicRecording()
    await workspaceBarrier.entered.promise
    const admittedPath = workspaceBarrier.path
    workspace(rootB, projectB)
    workspace(rootA, projectA)
    workspaceBarrier.release.resolve()
    await stop
    workspaceBarrier = null
    await Promise.all(uploadTasks)
    check(
      useItemsStore.getState().items.length === 0 &&
        useSelectionStore.getState().selectedItemIds.length === 0 &&
        useMicRecordingStore.getState().error === null,
      'retired take published current timeline/selection/error',
    )
    check(
      b.list(['media']).length === 0 && b.list(['projects']).length === 0,
      'origin artifact leaked into B',
    )
    const originFile = await a.readFile(admittedPath)
    check(originFile?.size > 0, 'admitted successful origin bytes lost')
    const retiredId = admittedPath[1]
    check(
      await a.readText(['media', retiredId, 'metadata.json']),
      'admitted origin metadata missing',
    )
    check(
      (await a.readText(['projects', projectA, 'media-links.json']))?.includes(retiredId),
      'admitted origin association missing',
    )
    const retiredHash = await digest(originFile)
    check(
      uploads.length === 2 && uploads.some((x) => x.id === retiredId && x.sha256 === retiredHash),
      'retired source local handoff missing',
    )
    return {
      scope:
        'local adapter memory and upload observation sink only; not backend durability/privacy',
      ordinaryItems,
      audio,
      original: await artifacts(a),
      replacement: await artifacts(b),
      uploads,
      retiredSourceSha256: await digest(originFile),
      retiredAudio: await decoded(originFile),
      resources: await settled(),
    }
  },
}

window.fl103 = {
  ready: true,
  async run(name) {
    check(cases[name], 'unknown case')
    const permission = (await navigator.permissions.query({ name: 'microphone' })).state
    check(
      permission === (name === 'denial' ? 'denied' : 'granted'),
      'native permission witness differs',
    )
    const startedAt = new Date().toISOString()
    const measurement = await cases[name]()
    return {
      name,
      startedAt,
      finishedAt: new Date().toISOString(),
      permission,
      measurement,
      events,
    }
  },
  async cleanup() {
    releaseGate()
    workspaceBarrier?.release.resolve()
    workspaceBarrier = null
    const failures = []
    const attempt = async (action) => {
      try {
        await action()
      } catch (error) {
        failures.push(String(error))
      }
    }
    for (const action of [
      () => controller.cancelMicRecording(),
      () => controller.stopMicMonitor(),
      () => activeRecorder?.dispose(),
      () => monitor?.stop(),
      () => watch?.stop(),
      () => mediaProcessorService.dispose(),
      ...workers.map((w) => () => w.terminate()),
    ])
      await attempt(action)
    // A failed production release remains a refusal even when emergency cleanup succeeds.
    let resources
    await attempt(async () => {
      resources = await settled()
    })
    for (const track of streams.flatMap((s) => s.getTracks()))
      if (track.readyState !== 'ended') await attempt(() => track.stop())
    for (const context of contexts)
      if (context.state !== 'closed') await attempt(() => context.close())
    await attempt(() => Promise.all(uploadTasks))
    await attempt(() => blobUrlManager.releaseAll())
    await attempt(() => setWorkspaceRoot(null))
    for (const workspace of owner ?? []) await attempt(() => workspace.dispose())
    check(failures.length === 0, `native cleanup refused: ${failures.join('; ')}`)
    return resources
  },
}
