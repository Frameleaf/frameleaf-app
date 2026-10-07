import { describe, expect, it, vi } from 'vite-plus/test'
import { createStudioTranscriptionHandlers, type StudioTranscriptionJob } from '@frameleaf/host/transcription-jobs'
import { createStudioBridge } from '@frameleaf/host/bridge'
import { createStudioCommandEnvelope } from '@frameleaf/host/commands'
import { emptyStudioCapabilities, type StudioAssetRef, type StudioCommandEngine, type StudioTranscriptionOutcome, type StudioTranscriptionProgress } from '@frameleaf/host/host-contract'
import { createStudioGraphHistory } from '@frameleaf/host/engine-commands'
import { applyCanonicalCommands, type CanonicalEnvelope } from '../src/canonical-commands'

const setup = (runtimeReady = Promise.resolve(), applyReady = Promise.resolve()) => {
  let graph: unknown = { id: 'project', name: 'Captions', createdAt: 0, updatedAt: 0, schemaVersion: 15,
    metadata: { fps: 30, width: 1920, height: 1080 }, timeline: { tracks: [], items: [], transitions: [], keyframes: [] } }
  let assets: readonly StudioAssetRef[] = []
  let projectId = 'project'
  const context = { revision: 3, hasLease: true, hasAccess: true, online: true,
    capabilities: { ...emptyStudioCapabilities(), transcriptionWorker: true } }
  let complete!: (outcome: StudioTranscriptionOutcome) => void
  let report!: (progress: StudioTranscriptionProgress) => void
  const runtime = { apply: vi.fn(), dispose: vi.fn(), cancelTranscription: vi.fn(),
    transcribe: vi.fn((_graph, _envelope, _assets, onProgress) => {
      report = onProgress
      return new Promise<StudioTranscriptionOutcome>((resolve) => { complete = resolve })
    }) } satisfies StudioCommandEngine
  const states: StudioTranscriptionJob[] = []
  const stage = vi.fn((next: unknown) => { graph = next; return 'staged' as const })
  const canonical: StudioCommandEngine = { dispose() {}, async apply(input, batch) {
    const result = await applyCanonicalCommands(input, batch as unknown as readonly CanonicalEnvelope[], [])
    await applyReady
    return result.status === 'applied' ? { status: 'applied', graph: result.project, digest: result.digest } : result
  } }
  const owner = { id: 'owner' }
  const host = createStudioTranscriptionHandlers({ graph: () => graph, revision: () => context.revision,
    projectId: () => projectId, ownerId: () => owner.id, context: () => context, assets: () => assets,
    stage, history: createStudioGraphHistory(), restore: async () => false, engine: async () => canonical,
    createRuntime: async () => { await runtimeReady; return runtime }, onChange: (state) => states.push(state) })
  const bridge = createStudioBridge({ context: () => context, handlers: host.handlers })
  const envelope = createStudioCommandEnvelope('job.enqueueTranscription', { sequenceId: 'main', language: 'en', destinationId: 'browser-local' }, 3)
  return { host, bridge, envelope, context, runtime, states, stage, owner,
    complete: (outcome: StudioTranscriptionOutcome) => complete(outcome), report: (value: StudioTranscriptionProgress) => report(value),
    canonical, graph: () => graph, edit: () => { graph = { ...(graph as object), edited: true } },
    changeAssets: () => { assets = [] }, changeProject: () => { projectId = 'other' } }
}
const captions = [{ text: 'Actual worker result', start: { num: 1, den: 1 }, end: { num: 2, den: 1 } }]
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// Frame outcomes are doubled; canonical graph application is the real implementation.
describe('browser transcription host commands', () => {
  it('queues once, reports real worker progress, and applies its artifact through the canonical captions handler', async () => {
    const s = setup()
    expect(await s.bridge.submit([s.envelope, s.envelope])).toEqual([
      { status: 'accepted', idempotencyKey: s.envelope.idempotencyKey, revision: 3 },
      { status: 'accepted', idempotencyKey: s.envelope.idempotencyKey, revision: 3 },
    ])
    expect(s.runtime.transcribe).toHaveBeenCalledTimes(1)
    const progress = { mediaId: 'media', stage: 'transcribing', progress: 0.5, completed: 0, total: 1 }
    s.report(progress)
    expect(s.states.at(-1)).toMatchObject({ status: 'running', progress })
    s.complete({ status: 'completed', captions })
    await vi.waitFor(() => expect(s.states.at(-1)).toMatchObject({ status: 'applied' }))
    expect(s.stage).toHaveBeenCalledWith(expect.objectContaining({ timeline: expect.objectContaining({
      items: [expect.objectContaining({ type: 'text', textRole: 'caption', text: 'Actual worker result', from: 30, durationInFrames: 30 })],
    }) }), ['captions.set'], [expect.objectContaining({ id: 'captions.set', payload: { captions } })])
    expect(s.states.at(-1).status).toBe('applied')
    expect(s.runtime.dispose).toHaveBeenCalled()
  })

  it.each(['edit', 'revision', 'lease', 'access', 'offline', 'owner', 'capability', 'cancel', 'assets', 'project'])(
    'destroys the job and refuses its late artifact after %s', async (change) => {
      const s = setup()
      await s.bridge.submit([s.envelope])
      if (change === 'edit') s.edit()
      if (change === 'revision') s.context.revision++
      if (change === 'lease') s.context.hasLease = false
      if (change === 'access') s.context.hasAccess = false
      if (change === 'offline') s.context.online = false
      if (change === 'owner') s.owner.id = 'other'
      if (change === 'capability') s.context.capabilities.transcriptionWorker = false
      if (change === 'assets') s.changeAssets()
      if (change === 'project') s.changeProject()
      if (change === 'cancel') await s.bridge.submit([createStudioCommandEnvelope('job.cancel', { jobId: s.envelope.idempotencyKey }, 3)])
      s.host.reconcile()
      s.complete({ status: 'completed', captions })
      await tick()
      expect(s.runtime.cancelTranscription).toHaveBeenCalled()
      expect(s.runtime.dispose).toHaveBeenCalled()
      expect(s.stage).not.toHaveBeenCalled()
      expect(s.states.at(-1).status).toBe('cancelled')
    },
  )

  it('disposes a frame that finishes starting after cancellation', async () => {
    let ready!: () => void
    const s = setup(new Promise<void>((resolve) => { ready = resolve }))
    const pending = s.bridge.submit([s.envelope])
    await vi.waitFor(() => expect(s.states.at(-1)?.status).toBe('queued'))
    s.host.dispose()
    ready()
    expect((await pending)[0]?.status).toBe('rejected')
    expect(s.runtime.dispose).toHaveBeenCalled()
    expect(s.runtime.transcribe).not.toHaveBeenCalled()
  })

  it('never stages captions cancelled while canonical application is in flight', async () => {
    let ready!: () => void
    const s = setup(Promise.resolve(), new Promise<void>((resolve) => { ready = resolve }))
    const applying = vi.spyOn(s.canonical, 'apply')
    await s.bridge.submit([s.envelope])
    s.complete({ status: 'completed', captions })
    await vi.waitFor(() => expect(applying).toHaveBeenCalled())
    s.host.dispose()
    ready()
    await vi.waitFor(() => expect(s.runtime.dispose).toHaveBeenCalled())
    await tick()
    expect(s.stage).not.toHaveBeenCalled()
    expect(s.states.at(-1)?.status).toBe('cancelled')
  })

  it('keeps worker/model refusals explicit and never replaces captions with an invalid artifact', async () => {
    const s = setup()
    await s.bridge.submit([s.envelope])
    s.complete({ status: 'rejected', detail: 'FRAMELEAF_RESOURCE_BLOCKED' })
    await tick()
    expect(s.stage).not.toHaveBeenCalled()
    expect(s.states.at(-1)).toMatchObject({ status: 'failed', detail: 'FRAMELEAF_RESOURCE_BLOCKED' })
    const next = setup()
    await next.bridge.submit([next.envelope])
    next.complete({ status: 'completed', captions: [{ ...captions[0]!, end: { num: 0, den: 1 } }] })
    await tick()
    expect(next.stage).not.toHaveBeenCalled()
    expect(next.states.at(-1).status).toBe('failed')
    const empty = setup()
    await empty.bridge.submit([empty.envelope])
    empty.complete({ status: 'completed', captions: [] })
    await tick()
    expect(empty.stage).not.toHaveBeenCalled()
    expect(empty.states.at(-1)).toMatchObject({ status: 'failed', detail: expect.stringContaining('existing captions were kept') })
  })

  it('refuses other destinations, stale requests, read-only sessions and concurrent jobs before launch', async () => {
    for (const variant of ['cloud', 'revision', 'lease']) {
      const s = setup()
      if (variant === 'cloud') s.envelope.payload.destinationId = 'cloud'
      if (variant === 'revision') s.envelope.revision--
      if (variant === 'lease') s.context.hasLease = false
      expect((await s.bridge.submit([s.envelope]))[0]!.status).toBe('rejected')
      expect(s.runtime.transcribe).not.toHaveBeenCalled()
    }
    const s = setup()
    await s.bridge.submit([s.envelope])
    const other = { ...s.envelope, idempotencyKey: 'other' }
    expect((await s.bridge.submit([other]))[0]!.status).toBe('rejected')
    s.host.dispose()
  })
})
