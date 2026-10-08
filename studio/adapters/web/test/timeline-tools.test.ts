import { describe, expect, it } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem, TextItem } from '@/types/timeline'
import { useEditorStore } from '@/shared/state/editor'
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

/** A leading picture gap with deliberately offset linked sound and an attached caption. */
const linkedGap = async () => {
  const graph = await applied(project(), [
    envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(2) }),
  ])
  const picture = onTrack(graph, 'v1')[0]!
  const sound = onTrack(graph, 'a1')[0]!
  sound.from = 90
  graph.timeline!.tracks.push(track('captions', 'video', 2))
  const caption: TextItem = {
    id: 'attached-caption', trackId: 'captions', from: 70, durationInFrames: 20,
    label: 'Caption', type: 'text', text: 'Keep this caption', color: '#ffffff',
    textRole: 'caption', captionSource: { type: 'transcript', clipId: picture.id, mediaId: ASSET },
  }
  // These unrelated items touch the shifted companions exactly, but do not move with them.
  graph.timeline!.items.push(
    { ...sound, id: 'unrelated-sound', linkedGroupId: undefined, originId: undefined,
      from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30 },
    caption,
    { ...caption, id: 'unrelated-caption', from: 0, durationInFrames: 10,
      captionSource: undefined, textRole: undefined, text: 'Keep this title' },
  )
  return { graph: await applied(graph, []), moving: [picture.id, sound.id, caption.id] }
}

/** An interior one-second gap; unrelated sync-locked music occupies the removed interval. */
const singleLinkedGap = async (syncLock: boolean) => {
  const { graph: start, b } = await touchingPair()
  const graph = await applied(start, [envelope('clip.push', { clipId: b, delta: seconds(1) })])
  const picture = onTrack(graph, 'v1')[1]!
  const sound = onTrack(graph, 'a1')[1]!
  graph.timeline!.tracks.find((candidate) => candidate.id === 'a1')!.syncLock = syncLock
  graph.timeline!.tracks.push(track('captions', 'video', 2, { syncLock }), track('music', 'audio', 3))
  const caption: TextItem = {
    id: 'single-gap-caption', trackId: 'captions', from: 160, durationInFrames: 10,
    label: 'Caption', type: 'text', text: 'Keep the words', color: '#ffffff',
    textRole: 'caption', captionSource: { type: 'transcript', clipId: picture.id, mediaId: ASSET },
  }
  graph.timeline!.items.push(caption, {
    ...sound, id: 'interval-music', trackId: 'music', linkedGroupId: undefined, originId: undefined,
    from: 135, durationInFrames: 5, sourceStart: 0, sourceEnd: 5,
  })
  return { graph: await applied(graph, []), moving: [picture.id, sound.id, caption.id] }
}

describe('FL-94 linked timeline tools on the Freecut engine', () => {
  it.each([true, false])('closes one gap with linked sound/captions exactly once (sync lock %s)', async (syncLock) => {
    const { graph, moving } = await singleLinkedGap(syncLock)
    const expected = structuredClone(graph)
    expected.timeline!.items = expected.timeline!.items.filter((item) => item.id !== 'interval-music')
    for (const item of itemsOf(expected)) if (moving.includes(item.id)) item.from -= 30
    const before = canonicalJson(graph)
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: false })
    try {
      const closed = await applied(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(9, 2) })])
      // Includes exact linked positions/source windows and the engine's unrelated sync-lock removal.
      expect(canonicalJson(closed)).toBe(canonicalJson(expected))
      expect(canonicalJson(graph)).toBe(before)
      expect(useEditorStore.getState().linkedSelectionEnabled).toBe(false)
      expect(canonicalJson(await applied(structuredClone(closed), []))).toBe(canonicalJson(closed))
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it.each(['a1', 'captions'])('refuses a single-gap edit with locked linked track %s', async (id) => {
    const { graph } = await singleLinkedGap(false)
    graph.timeline!.tracks.find((candidate) => candidate.id === id)!.locked = true
    await refused(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(9, 2) })], 'failed')
  })

  it.each(['audio', 'text'])('refuses negative single-gap positions for linked %s before clamping', async (type) => {
    const { graph, moving } = await singleLinkedGap(false)
    const companion = itemsOf(graph).find((item) => moving.includes(item.id) && item.type === type)!
    if (type === 'audio') {
      // Keep the offset sound clear of the first clip so load-time overlap repair cannot move it.
      graph.timeline!.tracks.push({
        ...graph.timeline!.tracks.find((candidate) => candidate.id === 'a1')!,
        id: 'negative-audio', name: 'Offset sound', order: 4, syncLock: false,
      })
      companion.trackId = 'negative-audio'
    }
    companion.from = 20
    const before = canonicalJson(graph)
    expect(canonicalJson(await applied(graph, []))).toBe(before)
    const outcome = await applyCanonicalCommands(graph, [
      envelope('track.closeGap', { trackId: 'v1', at: seconds(9, 2) }),
    ], media)
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'failed', detail: expect.stringContaining('before the timeline') })
    expect(outcome).not.toHaveProperty('project')
    expect(canonicalJson(graph)).toBe(before)
  })

  it.each(['audio', 'text'])('refuses a one-frame single-gap collision on linked %s tracks', async (type) => {
    const { graph, moving } = await singleLinkedGap(false)
    const companion = itemsOf(graph).find((item) => moving.includes(item.id) && item.type === type)!
    // An unrelated item ends one frame after the companion's intended start.
    const duration = companion.from - 30 - 120 + 1
    graph.timeline!.items.push({
      ...companion, id: 'single-gap-obstacle', from: 120, durationInFrames: duration,
      linkedGroupId: undefined, originId: undefined,
      ...(companion.type === 'text'
        ? { captionSource: undefined, textRole: undefined }
        : { sourceEnd: (companion.sourceStart ?? 0) + duration }),
    })
    await refused(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(9, 2) })], 'failed')
  })

  it.each(['audio', 'text'])('atomically refuses sync-lock splitting/removal of linked %s source data', async (type) => {
    const { graph, moving } = await singleLinkedGap(true)
    const companion = itemsOf(graph).find((item) => moving.includes(item.id) && item.type === type)!
    companion.from = 135 // The linked audio is split; the short caption is wholly removed.
    const before = canonicalJson(graph)
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: false })
    try {
      const outcome = await applyCanonicalCommands(graph, [
        envelope('marker.add', { at: seconds(1) }),
        envelope('track.closeGap', { trackId: 'v1', at: seconds(9, 2) }),
      ], media)
      expect(outcome).toMatchObject({ status: 'rejected', index: 1, reason: 'failed',
        detail: expect.stringContaining('linked source window') })
      expect(outcome).not.toHaveProperty('project')
      expect(canonicalJson(graph)).toBe(before)
      expect(useEditorStore.getState().linkedSelectionEnabled).toBe(false)
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it.each([true, false])('closes all picture gaps with linked sound/captions, preserving the full graph (selection %s)', async (linked) => {
    const { graph, moving } = await linkedGap()
    const expected = structuredClone(graph)
    for (const item of itemsOf(expected)) if (moving.includes(item.id)) item.from -= 60
    const before = canonicalJson(graph)
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: linked })
    try {
      const closed = await applied(graph, [envelope('track.closeGap', { trackId: 'v1' })])
      expect(canonicalJson(closed)).toBe(canonicalJson(expected))
      expect(canonicalJson(graph)).toBe(before)
      expect(useEditorStore.getState().linkedSelectionEnabled).toBe(linked)
      // Rehydrating the accepted graph keeps source windows, links, track flags and unknown fields.
      expect(canonicalJson(await applied(structuredClone(closed), []))).toBe(canonicalJson(closed))
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it.each(['unrelated-sound', 'unrelated-caption'])('atomically refuses a one-frame companion collision with %s', async (id) => {
    const { graph } = await linkedGap()
    const obstacle = itemsOf(graph).find((item) => item.id === id)!
    obstacle.durationInFrames += 1
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: false })
    try {
      const before = canonicalJson(graph)
      const outcome = await applyCanonicalCommands(graph, [
        envelope('marker.add', { at: seconds(1) }),
        envelope('track.closeGap', { trackId: 'v1' }),
      ], media)
      expect(outcome).toMatchObject({ status: 'rejected', index: 1, reason: 'failed' })
      expect(outcome).not.toHaveProperty('project')
      expect(canonicalJson(graph)).toBe(before)
      expect(useEditorStore.getState().linkedSelectionEnabled).toBe(false)
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it.each(['audio', 'text'])('refuses an offset linked %s moving before frame zero', async (type) => {
    const { graph, moving } = await linkedGap()
    const companion = itemsOf(graph).find((item) => moving.includes(item.id) && item.type === type)!
    companion.from = 30
    // No obstacle: clamping to frame zero would otherwise look collision-free but lose the offset.
    graph.timeline!.items = graph.timeline!.items.filter((item) =>
      item.id !== (type === 'audio' ? 'unrelated-sound' : 'unrelated-caption'))
    const before = canonicalJson(graph)
    const outcome = await applyCanonicalCommands(graph, [envelope('track.closeGap', { trackId: 'v1' })], media)
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'failed', detail: expect.stringContaining('before the timeline') })
    expect(outcome).not.toHaveProperty('project')
    expect(canonicalJson(graph)).toBe(before)
  })

  it.each(['a1', 'captions'])('refuses closing gaps with a locked companion track %s', async (id) => {
    const { graph } = await linkedGap()
    graph.timeline!.tracks.find((candidate) => candidate.id === id)!.locked = true
    await refused(graph, [envelope('track.closeGap', { trackId: 'v1' })], 'failed')
  })

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

  it('joins contiguous parts of one source back together with their linked sound', async () => {
    const graph = await fourParts()
    const parts = onTrack(graph, 'v1')
    const joined = await applied(graph, [envelope('clip.join', { clipIds: parts.map((part) => part.id).reverse() })])
    expect(spans(joined, 'v1')).toEqual([[0, 240, 0, 240]])
    expect(spans(joined, 'a1')).toEqual([[0, 240, 0, 240]])
    expect(onTrack(joined, 'v1')[0]!.id).toBe(parts[0]!.id)
    expect(onTrack(joined, 'v1')[0]!.linkedGroupId).toBe(onTrack(joined, 'a1')[0]!.linkedGroupId)
    // Parts that do not touch, or whose sources no longer continue, are not one clip.
    await refused(graph, [envelope('clip.join', { clipIds: [parts[0]!.id, parts[2]!.id] })], 'invalid')
    const slipped = await applied(graph, [envelope('clip.slip', { clipId: parts[1]!.id, delta: seconds(1, 3) })])
    await refused(slipped, [envelope('clip.join', { clipIds: [parts[0]!.id, parts[1]!.id] })], 'invalid')
    await refused(graph, [envelope('clip.join', { clipIds: [parts[0]!.id] })], 'invalid')
  })

  it.each(['ambiguous', 'locked'])('refuses %s legacy counterpart chains without graph mutation', async (failure) => {
    const graph = await fourParts()
    graph.timeline!.items = graph.timeline!.items!.map((item) => ({ ...item, linkedGroupId: undefined, originId: 'legacy-source' }))
    if (failure === 'ambiguous') {
      graph.timeline!.tracks.push(track('a2', 'audio', 2))
      graph.timeline!.items!.push({ ...onTrack(graph, 'a1')[0]!, id: 'legacy-extra-audio', trackId: 'a2' })
    } else graph.timeline!.tracks.find((candidate) => candidate.id === 'a1')!.locked = true
    await refused(graph, [envelope('clip.join', { clipIds: onTrack(graph, 'v1').map((item) => item.id).reverse() })], 'failed')
  })

  it.each([3, 4])('joins %i legacy A/V parts without explicit linked groups through the shared action', async (count) => {
    const graph = await fourParts()
    graph.timeline!.items = graph.timeline!.items!.filter((item) => item.from < count * 60).map((item) => ({ ...item, linkedGroupId: undefined, originId: 'legacy-source' }))
    const parts = onTrack(graph, 'v1')
    const joined = await applied(graph, [envelope('clip.join', { clipIds: parts.map((item) => item.id).reverse() })])
    expect(spans(joined, 'v1')).toEqual([[0, count * 60, 0, count * 60]])
    expect(spans(joined, 'a1')).toEqual([[0, count * 60, 0, count * 60]])
  })

  it('pushes and pulls everything from a clip onward on every track', async () => {
    const { graph, a, b } = await touchingPair()
    const pushed = await applied(graph, [envelope('clip.push', { clipId: b, delta: seconds(1) })])
    expect(onTrack(pushed, 'v1').map((item) => [item.id, item.from])).toEqual([
      [a, 0],
      [b, 150],
    ])
    expect(onTrack(pushed, 'a1').map((item) => item.from)).toEqual([0, 150])
    const pulled = await applied(pushed, [envelope('clip.push', { clipId: b, delta: seconds(-1) })])
    expect(canonicalJson(pulled.timeline?.items)).toBe(canonicalJson(graph.timeline?.items))
    // Pulling B into A is refused rather than overlapping or clamping.
    await refused(graph, [envelope('clip.push', { clipId: b, delta: seconds(-1) })], 'failed')
  })

  it('closes one gap or every gap on a track', async () => {
    const graph = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(1), duration: seconds(2) }),
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(5), duration: seconds(2) }),
    ])
    const one = await applied(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(4) })])
    expect(onTrack(one, 'v1').map((item) => [item.from, item.durationInFrames])).toEqual([
      [30, 60],
      [90, 60],
    ])
    const all = await applied(graph, [envelope('track.closeGap', { trackId: 'v1' })])
    expect(onTrack(all, 'v1').map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 60],
      [60, 60],
    ])
    await refused(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(2) })], 'invalid')
    await refused(graph, [envelope('track.closeGap', { trackId: 'v1', at: seconds(9) })], 'invalid')
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
    // Head, replacement and tail must each be an independent linked audio/video pair.
    const groups = (trackId: string) => onTrack(overwritten, trackId).map((item) => item.linkedGroupId)
    expect(groups('v1')).toEqual(groups('a1'))
    expect(groups('v1').every(Boolean)).toBe(true)
    expect(new Set(groups('v1')).size).toBe(3)
    // Sequence length is unchanged by an overwrite.
    const end = (graph: Project) => Math.max(...itemsOf(graph).map((item) => item.from + item.durationInFrames))
    expect(end(overwritten)).toBe(end(graph))
  })

  it('preserves the disjoint overwrite tail when the retained head is deleted with linked selection', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const overwritten = await applied(graph, [envelope('clip.overwrite', {
      trackId: 'v1', assetId: ASSET, at: seconds(2), sourceIn: seconds(5), sourceOut: seconds(6),
    })])
    const head = onTrack(overwritten, 'v1')[0]!
    const deleted = await applied(overwritten, [envelope('clip.delete', { clipId: head.id })])
    console.info('FL94 overwrite-head-delete consequence', JSON.stringify({
      before: { video: spans(overwritten, 'v1'), audio: spans(overwritten, 'a1') },
      after: { video: spans(deleted, 'v1'), audio: spans(deleted, 'a1') },
    }))
    expect(spans(deleted, 'v1')).toEqual([[60, 30, 150, 180], [90, 150, 90, 240]])
    expect(spans(deleted, 'a1')).toEqual([[60, 30, 150, 180], [90, 150, 90, 240]])
  })

  it('does not treat an attached caption as a linked media partition on source insert', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const picture = onTrack(graph, 'v1')[0]!
    graph.timeline!.tracks.push(track('captions', 'video', 2))
    graph.timeline!.items.push({ id: 'early-caption', type: 'text', trackId: 'captions', from: 30,
      durationInFrames: 30, label: 'Caption', text: 'Keep', color: '#ffffff', textRole: 'caption',
      captionSource: { type: 'transcript', clipId: picture.id, mediaId: ASSET } } as never)
    const inserted = await applied(graph, [envelope('clip.insert', {
      trackId: 'v1', assetId: ASSET, at: seconds(4), sourceIn: seconds(0), sourceOut: seconds(1),
    })])
    expect(itemsOf(inserted).find((item) => item.id === 'early-caption')).toMatchObject({ from: 30, durationInFrames: 30 })
  })

  it('refuses fully covered partial linked overwrite groups before publishing an edit', async () => {
    const graph = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    await refused(graph, [envelope('clip.overwrite', {
      trackId: 'v1', assetId: STILL, at: seconds(0), sourceIn: seconds(0), sourceOut: seconds(8),
    })], 'failed')
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
    const legacyParts = structuredClone(parts)
    legacyParts.timeline!.items = legacyParts.timeline!.items!.map((item) => ({ ...item, linkedGroupId: undefined, originId: 'legacy-source' }))
    const legacyThree = structuredClone(legacyParts)
    legacyThree.timeline!.items = legacyThree.timeline!.items!.filter((item) => item.from < 180)
    const gapped = await applied(start, [
      envelope('clip.push', { clipId: onTrack(start, 'v1')[1]!.id, delta: seconds(1) }),
    ])
    const companions = await linkedGap()
    const singleWithSync = await singleLinkedGap(true)
    const singleWithoutSync = await singleLinkedGap(false)
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
      [parts, 'clip.join', { clipIds: onTrack(parts, 'v1').map((part) => part.id) }],
      [legacyParts, 'clip.join', { clipIds: onTrack(legacyParts, 'v1').map((part) => part.id).reverse() }],
      [legacyThree, 'clip.join', { clipIds: onTrack(legacyThree, 'v1').map((part) => part.id).reverse() }],
      [start, 'clip.push', { clipId: onTrack(start, 'v1')[1]!.id, delta: seconds(1) }],
      [gapped, 'track.closeGap', { trackId: 'v1' }],
      [companions.graph, 'track.closeGap', { trackId: 'v1' }],
      [singleWithSync.graph, 'track.closeGap', { trackId: 'v1', at: seconds(9, 2) }],
      [singleWithoutSync.graph, 'track.closeGap', { trackId: 'v1', at: seconds(9, 2) }],
      [start, 'sequence.setSettings', { sequenceId: 'main', fps: { num: 60, den: 1 }, timing: 'keep-time' }],
      [start, 'project.applyTemplate', { templateId: 'vertical-9-16' }],
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
    // A rejected edit neither publishes a partial graph nor disturbs an existing undo/redo branch.
    const blocked = structuredClone(companions.graph)
    itemsOf(blocked).find((item) => item.id === 'unrelated-sound')!.durationInFrames += 1
    const destructive = structuredClone(singleWithSync.graph)
    itemsOf(destructive).find((item) => item.id === 'single-gap-caption')!.from = 135
    const rejected: Array<[Project, Record<string, unknown>, string]> = [
      [blocked, { trackId: 'v1' }, 'clips would overlap'],
      [destructive, { trackId: 'v1', at: seconds(9, 2) }, 'linked source window'],
    ]
    for (const [initial, payload, detail] of rejected) {
      graph = initial
      history.clear()
      await run('marker.add', { at: seconds(1) })
      const marked = canonicalJson(graph)
      await run('history.undo', {})
      const before = canonicalJson(graph)
      const depth = history.depth
      await expect(run('track.closeGap', payload)).rejects.toThrow(detail)
      expect(canonicalJson(graph)).toBe(before)
      expect(history.depth).toEqual(depth)
      await run('history.redo', {})
      expect(canonicalJson(graph)).toBe(marked)
    }
  })
})

describe('FL-94 sequence settings: nothing on an existing timeline retimes silently', () => {
  const rate = (num: number, den = 1) => ({ num, den })
  const setSettings = (payload: Record<string, unknown>) =>
    envelope('sequence.setSettings', { sequenceId: 'main', ...payload })
  const withClipAndMarker = async (fps = 30) => {
    /** A linked clip from 2 s to 4 s and a marker at 3 s. */
    const base = { ...project(), metadata: { width: 1920, height: 1080, fps } } as Project
    const one = await applied(base, [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(2) })])
    return applied(one, [
      envelope('clip.trimEnd', { clipId: onTrack(one, 'v1')[0]!.id, end: seconds(4) }),
      envelope('marker.add', { at: seconds(3) }),
    ])
  }
  const markersOf = (graph: Project) => (graph.timeline?.markers ?? []).map((marker) => marker.frame)

  it('changes the rate of an empty timeline without asking', async () => {
    const graph = await applied(project(), [setSettings({ fps: rate(60), width: 1280, height: 720 })])
    expect(graph.metadata).toMatchObject({ fps: 60, width: 1280, height: 720, frameRate: { num: 60, den: 1 } })
  })

  it('refuses a rate change on existing content without a timing policy', async () => {
    const graph = await withClipAndMarker()
    await refused(graph, [setSettings({ fps: rate(60) })], 'invalid')
    // A canvas-only change moves no time, so it needs no policy.
    const resized = await applied(graph, [setSettings({ width: 1080, height: 1920 })])
    expect(resized.metadata).toMatchObject({ width: 1080, height: 1920, fps: 30 })
    expect(spans(resized, 'v1')).toEqual(spans(graph, 'v1'))
  })

  it('keep-time keeps every clip, sound and marker at the same second', async () => {
    const graph = await withClipAndMarker()
    expect(spans(graph, 'v1')).toEqual([[60, 60, 0, 60]])
    const next = await applied(graph, [
      setSettings({ fps: rate(60), timing: 'keep-time' }),
      // Later envelopes in the batch read their times on the new rate.
      envelope('marker.add', { at: seconds(5) }),
    ])
    expect(next.metadata).toMatchObject({ fps: 60, frameRate: { num: 60, den: 1 } })
    // Source frames stay in the source's own rate; the picture at each second is unchanged.
    for (const trackId of ['v1', 'a1']) {
      const [clip] = onTrack(next, trackId)
      expect([clip!.from, clip!.durationInFrames, clip!.sourceStart, clip!.sourceEnd]).toEqual([120, 120, 0, 60])
      expect(clip!.sourceFps).toBe(30)
    }
    expect(markersOf(next)).toEqual([180, 300])
  })

  it('keep-frames keeps the frame numbers, as an explicit choice', async () => {
    const graph = await withClipAndMarker()
    const next = await applied(graph, [setSettings({ fps: rate(60), timing: 'keep-frames' })])
    expect(next.metadata.fps).toBe(60)
    expect(spans(next, 'v1')).toEqual(spans(graph, 'v1'))
    expect(markersOf(next)).toEqual(markersOf(graph))
  })

  it('moves to an NTSC rate exactly', async () => {
    const graph = await withClipAndMarker()
    const next = await applied(graph, [setSettings({ fps: rate(30_000, 1001), timing: 'keep-time' })])
    expect(next.metadata).toMatchObject({ fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } })
    // 2 s is 59.94 frames: frame 60. The clip still ends at 4 s: frame 120 (119.88), and reads the
    // same 60 source frames.
    expect(spans(next, 'v1')).toEqual([[60, 60, 0, 60]])
    expect(markersOf(next)).toEqual([90])
  })

  it('applies a template, asking for timing only when its rate differs', async () => {
    const graph = await withClipAndMarker()
    const vertical = await applied(graph, [envelope('project.applyTemplate', { templateId: 'vertical-9-16' })])
    expect(vertical.metadata).toMatchObject({ width: 1080, height: 1920, fps: 30 })
    expect(spans(vertical, 'v1')).toEqual(spans(graph, 'v1'))

    const fast = await withClipAndMarker(60)
    await refused(fast, [envelope('project.applyTemplate', { templateId: 'youtube-1080p' })], 'invalid')
    const kept = await applied(fast, [
      envelope('project.applyTemplate', { templateId: 'youtube-1080p', timing: 'keep-time' }),
    ])
    expect(kept.metadata.fps).toBe(30)
    expect(spans(kept, 'v1')[0]!.slice(0, 2)).toEqual([60, 60])
    await refused(fast, [envelope('project.applyTemplate', { templateId: 'nope' })], 'invalid')
  })

  it('refuses rates, sizes, policies and sequences it cannot honour', async () => {
    const graph = await withClipAndMarker()
    for (const payload of [
      { fps: rate(59, 2) },
      { fps: rate(0) },
      { fps: rate(480) },
      { fps: 30 },
      { fps: rate(48) },
      { fps: rate(48_000, 1001) },
      { width: 100 },
      { height: 100 },
      { fps: rate(60), timing: 'stretch' },
      {},
    ]) {
      await refused(graph, [setSettings(payload)], 'invalid')
    }
    await refused(graph, [envelope('sequence.setSettings', { sequenceId: 'missing', fps: rate(60) })], 'invalid')
    // Freecut's own templates have odd sizes (Twitter/X is 1200x675); the renderer rounds for encoding.
    expect((await applied(graph, [setSettings({ width: 1200, height: 675 })])).metadata).toMatchObject({
      width: 1200,
      height: 675,
    })
  })

  it('retimes a sequence at its own rate and the clips that read it', async () => {
    const inner = {
      id: 'inner-clip',
      type: 'text',
      trackId: 's1',
      from: 30,
      durationInFrames: 30,
      label: 'Title',
      text: 'Title',
      color: '#ffffff',
    }
    const wrapper = {
      id: 'wrapper',
      type: 'composition',
      compositionId: 'seq-2',
      trackId: 'v1',
      from: 0,
      durationInFrames: 60,
      label: 'Sequence 2',
      sourceStart: 30,
      sourceEnd: 90,
    }
    const graph = project({
      items: [wrapper] as never,
      compositions: [
        {
          id: 'seq-2',
          name: 'Sequence 2',
          editorKind: 'sequence',
          items: [inner],
          tracks: [track('s1', 'video', 0)],
          transitions: [],
          keyframes: [],
          fps: 30,
          width: 1920,
          height: 1080,
          durationInFrames: 90,
          markers: [{ id: 'm', frame: 45, color: '#fff' }],
        },
      ] as never,
    })
    await refused(graph, [envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60) })], 'invalid')
    // The wrapper reads the sequence in seconds: keeping its frame numbers would change what it shows.
    await refused(
      graph,
      [envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60), timing: 'keep-frames' })],
      'invalid',
    )
    // An empty sequence still needs a policy while compound clips read it.
    const emptyRead = structuredClone(graph)
    emptyRead.timeline!.compositions![0]!.items = []
    emptyRead.timeline!.compositions![0]!.markers = []
    await refused(emptyRead, [envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60) })], 'invalid')
    expect(
      itemsOf(
        await applied(emptyRead, [
          envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60), timing: 'keep-time' }),
        ]),
      )[0],
    ).toMatchObject({ sourceStart: 60, sourceEnd: 180 })

    const unread = { ...graph, timeline: { ...graph.timeline!, items: [] } } as Project
    const kept = await applied(unread, [
      envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60), timing: 'keep-frames' }),
    ])
    expect(kept.timeline!.compositions![0]).toMatchObject({ fps: 60, durationInFrames: 90 })

    // "main" names the main timeline; a sequence with that id is refused as ambiguous, not guessed.
    const clash = structuredClone(graph)
    clash.timeline!.compositions![0]!.id = 'main'
    ;(clash.timeline!.items![0] as { compositionId: string }).compositionId = 'main'
    await refused(clash, [setSettings({ fps: rate(60), timing: 'keep-time' })], 'invalid')

    // A stored rate with no exact reading is refused as invalid, not failed.
    const odd = structuredClone(graph)
    odd.timeline!.compositions![0]!.fps = 29.5
    await refused(
      odd,
      [envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60), timing: 'keep-time' })],
      'invalid',
    )
    const next = await applied(graph, [
      envelope('sequence.setSettings', { sequenceId: 'seq-2', fps: rate(60), timing: 'keep-time' }),
    ])
    expect(next.metadata.fps).toBe(30)
    const composition = next.timeline!.compositions!.find((entry) => entry.id === 'seq-2')!
    expect(composition).toMatchObject({ fps: 60, durationInFrames: 180 })
    expect(composition.items[0]).toMatchObject({ from: 60, durationInFrames: 60 })
    expect(composition.markers![0]!.frame).toBe(90)
    // The main timeline keeps its own rate; the wrapper reads the same seconds of the sequence.
    expect(itemsOf(next)[0]).toMatchObject({ from: 0, durationInFrames: 60, sourceStart: 60, sourceEnd: 180 })
  })
})
