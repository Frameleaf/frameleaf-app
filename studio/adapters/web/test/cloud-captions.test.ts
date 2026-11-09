import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { StudioCloudCaptionJob, StudioCloudCaptionState } from '@frameleaf/host/cloud-captions'
import type { SubtitleSegmentItem, TimelineItem, TimelineTrack, VideoItem } from '@/types/timeline'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { createCloudCaptions, cuesToSegments, existingLineCount } from '../src/cloud-captions'

const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
  return { toast }
})
vi.mock('sonner', () => ({ toast: toasts.toast }))

const fps = 30
const track = (id: string, order: number): TimelineTrack => ({
  id,
  name: id,
  kind: 'video',
  height: 48,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
  items: [],
})
const clip = (id: string, from: number): VideoItem => ({
  id,
  type: 'video',
  trackId: 'v1',
  from,
  durationInFrames: 300,
  label: id,
  mediaId: `media-${id}`,
  src: `blob:${id}`,
  sourceStart: 0,
  sourceEnd: 300,
  sourceFps: 30,
  speed: 1,
})
const lines = (id: string, clipId: string, from: number, text: string): SubtitleSegmentItem => ({
  id,
  type: 'subtitle',
  trackId: 'captions',
  from,
  durationInFrames: 60,
  label: 'Transcript',
  mediaId: `media-${clipId}`,
  source: { type: 'transcript', mediaId: `media-${clipId}`, clipId },
  cues: [{ id: `${id}-1`, startSeconds: 0, endSeconds: 2, text }],
  color: '#ffffff',
  fontSize: 50,
})
const job = (clipId: string): StudioCloudCaptionJob => ({
  id: 'job-1',
  clipId,
  language: 'auto',
  name: 'Lake.mov',
})
const done = (start: number, end: number): StudioCloudCaptionState => ({
  status: 'completed',
  error: null,
  cues: [{ start, end, text: 'From the Cloud' }],
  anchor: { fromSeconds: 0, sourceStartSeconds: 0, speed: 1 },
})
const seed = (items: TimelineItem[]) => {
  useItemsStore.getState().setTracks([track('captions', 0), track('v1', 1)])
  useItemsStore.getState().setItems(items)
}
const subtitles = () =>
  useItemsStore.getState().items.filter((item): item is SubtitleSegmentItem => item.type === 'subtitle')
const forget = vi.fn(() => Promise.resolve())
const resumeWith = async (pendingJob: StudioCloudCaptionJob, state: StudioCloudCaptionState) => {
  const flow = createCloudCaptions(
    {
      start: vi.fn(),
      read: () => Promise.resolve(state),
      pending: () => Promise.resolve([pendingJob]),
      forget,
      ready: () => Promise.resolve(true),
    },
    1,
  )
  await flow.resume()
}

describe('FL-1304 captions on Frameleaf Cloud', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps timeline cues to the source seconds of the priced clip', () => {
    const anchor = { fromSeconds: 2, sourceStartSeconds: 3, speed: 2 }
    expect(cuesToSegments([{ start: 3, end: 4, text: 'x' }], anchor)).toEqual([
      { text: 'x', start: 5, end: 7 },
    ])
  })

  it('counts only the transcript lines the clip shows', () => {
    const trimmed: VideoItem = {
      ...clip('a', 0),
      sourceStart: 0,
      sourceEnd: 90,
      durationInFrames: 90,
      transcriptCaptions: {
        type: 'transcript',
        mediaId: 'media-a',
        enabled: true,
        updatedAt: 1,
        cues: [
          { id: '1', startSeconds: 0, endSeconds: 2, text: 'Shown' },
          { id: '2', startSeconds: 20, endSeconds: 22, text: 'Trimmed away' },
        ],
      },
    }
    expect(existingLineCount([trimmed, lines('s', 'a', 0, 'Placed')], trimmed, fps)).toBe(2)
  })

  it('adds lines to an empty clip and leaves other clips alone', async () => {
    const other = lines('other', 'b', 400, 'On another clip')
    seed([clip('a', 0), clip('b', 400), other])
    await resumeWith(job('a'), done(1, 3))
    const added = subtitles().find((item) => item.id !== 'other')
    expect(added?.source).toMatchObject({ type: 'transcript', clipId: 'a' })
    expect(added?.cues.map((cue) => cue.text)).toEqual(['From the Cloud'])
    expect(subtitles().find((item) => item.id === 'other')?.cues[0]?.text).toBe('On another clip')
    expect(toasts.toast.success).toHaveBeenCalledOnce()
    expect(forget).toHaveBeenCalledExactlyOnceWith('job-1')
  })

  it('keeps the lines on the words when the clip moved during the job', async () => {
    seed([clip('a', 300)])
    await resumeWith(job('a'), done(1, 3))
    expect(subtitles()[0]?.from).toBe(330)
  })

  it('asks before replacing lines the clip already has, and only that clip changes', async () => {
    const mine = lines('mine', 'a', 0, 'I edited this')
    const other = lines('other', 'b', 400, 'On another clip')
    seed([clip('a', 0), clip('b', 400), mine, other])
    await resumeWith(job('a'), done(1, 3))
    expect(subtitles().map((item) => item.id).toSorted()).toEqual(['mine', 'other'])
    expect(toasts.toast).toHaveBeenCalledOnce()
    // A reload before the person answers still brings the choice back.
    expect(forget).not.toHaveBeenCalled()
    const options = toasts.toast.mock.calls[0]![1] as { action: { onClick: () => void } }
    options.action.onClick()
    await vi.waitFor(() => expect(toasts.toast.success).toHaveBeenCalledOnce())
    expect(forget).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(subtitles().some((item) => item.id === 'mine')).toBe(false)
    expect(subtitles().find((item) => item.id === 'other')?.cues[0]?.text).toBe('On another clip')
    expect(subtitles().find((item) => item.id !== 'other')?.cues[0]?.text).toBe('From the Cloud')
  })

  it('forgets the job when the person keeps their own lines', async () => {
    seed([clip('a', 0), lines('mine', 'a', 0, 'I edited this')])
    await resumeWith(job('a'), done(1, 3))
    const options = toasts.toast.mock.calls[0]![1] as { cancel: { onClick: () => void } }
    options.cancel.onClick()
    expect(forget).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(subtitles().map((item) => item.id)).toEqual(['mine'])
  })

  it('says so when the clip is gone, and when the job fails', async () => {
    seed([])
    await resumeWith(job('a'), done(1, 3))
    expect(toasts.toast.error).toHaveBeenCalledOnce()
    vi.clearAllMocks()
    seed([clip('a', 0)])
    await resumeWith(job('a'), { status: 'failed', error: 'no', cues: [], anchor: null })
    expect(toasts.toast.error).toHaveBeenCalledOnce()
    expect(subtitles()).toEqual([])
  })

  it('waits for the timeline before reading a resumed job, so its clip is there', async () => {
    seed([])
    let loaded!: (ready: boolean) => void
    const read = vi.fn(() => Promise.resolve(done(1, 3)))
    const flow = createCloudCaptions(
      {
        start: vi.fn(),
        read,
        pending: () => Promise.resolve([job('a')]),
        forget,
        ready: () => new Promise((resolve) => (loaded = resolve)),
      },
      1,
    )
    const resumed = flow.resume()
    await vi.waitFor(() => expect(loaded).toBeDefined())
    expect(read).not.toHaveBeenCalled()
    seed([clip('a', 0)])
    loaded(true)
    // Its second wait, before adding the lines, sees the same load.
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    loaded(true)
    await resumed
    expect(subtitles()[0]?.cues[0]?.text).toBe('From the Cloud')
    expect(toasts.toast.error).not.toHaveBeenCalled()
  })

  it('leaves a resumed job alone when the editor closes before the timeline loads', async () => {
    seed([])
    const read = vi.fn()
    await createCloudCaptions(
      {
        start: vi.fn(),
        read,
        pending: () => Promise.resolve([job('a')]),
        forget,
        ready: () => Promise.resolve(false),
      },
      1,
    ).resume()
    expect(read).not.toHaveBeenCalled()
  })

  it('stays quiet about a job the person cancelled', async () => {
    seed([clip('a', 0)])
    await resumeWith(job('a'), { status: 'cancelled', error: null, cues: [], anchor: null })
    expect(toasts.toast.error).not.toHaveBeenCalled()
  })

  it('sends auto-detect as auto, and follows nothing when no job was confirmed', async () => {
    seed([clip('a', 0)])
    const start = vi.fn(() => Promise.resolve(null))
    const read = vi.fn()
    await createCloudCaptions(
      { start, read, pending: () => Promise.resolve([]), forget, ready: () => Promise.resolve(true) },
      1,
    ).start({ clipId: 'a', language: '' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'a', language: 'auto' }))
    expect(read).not.toHaveBeenCalled()
  })
})
