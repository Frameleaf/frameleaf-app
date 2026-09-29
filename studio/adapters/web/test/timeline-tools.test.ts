import { describe, expect, it } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import { applyCanonicalCommands, canonicalJson, type CanonicalEnvelope } from '../src/canonical-commands'
import {
  createStudioEngineCommandHandlers,
  createStudioGraphHistory,
} from '@frameleaf/host/engine-commands'
import { createStudioCommandEnvelope, type StudioCommandId } from '@frameleaf/host/commands'

/**
 * FL-94: golden graph edits for the linked timeline tools, source edits, tracks and markers, driven
 * through Freecut's own timeline actions by the canonical command runtime. Every tool is checked on
 * linked audio/video, refused rather than clamped, and undone through the host's graph history.
 */

const ASSET = '0198a1c2-0000-7000-8000-000000000001'
const STILL = '0198a1c2-0000-7000-8000-000000000002'
const ODD = '0198a1c2-0000-7000-8000-000000000003'

const video = (id: string, fps: number, fileName: string): MediaMetadata => ({
  id,
  storageType: 'workspace',
  fileName,
  fileSize: 1,
  mimeType: 'video/mp4',
  duration: 8,
  width: 1920,
  height: 1080,
  fps,
  codec: 'avc1.64002a',
  audioCodec: 'mp4a.40.2',
  bitrate: 1,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
})

const media: MediaMetadata[] = [
  video(ASSET, 30, 'surf.mp4'),
  {
    id: STILL,
    storageType: 'workspace',
    fileName: 'summit.jpg',
    fileSize: 1,
    mimeType: 'image/jpeg',
    duration: 0,
    width: 4000,
    height: 3000,
    fps: 0,
    codec: 'unknown',
    bitrate: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
  // A variable-rate phone clip whose average cadence has no exact reading (FL-93).
  video(ODD, 27.3, 'phone.mp4'),
]

const track = (id: string, kind: 'video' | 'audio', order: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  kind,
  height: 60,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
  ...extra,
})

const project = (timeline?: Partial<ProjectTimeline>): Project =>
  ({
    id: 'fl-project',
    name: 'Timeline tools',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 1920, height: 1080, fps: 30 },
    frameleafFuture: { keep: true },
    timeline: {
      tracks: [track('v1', 'video', 0), track('a1', 'audio', 1)],
      items: [],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
      ...timeline,
    } as ProjectTimeline,
  }) as unknown as Project

let sequence = 0
const envelope = (id: string, payload: Record<string, unknown>): CanonicalEnvelope => ({
  id,
  payload,
  revision: 3,
  idempotencyKey: `tools-${++sequence}`,
  issuedAt: 1_758_800_000_000,
})

const seconds = (num: number, den = 1) => ({ num, den })

const applied = async (graph: unknown, envelopes: CanonicalEnvelope[]) => {
  const outcome = await applyCanonicalCommands(graph, envelopes, media)
  if (outcome.status !== 'applied') throw new Error(`${outcome.reason}: ${outcome.detail}`)
  return outcome.project
}

/** The batch is refused as `reason`, and the input graph is left exactly as it was. */
const refused = async (graph: Project, envelopes: CanonicalEnvelope[], reason: string) => {
  const before = canonicalJson(graph)
  await expect(applyCanonicalCommands(graph, envelopes, media)).resolves.toMatchObject({
    status: 'rejected',
    reason,
  })
  expect(canonicalJson(graph)).toBe(before)
}

const itemsOf = (graph: Project) => (graph.timeline?.items ?? []) as unknown as TimelineItem[]
const onTrack = (graph: Project, trackId: string) =>
  itemsOf(graph)
    .filter((item) => item.trackId === trackId)
    .sort((a, b) => a.from - b.from)
const spans = (graph: Project, trackId: string) =>
  onTrack(graph, trackId).map((item) => [item.from, item.durationInFrames, item.sourceStart, item.sourceEnd])

/** One 8-second clip with sound at 0, cut into four linked 2-second parts. */
const fourParts = async () => {
  let graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
  for (const at of [2, 4, 6]) {
    graph = await applied(graph, [envelope('clip.split', { at: seconds(at) })])
  }
  return graph
}

/** Two linked clips that touch at 4 s: A = source 0–4 s, B = source 1–8 s. */
const touchingPair = async () => {
  const one = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
  const a = onTrack(one, 'v1')[0]!
  const trimmed = await applied(one, [envelope('clip.trimEnd', { clipId: a.id, end: seconds(4) })])
  const two = await applied(trimmed, [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(4) })])
  const b = onTrack(two, 'v1')[1]!
  const bTrimmed = await applied(two, [envelope('clip.trimStart', { clipId: b.id, start: seconds(5) })])
  return {
    graph: await applied(bTrimmed, [envelope('clip.move', { clipId: b.id, start: seconds(4) })]),
    a: a.id,
    b: b.id,
  }
}

describe('FL-94 linked timeline tools on the Freecut engine', () => {
  it('rolls the cut between linked clips without changing the sequence length', async () => {
    const { graph, a, b } = await touchingPair()
    expect(spans(graph, 'v1')).toEqual([
      [0, 120, 0, 120],
      [120, 210, 30, 240],
    ])
    const rolled = await applied(graph, [envelope('clip.roll', { clipId: a, at: seconds(5) })])
    const expected = [
      [0, 150, 0, 150],
      [150, 180, 60, 240],
    ]
    expect(spans(rolled, 'v1')).toEqual(expected)
    // The linked sound rolls with its pictures.
    expect(spans(rolled, 'a1')).toEqual(expected)
    expect(onTrack(rolled, 'v1').map((item) => item.id)).toEqual([a, b])

    // B has one second of head media: rolling the cut further left than that is refused, not clamped.
    await refused(graph, [envelope('clip.roll', { clipId: a, at: seconds(2) })], 'failed')
    await refused(graph, [envelope('clip.roll', { clipId: a, at: seconds(12) })], 'invalid')
    await refused(graph, [envelope('clip.roll', { clipId: b, at: seconds(9) })], 'invalid')
  })

  it('slips the source window of a clip and its linked sound', async () => {
    const { graph, a } = await touchingPair()
    const slipped = await applied(graph, [envelope('clip.slip', { clipId: a, delta: seconds(1) })])
    expect(spans(slipped, 'v1')[0]).toEqual([0, 120, 30, 150])
    expect(spans(slipped, 'a1')[0]).toEqual([0, 120, 30, 150])
    const back = await applied(slipped, [envelope('clip.slip', { clipId: a, delta: seconds(-1, 2) })])
    expect(spans(back, 'v1')[0]).toEqual([0, 120, 15, 135])
    // Five seconds later runs past the end of the 8-second source.
    await refused(graph, [envelope('clip.slip', { clipId: a, delta: seconds(5) })], 'failed')
    await refused(graph, [envelope('clip.slip', { clipId: a, delta: seconds(-1) })], 'failed')
  })

  it('slides a clip between its neighbours, trimming them instead of rippling', async () => {
    const graph = await fourParts()
    const second = onTrack(graph, 'v1')[1]!
    const slid = await applied(graph, [envelope('clip.slide', { clipId: second.id, delta: seconds(1, 3) })])
    // Split parts of one source stay continuous: the slid part's source window moves with it.
    const expected = [
      [0, 70, 0, 70],
      [70, 60, 70, 130],
      [130, 50, 130, 180],
      [180, 60, 180, 240],
    ]
    expect(spans(slid, 'v1')).toEqual(expected)
    expect(spans(slid, 'a1')).toEqual(expected)
    // The first part has no media before its start; sliding the second part left past it is refused.
    const first = onTrack(graph, 'v1')[0]!
    await refused(graph, [envelope('clip.slide', { clipId: first.id, delta: seconds(-1) })], 'failed')
  })

  it('rate-stretches a clip and its linked sound to an exact speed, rippling later clips', async () => {
    const { graph, a, b } = await touchingPair()
    const doubled = await applied(graph, [envelope('clip.setSpeed', { clipId: a, speed: { num: 2, den: 1 } })])
    expect(onTrack(doubled, 'v1').map((item) => [item.id, item.from, item.durationInFrames])).toEqual([
      [a, 0, 60],
      [b, 60, 210],
    ])
    expect(onTrack(doubled, 'a1').map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 60],
      [60, 210],
    ])
    expect(onTrack(doubled, 'v1')[0]!.speed).toBe(2)
    // One third: 120 source frames become 360 timeline frames exactly.
    const third = await applied(graph, [envelope('clip.setSpeed', { clipId: a, speed: { num: 1, den: 3 } })])
    expect(onTrack(third, 'v1').map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 360],
      [360, 210],
    ])
    await refused(graph, [envelope('clip.setSpeed', { clipId: a, speed: { num: 20, den: 1 } })], 'invalid')
    await refused(graph, [envelope('clip.setSpeed', { clipId: a, speed: { num: 1, den: 20 } })], 'invalid')
    await refused(graph, [envelope('clip.setSpeed', { clipId: a, speed: { num: -1, den: 2 } })], 'invalid')
  })

  it('unlinks and relinks audio and video', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const [picture] = onTrack(graph, 'v1')
    const [sound] = onTrack(graph, 'a1')
    const unlinked = await applied(graph, [envelope('clip.setLink', { clipIds: [picture!.id], linked: false })])
    const loose = itemsOf(unlinked)
    expect(loose.find((item) => item.id === picture!.id)?.linkedGroupId).not.toBe(
      loose.find((item) => item.id === sound!.id)?.linkedGroupId,
    )
    // A move now leaves the sound where it was.
    const moved = await applied(unlinked, [envelope('clip.move', { clipId: picture!.id, start: seconds(1) })])
    expect(onTrack(moved, 'a1')[0]!.from).toBe(0)
    const relinked = await applied(unlinked, [
      envelope('clip.setLink', { clipIds: [picture!.id, sound!.id], linked: true }),
    ])
    const again = itemsOf(relinked)
    expect(again.find((item) => item.id === picture!.id)?.linkedGroupId).toBeTruthy()
    expect(again.find((item) => item.id === picture!.id)?.linkedGroupId).toBe(
      again.find((item) => item.id === sound!.id)?.linkedGroupId,
    )
    await refused(graph, [envelope('clip.setLink', { clipIds: [picture!.id], linked: true })], 'invalid')
  })

  it('reorders clips on a track, re-flowing contiguously with linked sound following', async () => {
    const graph = await fourParts()
    const parts = onTrack(graph, 'v1')
    const reordered = await applied(graph, [
      envelope('clip.reorder', { trackId: 'v1', clipId: parts[3]!.id, index: 0 }),
    ])
    expect(spans(reordered, 'v1')).toEqual([
      [0, 60, 180, 240],
      [60, 60, 0, 60],
      [120, 60, 60, 120],
      [180, 60, 120, 180],
    ])
    expect(spans(reordered, 'a1')).toEqual(spans(reordered, 'v1'))
    await refused(graph, [envelope('clip.reorder', { trackId: 'v1', clipId: parts[0]!.id, index: 4 })], 'invalid')
  })

  it('inserts a marked source range, rippling destination and sync-locked tracks', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const inserted = await applied(graph, [
      envelope('clip.insert', {
        trackId: 'v1',
        assetId: ASSET,
        at: seconds(2),
        sourceIn: seconds(1),
        sourceOut: seconds(3),
      }),
    ])
    const expected = [
      [0, 60, 0, 60],
      [60, 60, 30, 90],
      [120, 180, 60, 240],
    ]
    expect(spans(inserted, 'v1')).toEqual(expected)
    expect(spans(inserted, 'a1')).toEqual(expected)
    // The cut halves stay linked pairwise, and the inserted clip is its own linked pair.
    const groups = (trackId: string) => onTrack(inserted, trackId).map((item) => item.linkedGroupId)
    expect(groups('v1')).toEqual(groups('a1'))
    expect(new Set(groups('v1')).size).toBe(3)

    // A still has no sound: only V1 is a destination, and A1 follows because it is sync-locked.
    const still = await applied(graph, [
      envelope('clip.insert', { trackId: 'v1', assetId: STILL, at: seconds(2), sourceIn: seconds(0), sourceOut: seconds(1) }),
    ])
    expect(spans(still, 'v1').map(([from, duration]) => [from, duration])).toEqual([
      [0, 60],
      [60, 30],
      [90, 180],
    ])
    expect(spans(still, 'a1').map(([from, duration]) => [from, duration])).toEqual([
      [0, 60],
      [90, 180],
    ])
  })

  it('keeps linked sound in sync on an insert even when its track has sync lock off', async () => {
    const graph = await applied(
      project({ tracks: [track('v1', 'video', 0), track('a1', 'audio', 1, { syncLock: false })] as never }),
      [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })],
    )
    const inserted = await applied(graph, [
      envelope('clip.insert', { trackId: 'v1', assetId: STILL, at: seconds(2), sourceIn: seconds(0), sourceOut: seconds(1) }),
    ])
    expect(spans(inserted, 'a1').map(([from, duration]) => [from, duration])).toEqual([
      [0, 60],
      [90, 180],
    ])
  })

  it('overwrites a marked range on the destination tracks only, keeping the rest', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const overwritten = await applied(graph, [
      envelope('clip.overwrite', {
        trackId: 'v1',
        assetId: ASSET,
        at: seconds(2),
        sourceIn: seconds(5),
        sourceOut: seconds(6),
      }),
    ])
    const expected = [
      [0, 60, 0, 60],
      [60, 30, 150, 180],
      [90, 150, 90, 240],
    ]
    expect(spans(overwritten, 'v1')).toEqual(expected)
    expect(spans(overwritten, 'a1')).toEqual(expected)
    // Sequence length is unchanged by an overwrite.
    const end = (graph: Project) => Math.max(...itemsOf(graph).map((item) => item.from + item.durationInFrames))
    expect(end(overwritten)).toBe(end(graph))
  })

  it('refuses source edits on locked tracks, past the source and on inexact source cadences', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const edit = { trackId: 'v1', assetId: ASSET, at: seconds(2), sourceIn: seconds(1), sourceOut: seconds(3) }
    const locked = structuredClone(graph)
    locked.timeline!.tracks[0]!.locked = true
    await refused(locked, [envelope('clip.insert', edit)], 'failed')
    await refused(locked, [envelope('clip.overwrite', edit)], 'failed')
    await refused(graph, [envelope('clip.insert', { ...edit, sourceOut: seconds(9) })], 'invalid')
    await refused(graph, [envelope('clip.insert', { ...edit, sourceIn: seconds(3), sourceOut: seconds(3) })], 'invalid')
    await refused(graph, [envelope('clip.overwrite', { ...edit, assetId: ODD })], 'invalid')
    await refused(graph, [envelope('clip.insert', { ...edit, trackId: 'a1' })], 'invalid')
  })

  it('sets track mute, lock, solo, visibility, sync lock and gain, and they survive save and reopen', async () => {
    const graph = await applied(project(), [
      envelope('track.set', {
        trackId: 'v1',
        patch: { name: 'Pictures', locked: true, visible: false, syncLock: false },
      }),
      envelope('track.set', { trackId: 'a1', patch: { muted: true, solo: true, gain: -6.5 } }),
    ])
    const expectTracks = (saved: Project) =>
      expect(saved.timeline?.tracks).toEqual([
        expect.objectContaining({ id: 'v1', name: 'Pictures', locked: true, visible: false, syncLock: false }),
        expect.objectContaining({ id: 'a1', muted: true, solo: true, volume: -6.5 }),
      ])
    expectTracks(graph)
    // Reopening the stored graph (a no-op batch hydrates and serialises it again) keeps every flag.
    expectTracks(await applied(structuredClone(graph), [envelope('marker.add', { at: seconds(0) })]))
    expect((graph as unknown as { frameleafFuture: unknown }).frameleafFuture).toEqual({ keep: true })

    await refused(graph, [envelope('track.set', { trackId: 'a1', patch: { gain: 20 } })], 'invalid')
    await refused(graph, [envelope('track.set', { trackId: 'a1', patch: { colour: '#fff' } })], 'invalid')
    await refused(graph, [envelope('track.set', { trackId: 'a1', patch: { muted: 'yes' } })], 'invalid')
    // A locked track refuses edits that would change its clips.
    const withClip = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const lockedClip = onTrack(withClip, 'v1')[0]!
    const lockedGraph = await applied(withClip, [envelope('track.set', { trackId: 'v1', patch: { locked: true } })])
    for (const [id, payload] of [
      ['clip.setSpeed', { clipId: lockedClip.id, speed: { num: 2, den: 1 } }],
      ['clip.slip', { clipId: lockedClip.id, delta: seconds(1) }],
      ['clip.reorder', { trackId: 'v1', clipId: lockedClip.id, index: 0 }],
      ['track.remove', { trackId: 'v1' }],
    ] as const) {
      await refused(lockedGraph, [envelope(id, payload)], 'failed')
    }
  })

  it('removes and reorders tracks', async () => {
    const graph = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(2) }),
      envelope('track.add', { kind: 'video', name: 'V2', index: 0 }),
    ])
    const v2 = graph.timeline!.tracks.find((candidate) => !['v1', 'a1'].includes(candidate.id))!
    // Freecut re-derives classic V#/A# names from position, so tracks are followed by id.
    const order = (saved: Project) =>
      [...saved.timeline!.tracks].sort((a, b) => a.order - b.order).map((candidate) => candidate.id)
    expect(order(graph)).toEqual([v2.id, 'v1', 'a1'])
    const reordered = await applied(graph, [envelope('track.reorder', { trackId: v2.id, index: 1 })])
    expect(order(reordered)).toEqual(['v1', v2.id, 'a1'])
    const removed = await applied(reordered, [envelope('track.remove', { trackId: 'v1' })])
    expect(order(removed)).toEqual([v2.id, 'a1'])
    expect(itemsOf(removed)).toEqual([])
    await refused(graph, [envelope('track.reorder', { trackId: v2.id, index: 3 })], 'invalid')
    const single = await applied(project({ tracks: [track('v1', 'video', 0)] as never }), [
      envelope('marker.add', { at: seconds(0) }),
    ])
    await refused(single, [envelope('track.remove', { trackId: 'v1' })], 'invalid')
  })

  it('adds, updates and removes markers on the exact cadence', async () => {
    const ntsc = project()
    ntsc.metadata = { ...ntsc.metadata, fps: 30_000 / 1001 }
    const marked = await applied(ntsc, [
      envelope('marker.add', { at: seconds(1001 * 45, 30_000), name: 'Drop', colour: '#ff8800' }),
    ])
    const markers = () => (marked.timeline as unknown as { markers: Array<Record<string, unknown>> }).markers
    expect(markers()).toEqual([expect.objectContaining({ frame: 45, label: 'Drop', color: '#ff8800' })])
    const id = markers()[0]!.id as string
    const updated = await applied(marked, [
      envelope('marker.update', { markerId: id, patch: { name: 'Chorus', at: seconds(1001 * 90, 30_000) } }),
    ])
    expect((updated.timeline as unknown as { markers: unknown[] }).markers).toEqual([
      expect.objectContaining({ id, frame: 90, label: 'Chorus', color: '#ff8800' }),
    ])
    const removed = await applied(updated, [envelope('marker.remove', { markerId: id })])
    expect((removed.timeline as unknown as { markers?: unknown[] }).markers ?? []).toEqual([])
    await refused(marked, [envelope('marker.remove', { markerId: 'missing' })], 'invalid')
    await refused(marked, [envelope('marker.add', { at: seconds(0), colour: 'orange' })], 'invalid')
  })

  it('undoes and redoes every tool through the host graph history', async () => {
    const { graph: start, a } = await touchingPair()
    const parts = await fourParts()
    let graph: unknown = start
    const history = createStudioGraphHistory()
    const handlers = createStudioEngineCommandHandlers({
      graph: () => graph,
      revision: () => 3,
      assets: () => [],
      restore: async () => false,
      history,
      stage: (next) => {
        graph = next
      },
      engine: async () => ({
        dispose() {},
        async apply(current, envelopes) {
          const outcome = await applyCanonicalCommands(current, envelopes, media)
          return outcome.status === 'applied'
            ? { status: 'applied', graph: outcome.project, digest: outcome.digest }
            : outcome
        },
      }),
    })
    const run = (id: StudioCommandId, payload: Record<string, unknown>) =>
      handlers[id]!(createStudioCommandEnvelope(id as never, payload as never, 3))
    const cases: Array<[Project, StudioCommandId, Record<string, unknown>]> = [
      [start, 'clip.roll', { clipId: a, at: seconds(5) }],
      [start, 'clip.slip', { clipId: a, delta: seconds(1) }],
      [parts, 'clip.slide', { clipId: onTrack(parts, 'v1')[1]!.id, delta: seconds(1, 3) }],
      [start, 'clip.setSpeed', { clipId: a, speed: { num: 2, den: 1 } }],
      [start, 'clip.setLink', { clipIds: [a], linked: false }],
      [parts, 'clip.reorder', { trackId: 'v1', clipId: onTrack(parts, 'v1')[3]!.id, index: 0 }],
      [start, 'clip.insert', { trackId: 'v1', assetId: ASSET, at: seconds(2), sourceIn: seconds(0), sourceOut: seconds(1) }],
      [start, 'clip.overwrite', { trackId: 'v1', assetId: ASSET, at: seconds(2), sourceIn: seconds(0), sourceOut: seconds(1) }],
      [start, 'track.set', { trackId: 'a1', patch: { muted: true } }],
      [start, 'track.reorder', { trackId: 'a1', index: 0 }],
      [start, 'marker.add', { at: seconds(1) }],
    ]
    for (const [initial, id, payload] of cases) {
      graph = initial
      history.clear()
      const before = canonicalJson(graph)
      await run(id, payload)
      const after = canonicalJson(graph)
      expect(after, id).not.toBe(before)
      await run('history.undo', {})
      expect(canonicalJson(graph), `${id} undo`).toBe(before)
      await run('history.redo', {})
      expect(canonicalJson(graph), `${id} redo`).toBe(after)
    }
  })
})
