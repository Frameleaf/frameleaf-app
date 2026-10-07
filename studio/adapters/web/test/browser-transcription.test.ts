import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { StudioTranscriptionRequest } from '@frameleaf/host/frame-protocol'

const state = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn(), admit: vi.fn(), seed: vi.fn(), dispose: vi.fn() }))
vi.mock('@/features/media-library/services/media-transcription-runner', () => ({ runMediaTranscriptionJob: state.run, cancelMediaTranscriptionJob: state.cancel }))
vi.mock('@/shared/utils/resource-admission.mjs', () => ({ requireResource: state.admit }))
vi.mock('../src/library-media', () => ({ createLibraryMediaSeeder: () => ({ seed: state.seed, dispose: state.dispose }) }))
import { transcribeSequence } from '../src/browser-transcription'

const mediaId = '0198a1c2-0000-7000-8000-000000000001'
const request = (): StudioTranscriptionRequest => ({ type: 'transcribe', requestId: 1,
  envelope: { id: 'job.enqueueTranscription', payload: { sequenceId: 'main', language: 'ja', destinationId: 'browser-local' }, revision: 3, idempotencyKey: 'job', issuedAt: 1 },
  graph: { id: 'project', metadata: { fps: 30, width: 1920, height: 1080 }, timeline: { items: [
    { id: 'video', type: 'video', mediaId, trackId: 'v1', from: 60, durationInFrames: 60, sourceStart: 30, sourceEnd: 150, sourceFps: 30, speed: 2, linkedGroupId: 'pair' },
    { id: 'audio', type: 'audio', mediaId, trackId: 'a1', from: 60, durationInFrames: 60, sourceStart: 30, sourceEnd: 150, sourceFps: 30, speed: 2, linkedGroupId: 'pair' },
  ] } },
  assets: [{ id: mediaId, kind: 'video', name: 'fixture.mp4', isOffline: false, duration: { num: 5, den: 1 }, previewUrl: '/fixture', playbackUrl: '/fixture', thumbnailUrl: '/fixture' }],
})
const artifact = { status: 'completed', transcript: { segments: [
  { text: 'Before trim', start: 0, end: 0.5 }, { text: 'Aligned', start: 2, end: 3 }, { text: 'After clip', start: 6, end: 7 },
] } }
beforeEach(() => { vi.clearAllMocks(); state.run.mockResolvedValue(artifact); state.admit.mockReset(); state.seed.mockResolvedValue(undefined) })

// The native worker is doubled here; these checks prove routing/timing, not model inference.
describe('native browser transcription adapter', () => {
  it('retains language fallback, de-duplicates linked audio/video, and maps trimmed 2x source cues with native timing', async () => {
    const result = await transcribeSequence(request(), new AbortController().signal, vi.fn())
    expect(state.admit).toHaveBeenCalledWith('model:onnx-community/whisper-base_timestamped')
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run).toHaveBeenCalledWith(mediaId, expect.objectContaining({ language: 'ja' }))
    expect(result).toEqual({ status: 'completed', captions: [{ text: 'Aligned', start: { num: 5, den: 2 }, end: { num: 3, den: 1 } }] })
    expect(state.dispose).toHaveBeenCalled()
  })

  it.each(['missing', 'offline', 'compound', 'reverse', 'destination', 'sequence', 'source-start', 'source-end', 'source-fps', 'generated', 'ambiguous-main'])(
    'refuses %s before media reads or worker launch', async (variant) => {
      const r = request()
      if (variant === 'missing') r.assets = []
      if (variant === 'offline') r.assets[0]!.isOffline = true
      if (variant === 'destination') r.envelope.payload.destinationId = 'lan'
      if (variant === 'sequence') r.envelope.payload.sequenceId = 'nested'
      if (variant === 'compound') (r.graph as any).timeline.items.push({ type: 'composition' })
      if (variant === 'reverse') (r.graph as any).timeline.items[0].isReversed = true
      if (variant === 'source-start') (r.graph as any).timeline.items[0].sourceStart = -1
      if (variant === 'source-end') (r.graph as any).timeline.items[0].sourceEnd = 0
      if (variant === 'source-fps') (r.graph as any).timeline.items[0].sourceFps = 0
      if (variant === 'ambiguous-main') (r.graph as any).timeline.compositions = [{ id: 'main' }]
      if (variant === 'generated') {
        r.assets[0]!.id = 'restored-media'
        for (const clip of (r.graph as any).timeline.items) clip.mediaId = 'restored-media'
      }
      await expect(transcribeSequence(r, new AbortController().signal, vi.fn())).rejects.toThrow()
      expect(state.seed).not.toHaveBeenCalled()
      expect(state.run).not.toHaveBeenCalled()
    },
  )

  it('admits the exact native model before reading private media', async () => {
    state.admit.mockImplementation(() => { throw new Error('FRAMELEAF_RESOURCE_BLOCKED') })
    await expect(transcribeSequence(request(), new AbortController().signal, vi.fn())).rejects.toThrow('FRAMELEAF_RESOURCE_BLOCKED')
    expect(state.seed).not.toHaveBeenCalled()
    expect(state.run).not.toHaveBeenCalled()
  })

  it('keeps exact NTSC project frames and refuses an empty transcript', async () => {
    const r = request()
    ;(r.graph as any).metadata = { fps: 30000 / 1001, frameRate: { num: 30000, den: 1001 }, width: 1920, height: 1080 }
    const result = await transcribeSequence(r, new AbortController().signal, vi.fn())
    expect(result).toEqual({ status: 'completed', captions: [{ text: 'Aligned', start: { num: 37037, den: 15000 }, end: { num: 3003, den: 1000 } }] })
    state.run.mockResolvedValue({ status: 'completed', transcript: { segments: [] } })
    await expect(transcribeSequence(request(), new AbortController().signal, vi.fn())).rejects.toThrow('existing captions were kept')
  })

  it('passes progress through and calls the native cancellation path during a running job', async () => {
    const controller = new AbortController()
    const progress = vi.fn()
    state.run.mockImplementation(async (_id, options) => {
      options.onProgress({ stage: 'transcribing', progress: 0.5 })
      controller.abort()
      return artifact
    })
    await expect(transcribeSequence(request(), controller.signal, progress)).rejects.toThrow()
    expect(progress).toHaveBeenCalledWith({ mediaId, stage: 'transcribing', progress: 0.5, completed: 0, total: 1 })
    expect(state.cancel).toHaveBeenCalledWith(mediaId)
    expect(state.dispose).toHaveBeenCalled()
  })
})
