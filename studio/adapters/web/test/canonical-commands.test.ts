import { describe, expect, it, vi } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TextItem, TimelineItem } from '@/types/timeline'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import {
  applyCanonicalCommands,
  canonicalJson,
  deterministicUuids,
  ENGINE_COMMANDS,
  frameRateOf,
  secondsToFrames,
  type CanonicalEnvelope,
} from '../src/canonical-commands'
import { createStudioEngineCommandHandlers, createStudioGraphHistory, studioEngineCommandIds } from '@frameleaf/host/engine-commands'
import { createStudioBridge } from '@frameleaf/host/bridge'
import { createStudioCommandEnvelope, type StudioCommandEnvelope } from '@frameleaf/host/commands'
import { emptyStudioCapabilities } from '@frameleaf/host/host-contract'
import type { StudioFrameToHostMessage } from '@frameleaf/host/frame-protocol'
import { call, connectToHost } from '../src/host-port'
import manifest from '../../../freecut-feature-manifest.json'
import catalogue from '../../../frameleaf-studio-commands.json'

/**
 * FL-92: canonical commands against the real Freecut timeline actions. These run the engine's own
 * stores under jsdom, exactly as Freecut's headless `editProject` tests do.
 */

const ASSET = '0198a1c2-0000-7000-8000-000000000001'
const STILL = '0198a1c2-0000-7000-8000-000000000002'

const media: MediaMetadata[] = [
  {
    id: ASSET,
    storageType: 'workspace',
    fileName: 'surf.mp4',
    fileSize: 1,
    mimeType: 'video/mp4',
    duration: 8,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'avc1.64002a',
    audioCodec: 'mp4a.40.2',
    bitrate: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
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
]

const project = (timeline?: Partial<ProjectTimeline>): Project =>
  ({
    id: 'fl-project',
    name: 'Canonical',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 1920, height: 1080, fps: 30 },
    // A field Freecut does not know must survive every command untouched.
    frameleafFuture: { keep: [1, null, { nested: true }] },
    timeline: {
      tracks: [
        {
          id: 'v1',
          name: 'V1',
          kind: 'video',
          height: 80,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
        },
        {
          id: 'a1',
          name: 'A1',
          kind: 'audio',
          height: 60,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 1,
        },
      ],
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
const envelope = (
  id: string,
  payload: Record<string, unknown>,
  key = `key-${++sequence}`,
): CanonicalEnvelope => ({
  id,
  payload,
  revision: 3,
  idempotencyKey: key,
  issuedAt: 1_758_800_000_000,
})

const seconds = (num: number, den = 1) => ({ num, den })

const applied = async (graph: unknown, envelopes: CanonicalEnvelope[]) => {
  const outcome = await applyCanonicalCommands(graph, envelopes, media)
  if (outcome.status !== 'applied') throw new Error(`${outcome.reason}: ${outcome.detail}`)
  return outcome
}

const itemsOf = (graph: Project) => graph.timeline?.items ?? []

describe('canonical commands on the Freecut engine (FL-92)', () => {
  it('persists clip gain and exact-second audio fades without changing its timing, automation or linked picture', async () => {
    const start = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }),
      envelope('track.set', { trackId: 'a1', patch: { gain: -4 } }),
      envelope('project.setMasterAudio', { gainDb: -2, muted: true }),
    ])
    const audio = itemsOf(start.project).find((item) => item.type === 'audio')!
    Object.assign(audio, { audioFadeIn: 2, audioFadeOut: 3, audioFadeInCurve: -0.25, audioPitchSemitones: 2 })
    const keyed = await applied(start.project, [envelope('keyframe.add', { clipId: audio.id, property: 'volume', at: seconds(1), value: { value: -3 } })])
    const before = await applied(keyed.project, [])
    const changed = await applied(before.project, [envelope('clip.setAudio', { clipId: audio.id, volume: -6, fadeIn: seconds(1, 100), fadeOut: seconds(3, 2) })])
    expect(itemsOf(changed.project)).toEqual(itemsOf(before.project).map((item) => item.id === audio.id
      ? { ...item, volume: -6, audioFadeIn: 0.01, audioFadeOut: 1.5 }
      : item))
    expect({ ...changed.project.timeline, items: [] }).toEqual({ ...before.project.timeline, items: [] })
    expect((await applied(JSON.parse(JSON.stringify(changed.project)), [])).project).toEqual(changed.project)
    const reset = await applied(changed.project, [envelope('clip.setAudio', { clipId: audio.id, fadeIn: seconds(0), fadeOut: seconds(0) })])
    expect(itemsOf(reset.project).find((item) => item.id === audio.id)).toMatchObject({ volume: -6, audioFadeIn: 0, audioFadeOut: 0 })
    for (const fields of [{}, { volume: NaN }, { volume: -61 }, { volume: 13 }, { fadeIn: -1 }, { fadeIn: seconds(-1, 1000) }, { fadeOut: seconds(1, 0) }, { fadeIn: seconds(5001, 1000) }, { monitorVolume: 0.5 }]) {
      await expect(applyCanonicalCommands(before.project, [envelope('clip.setAudio', { clipId: audio.id, ...fields })], media))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    const locked = structuredClone(before.project)
    locked.timeline!.tracks.find((track) => track.id === audio.trackId)!.locked = true
    await expect(applyCanonicalCommands(locked, [envelope('clip.setAudio', { clipId: audio.id, volume: 0 })], media))
      .resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
    for (const fields of [{ muted: false }, { pitchSemitones: 0 }, { pitchCents: 0 }, { eq: null }]) {
      await expect(applyCanonicalCommands(before.project, [
        envelope('clip.setAudio', { clipId: audio.id, volume: -12 }),
        envelope('clip.setAudio', { clipId: audio.id, fadeIn: seconds(1), ...fields }),
      ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'not-implemented', index: 1 })
    }
    expect(before.project).toEqual(keyed.project)
  })

  it('sets editable captions at exact NTSC times without shifting overlapping cues', async () => {
    const graph = project()
    graph.metadata = { ...graph.metadata, fps: 29.97 }
    const batch = [envelope('captions.set', { captions: [
      { id: 'later', start: seconds(1001 * 600_001, 30_000), end: seconds(1001 * 600_003, 30_000), text: 'Later' },
      { id: 'earlier', start: seconds(1001 * 600_000, 30_000), end: seconds(1001 * 600_002, 30_000), text: 'Earlier\nline' },
    ] }, 'exact-captions')]
    const first = await applied(graph, batch)
    const second = await applied(graph, batch)
    expect(second.digest).toBe(first.digest)
    expect(itemsOf(first.project)).toMatchObject([
      { id: 'earlier', type: 'text', textRole: 'caption', from: 600_000, durationInFrames: 2, text: 'Earlier\nline' },
      { id: 'later', type: 'text', textRole: 'caption', from: 600_001, durationInFrames: 2, text: 'Later' },
    ])
    expect(itemsOf(first.project).every((item) => !('captionSource' in item))).toBe(true)
    expect((first.project as unknown as Record<string, unknown>).frameleafFuture).toEqual((graph as unknown as Record<string, unknown>).frameleafFuture)
    expect((await applied(first.project, [])).digest).toBe(first.digest)
  })

  it('replaces and clears main-sequence caption forms while retaining matching styles and linked media', async () => {
    const graph = (await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])).project
    const video = itemsOf(graph).find((item) => item.type === 'video')! as unknown as TimelineItem
    const transcript = { type: 'transcript' as const, mediaId: ASSET, enabled: true, updatedAt: 1, cues: [
      { id: 'cue', startSeconds: 0, endSeconds: 1, text: 'Virtual' },
    ] }
    video.transcriptCaptions = transcript
    graph.timeline!.tracks.push({ ...graph.timeline!.tracks[0]!, id: 'captions', order: -1 })
    const caption = {
      id: 'keep', type: 'text' as const, textRole: 'caption' as const, trackId: 'captions', from: 0,
      durationInFrames: 30, text: 'Old', label: 'Old', color: '#ffff00', fontSize: 44,
      textSpans: [{ text: 'Old styled content' }], frameleafCaptionFuture: { keep: true },
      linkedGroupId: video.linkedGroupId,
      captionSource: { type: 'transcript' as const, clipId: video.id, mediaId: ASSET },
    }
    // Project's persisted item type predates subtitle segments; use the engine's current union.
    ;(graph.timeline!.items as unknown as TimelineItem[]).push(caption as TextItem, { ...caption, id: 'remove', textSpans: undefined } as TextItem, {
      id: 'subtitle', type: 'subtitle', label: 'Imported', trackId: 'captions', from: 0, durationInFrames: 30, color: '#ffffff',
      source: { type: 'subtitle-import', fileName: 'captions.srt', format: 'srt', importedAt: 1 },
      cues: [{ id: 'subtitle-cue', startSeconds: 0, endSeconds: 1, text: 'Imported' }],
    })
    const before = canonicalJson(graph)
    const changed = await applied(graph, [envelope('captions.set', { captions: [
      { id: 'keep', start: seconds(1), end: seconds(2), text: 'New' },
    ] })])
    expect(canonicalJson(graph)).toBe(before)
    expect(itemsOf(changed.project).find((item) => item.id === 'keep')).toMatchObject({
      ...caption, text: 'New', label: 'New', from: 30, textSpans: undefined,
    })
    expect(itemsOf(changed.project).filter((item) => item.type === 'audio')).toEqual(itemsOf(graph).filter((item) => item.type === 'audio'))
    expect(itemsOf(changed.project).find((item) => item.id === video.id)).toMatchObject({ transcriptCaptions: { ...transcript, enabled: false } })
    expect(itemsOf(changed.project).map((item) => item.id)).not.toContain('remove')
    expect(itemsOf(changed.project).map((item) => item.id)).not.toContain('subtitle')
    const cleared = await applied(changed.project, [envelope('captions.set', { captions: [] })])
    expect(itemsOf(cleared.project).map((item) => item.type).sort()).toEqual(['audio', 'video'])
    expect(cleared.project.timeline!.tracks).toEqual(changed.project.timeline!.tracks)
  })

  it('rejects invalid caption sets and locked replacements atomically', async () => {
    const line = { id: 'caption', start: seconds(0), end: seconds(1), text: 'Valid' }
    const graph = (await applied(project(), [envelope('captions.set', { captions: [line] })])).project
    const before = canonicalJson(graph)
    for (const payload of [
      {}, { captions: null }, { captions: [null] }, { captions: [line], sequenceId: 'other' },
      { captions: [{ ...line, id: '' }] }, { captions: [line, line] },
      { captions: [{ ...line, text: '  ' }] }, { captions: [{ ...line, text: 'bad\u0000text' }] },
      { captions: [{ ...line, text: 'x'.repeat(4 * 1024 * 1024 + 1) }] },
      { captions: [{ ...line, start: seconds(-1, 1000) }] },
      { captions: [{ ...line, end: seconds(0) }] }, { captions: [{ ...line, end: seconds(1, 1000) }] },
      { captions: [{ ...line, end: seconds(Number.MAX_SAFE_INTEGER, 1) }] },
      { captions: [{ ...line, start: seconds(1, 0) }] }, { captions: [{ ...line, style: 'unsupported' }] },
    ]) {
      await expect(applyCanonicalCommands(graph, [envelope('captions.set', payload)], media))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 0 })
      expect(canonicalJson(graph)).toBe(before)
    }
    graph.timeline!.tracks.find((track) => track.id === itemsOf(graph)[0]!.trackId)!.locked = true
    await expect(applyCanonicalCommands(graph, [envelope('captions.set', { captions: [] })], media))
      .resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
  })

  it('rejects nested composition caption id collisions without changing the graph or host history', async () => {
    const titled = (await applied(project(), [envelope('title.add', { text: 'Nested', at: seconds(0) })])).project
    const composed = (await applied(titled, [envelope('composition.add', { name: 'Nested', clipIds: [itemsOf(titled)[0]!.id] })])).project
    const graph = (await applied(composed, [])).project
    graph.timeline!.compositions![0]!.items[0]!.id = 'nested-clip'
    const before = canonicalJson(graph)
    const nestedBefore = canonicalJson(graph.timeline!.compositions)
    const collision = envelope('captions.set', { captions: [{ id: 'nested-clip', start: seconds(0), end: seconds(1), text: 'Caption' }] })
    let current: unknown = graph
    const history = createStudioGraphHistory()
    history.record(titled, graph)
    const depth = history.depth
    const stage = vi.fn((next: unknown) => { current = next })
    const bridge = createStudioBridge({
      context: () => ({ revision: 3, hasLease: true, hasAccess: true, online: true,
        capabilities: { ...emptyStudioCapabilities(), transcriptionWorker: true } }),
      handlers: createStudioEngineCommandHandlers({
        graph: () => current, revision: () => 3, assets: () => [], restore: async () => false, history, stage,
        engine: async () => ({ dispose() {}, async apply(input, batch) {
          const result = await applyCanonicalCommands(input, batch as unknown as readonly CanonicalEnvelope[], media)
          return result.status === 'applied' ? { status: 'applied', graph: result.project, digest: result.digest } : result
        } }),
      }),
    })
    const [result] = await bridge.submit([collision as unknown as StudioCommandEnvelope])
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid' })
    expect(stage).not.toHaveBeenCalled()
    expect(current).toBe(graph)
    expect(history.depth).toEqual(depth)
    await expect(applyCanonicalCommands(graph, [envelope('title.add', { text: 'Before rejection', at: seconds(3) }), collision], media))
      .resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 1 })
    expect(canonicalJson(graph)).toBe(before)
    expect(canonicalJson(graph.timeline!.compositions)).toBe(nestedBefore)
  })

  it('skips generated caption ids occupied by nested composition items', async () => {
    const titled = (await applied(project(), [envelope('title.add', { text: 'Nested', at: seconds(0) })])).project
    const composed = (await applied(titled, [envelope('composition.add', { name: 'Nested', clipIds: [itemsOf(titled)[0]!.id] })])).project
    const graph = (await applied(composed, [])).project
    graph.timeline!.tracks.push({ ...graph.timeline!.tracks[0]!, id: 'free-captions', order: -1 })
    const uuid = deterministicUuids('nested-auto:0')
    const occupied = uuid()
    const available = uuid()
    graph.timeline!.compositions![0]!.items[0]!.id = occupied
    const before = canonicalJson(graph)
    const outcome = await applied(graph, [envelope('captions.set', { captions: [{ start: seconds(0), end: seconds(1), text: 'Caption' }] }, 'nested-auto')])
    expect(itemsOf(outcome.project).find((item) => item.type === 'text' && item.textRole === 'caption')?.id).toBe(available)
    expect(outcome.project.timeline!.compositions).toEqual(graph.timeline!.compositions)
    expect(canonicalJson(graph)).toBe(before)
  })

  it('initializes the master bus for mute-only edits on empty and absent timelines after another project', async () => {
    const eq = { enabled: true, lowGainDb: 2 }
    const empty = project({ tracks: [], items: [], masterBusDb: 3, masterBusMuted: false, busAudioEq: eq })
    const absent = project()
    delete absent.timeline
    usePlaybackStore.setState({ volume: 0.25, muted: true })
    for (const graph of [empty, absent]) {
      await applied(project({ busAudioEq: { lowGainDb: -4 } }), [envelope('project.setMasterAudio', { gainDb: -6 })])
      const outcome = await applied(graph, [envelope('project.setMasterAudio', { muted: true })])
      expect(outcome.project.timeline).toMatchObject({ masterBusDb: graph.timeline?.masterBusDb ?? 0, masterBusMuted: true })
      expect(outcome.project.timeline?.busAudioEq).toEqual(graph.timeline ? expect.objectContaining(eq) : undefined)
      expect(usePlaybackStore.getState()).toMatchObject({ volume: 0.25, muted: true })
    }
  })

  it('edits the persisted master bus separately from monitor volume and refuses unsupported fields atomically', async () => {
    const before = await applied(project({ busAudioEq: { enabled: true, lowGainDb: 2 } }), [])
    usePlaybackStore.setState({ volume: 0.25, muted: true })
    const changed = await applied(before.project, [envelope('project.setMasterAudio', { gainDb: -6, muted: true })])
    expect(changed.project.timeline).toEqual({ ...before.project.timeline, masterBusDb: -6, masterBusMuted: true })
    expect(usePlaybackStore.getState()).toMatchObject({ volume: 0.25, muted: true })
    const restored = await applied(changed.project, [envelope('project.setMasterAudio', { gainDb: 0, muted: false })])
    expect(restored.project).toEqual(before.project)
    for (const payload of [{}, { gainDb: -61 }, { gainDb: 13 }, { gainDb: NaN }, { muted: 1 }, { volume: 0.5 }, { ducking: 'off' }]) {
      await expect(applyCanonicalCommands(before.project, [envelope('project.setMasterAudio', payload)], media))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 0 })
    }
    await expect(applyCanonicalCommands(before.project, [
      envelope('project.setMasterAudio', { gainDb: -12 }),
      envelope('project.setMasterAudio', { gainDb: -3, ducking: false }),
    ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'not-implemented', index: 1 })
    expect(before.project.timeline?.masterBusDb).toBe(0)
  })

  it('covers every Freecut public command row', () => {
    const publicRows = (manifest as { features: Array<{ id: string }> }).features
      .map((feature) => feature.id)
      .filter((id) => id.startsWith('command.'))
    const covered = new Set(Object.values(ENGINE_COMMANDS).flat())
    expect(publicRows.length).toBe(19)
    expect(publicRows.filter((row) => !covered.has(row))).toEqual([])
    // And every engine command is a catalogue command that changes the graph and can be undone.
    const rows = new Map(
      (
        catalogue as { commands: Array<{ id: string; mutatesGraph: boolean; undoable: boolean }> }
      ).commands.map((row) => [row.id, row]),
    )
    for (const id of Object.keys(ENGINE_COMMANDS)) {
      expect(rows.get(id)).toMatchObject({ mutatesGraph: true, undoable: true })
    }
    // The host routes exactly these commands to the engine.
    expect([...studioEngineCommandIds].sort()).toEqual(Object.keys(ENGINE_COMMANDS).sort())
  })

  it('converts exact rational seconds to frames without float drift', () => {
    expect(secondsToFrames(seconds(25, 2), 30)).toBe(375)
    expect(secondsToFrames(seconds(1001, 30_000), 29.97)).toBe(1)
    expect(secondsToFrames(seconds(1, 60), 30)).toBe(1) // exactly half a frame rounds up
    expect(secondsToFrames(seconds(0), 24)).toBe(0)
  })

  it('reads 30000/1001 and 24000/1001 exactly, never as 2997/100 (FL-93)', () => {
    expect(frameRateOf(29.97)).toEqual({ num: 30_000n, den: 1001n })
    expect(frameRateOf(30_000 / 1001)).toEqual({ num: 30_000n, den: 1001n })
    expect(frameRateOf(23.976)).toEqual({ num: 24_000n, den: 1001n })
    expect(frameRateOf({ num: 60_000, den: 1001 })).toEqual({ num: 60_000n, den: 1001n })
    // 2997/100 loses a millionth of a frame per frame: past 500,000 frames (4.6 hours) the start of
    // frame n rounded to frame n - 1. The exact rate lands on n at any length.
    const late = seconds(600_000 * 1001, 30_000)
    expect(secondsToFrames(late, { num: 30_000, den: 1001 })).toBe(600_000)
    expect(secondsToFrames(late, 29.97)).toBe(600_000)
    expect(secondsToFrames(seconds(3600), 29.97)).toBe(107_892)
    expect(secondsToFrames(seconds(3600), 23.976)).toBe(86_314)
    expect(() => frameRateOf(27.3)).toThrow('no exact reading')
  })

  it('places a clip on the exact cadence of an NTSC project and stores the rational', async () => {
    const ntsc = project()
    ntsc.metadata = { ...ntsc.metadata, fps: 29.97 }
    const added = await applied(ntsc, [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(1001 * 90, 30_000) }),
    ])
    expect(added.project.metadata).toEqual(
      expect.objectContaining({ fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } }),
    )
    expect(itemsOf(added.project).find((item) => item.mediaId === ASSET)).toEqual(
      expect.objectContaining({ from: 90 }),
    )
  })

  it('refuses a batch for a project whose frame rate has no exact reading', async () => {
    const odd = project()
    odd.metadata = { ...odd.metadata, fps: 27.3 }
    const outcome = await applyCanonicalCommands(
      odd,
      [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })],
      [],
    )
    expect(outcome).toEqual(expect.objectContaining({ status: 'rejected', reason: 'invalid' }))
  })

  it('places library media, splits it and keeps unknown graph fields', async () => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    expect(video).toMatchObject({ mediaId: ASSET, from: 0, durationInFrames: 240, trackId: 'v1' })
    // Freecut's import path links an audio companion to a video with sound.
    const audio = itemsOf(added.project).find((item) => item.type === 'audio')!
    expect(audio.linkedGroupId).toBe(video.linkedGroupId)
    expect((added.project as unknown as { frameleafFuture: unknown }).frameleafFuture).toEqual({
      keep: [1, null, { nested: true }],
    })

    const split = await applied(added.project, [
      envelope('clip.split', { at: seconds(2), clipIds: [video.id] }),
    ])
    const videos = itemsOf(split.project)
      .filter((item) => item.type === 'video')
      .sort((a, b) => a.from - b.from)
    expect(videos.map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 60],
      [60, 180],
    ])
  })

  it.each([true, false])('splits selected audio/video once with linked selection %s (FL-94)', async (linked) => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    const audio = itemsOf(added.project).find((item) => item.type === 'audio')!
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: !linked })
    try {
      const split = await applied(added.project, [
        envelope('clip.split', { at: seconds(2), clipIds: [video.id, audio.id, video.id], linkedSelectionEnabled: linked }),
      ])
      const parts = itemsOf(split.project)
      expect(parts).toHaveLength(4)
      for (const type of ['video', 'audio']) {
        expect(parts.filter((item) => item.type === type).sort((a, b) => a.from - b.from)
          .map((item) => [item.from, item.durationInFrames, item.sourceStart, item.sourceEnd])).toEqual([
          [0, 60, 0, 60],
          [60, 180, 60, 240],
        ])
      }
      if (linked) {
        const groups = [0, 60].map((from) => parts.filter((item) => item.from === from))
        for (const group of groups) {
          expect(group[0]!.linkedGroupId).toBeTruthy()
          expect(group[0]!.linkedGroupId).toBe(group[1]!.linkedGroupId)
        }
        expect(groups[0]![0]!.linkedGroupId).not.toBe(groups[1]![0]!.linkedGroupId)
      }
      await expect(applyCanonicalCommands(
        added.project,
        [envelope('clip.split', { at: seconds(2), clipIds: [video.id, 'missing'] })],
        media,
      )).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it('splits only the selected video when linked selection was off in the editor (FL-94)', async () => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: true }) // Hidden command document's default.
    try {
      const split = await applied(added.project, [
        envelope('clip.split', { at: seconds(2), clipIds: [video.id], linkedSelectionEnabled: false }),
      ])
      expect(itemsOf(split.project).filter((item) => item.type === 'video')).toHaveLength(2)
      expect(itemsOf(split.project).filter((item) => item.type === 'audio')).toHaveLength(1)
      expect(useEditorStore.getState().linkedSelectionEnabled).toBe(true)
      const splitAll = await applied(added.project, [
        envelope('clip.split', { at: seconds(2), linkedSelectionEnabled: false }),
      ])
      expect(itemsOf(splitAll.project).filter((item) => item.type === 'video')).toHaveLength(2)
      expect(itemsOf(splitAll.project).filter((item) => item.type === 'audio')).toHaveLength(2)
      await expect(applyCanonicalCommands(added.project, [
        envelope('clip.split', { at: seconds(2), linkedSelectionEnabled: 'off' }),
      ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it.each([true, false])('moves linked clips and their own captions with linked selection %s (FL-94)', async (linked) => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(2) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    const audio = itemsOf(added.project).find((item) => item.type === 'audio')!
    audio.from = 30 // Linked members may have intentionally different timeline offsets.
    const timeline = added.project.timeline!
    timeline.tracks.push(
      { ...timeline.tracks[0]!, id: 'v2', order: 2 },
      { ...timeline.tracks[0]!, id: 'captions', order: 3 },
    )
    timeline.items.push(...[video, audio].map((clip): TextItem => ({
      id: `${clip.type}-caption`, trackId: 'captions', from: clip.from + 10,
      durationInFrames: 10, label: 'Caption', type: 'text', text: 'Caption', color: '#ffffff',
      textRole: 'caption', captionSource: { type: 'transcript', clipId: clip.id, mediaId: ASSET },
    })))
    const before = canonicalJson(added.project)
    const previous = useEditorStore.getState().linkedSelectionEnabled
    // The command document's local preference must not override the envelope's captured intent.
    useEditorStore.setState({ linkedSelectionEnabled: !linked })
    try {
      const boundary = await applyCanonicalCommands(added.project, [
        envelope('clip.move', { clipId: video.id, start: seconds(3), linkedSelectionEnabled: linked }),
        envelope('clip.move', { clipId: video.id, start: seconds(0), linkedSelectionEnabled: linked }),
      ], media)
      if (linked) {
        expect(boundary).toMatchObject({ status: 'rejected', index: 1, reason: 'failed' })
        expect(boundary).not.toHaveProperty('project')
      } else {
        expect(boundary.status).toBe('applied')
        if (boundary.status === 'applied') {
          expect(itemsOf(boundary.project).find((item) => item.id === video.id)?.from).toBe(0)
        }
      }
      expect(canonicalJson(added.project)).toBe(before)

      const moved = await applied(added.project, [
        envelope('clip.move', { clipId: video.id, start: seconds(4), trackId: 'v2', linkedSelectionEnabled: linked }),
      ])
      expect(itemsOf(moved.project)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: video.id, from: 120, trackId: 'v2' }),
        expect.objectContaining({ id: audio.id, from: linked ? 90 : 30, trackId: 'a1' }),
        expect.objectContaining({ id: 'video-caption', from: 130, trackId: 'captions' }),
        expect.objectContaining({ id: 'audio-caption', from: linked ? 100 : 40, trackId: 'captions' }),
      ]))

      timeline.tracks.find((track) => track.id === 'a1')!.locked = true
      const lockedCompanion = await applied(added.project, [
        envelope('clip.move', { clipId: video.id, start: seconds(4), linkedSelectionEnabled: linked }),
      ])
      expect(itemsOf(lockedCompanion.project).find((item) => item.id === audio.id)?.from).toBe(30)
      // Captions follow their selected owner but obey their own track's lock, as in Freecut drag.
      expect(itemsOf(lockedCompanion.project).find((item) => item.id === 'audio-caption')?.from)
        .toBe(linked ? 100 : 40)
      for (const lockedTrack of ['v1', 'v2']) {
        timeline.tracks.find((track) => track.id === lockedTrack)!.locked = true
        await expect(applyCanonicalCommands(added.project, [
          envelope('clip.move', { clipId: video.id, start: seconds(4), trackId: 'v2', linkedSelectionEnabled: linked }),
        ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
        timeline.tracks.find((track) => track.id === lockedTrack)!.locked = false
      }
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it('carries visible linked selection through the host port and retries with the original intent (FL-94)', async () => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(2) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    const audio = itemsOf(added.project).find((item) => item.type === 'audio')!
    let graph: unknown = added.project
    let failTransport = true
    const received: StudioCommandEnvelope[] = []
    const bridge = createStudioBridge({
      context: () => ({ revision: 3, hasLease: true, hasAccess: true, online: true, capabilities: emptyStudioCapabilities() }),
      handlers: createStudioEngineCommandHandlers({
        graph: () => graph, revision: () => 3, assets: () => [], restore: async () => false,
        history: createStudioGraphHistory(), stage: (next) => { graph = next },
        engine: async () => ({
          dispose() {},
          async apply(current, envelopes) {
            received.push(...structuredClone(envelopes))
            if (failTransport) {
              failTransport = false
              throw new Error('command document disconnected')
            }
            // This models the hidden document's independent default, after the editor sent false.
            useEditorStore.setState({ linkedSelectionEnabled: true })
            const outcome = await applyCanonicalCommands(current, envelopes, media)
            return outcome.status === 'applied'
              ? { status: 'applied', graph: outcome.project, digest: outcome.digest }
              : outcome
          },
        }),
      }),
    })
    const channel = new MessageChannel()
    const nextMessage = () => new Promise<StudioFrameToHostMessage>((resolve) => {
      channel.port2.onmessage = (event) => resolve(event.data)
    })
    const parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    const listeners = vi.spyOn(window, 'addEventListener')
    const previous = useEditorStore.getState().linkedSelectionEnabled
    const move = createStudioCommandEnvelope('clip.move', { clipId: video.id, start: seconds(4) }, 3)
    try {
      connectToHost('editor', () => {})
      window.dispatchEvent(new MessageEvent('message', {
        source: window.parent, origin: window.location.origin,
        data: { source: 'frameleaf-studio-host' }, ports: [channel.port1],
      }))
      for (const linked of [false, true]) {
        useEditorStore.setState({ linkedSelectionEnabled: linked })
        const arrival = nextMessage()
        const pending = call('submitCommands', [structuredClone(move)])
        const request = await arrival
        expect(request).toMatchObject({ type: 'service', name: 'submitCommands', args: [[{
          payload: { linkedSelectionEnabled: false }, idempotencyKey: move.idempotencyKey,
        }]] })
        if (request.type !== 'service') throw new Error('missing command request')
        const result = await bridge.submit(request.args[0] as StudioCommandEnvelope[])
        channel.port2.postMessage({ type: 'service-result', callId: request.callId, ok: true, value: result })
        expect((await pending)[0]?.status).toBe(linked ? 'accepted' : 'rejected')
      }
      expect(received).toHaveLength(2)
      expect(received[1]).toEqual(received[0])
      expect(itemsOf(graph as Project).find((item) => item.id === video.id)?.from).toBe(120)
      expect(itemsOf(graph as Project).find((item) => item.id === audio.id)?.from).toBe(60)

      useEditorStore.setState({ linkedSelectionEnabled: false })
      const split = createStudioCommandEnvelope('clip.split', { at: seconds(5), clipIds: [video.id] }, 3)
      const splitArrival = nextMessage()
      const splitPending = call('submitCommands', [split])
      const splitRequest = await splitArrival
      expect(splitRequest).toMatchObject({ type: 'service', name: 'submitCommands', args: [[{
        payload: { linkedSelectionEnabled: false }, idempotencyKey: split.idempotencyKey,
      }]] })
      if (splitRequest.type !== 'service') throw new Error('missing split request')
      const splitResult = await bridge.submit(splitRequest.args[0] as StudioCommandEnvelope[])
      channel.port2.postMessage({ type: 'service-result', callId: splitRequest.callId, ok: true, value: splitResult })
      expect((await splitPending)[0]?.status).toBe('accepted')
      expect(itemsOf(graph as Project).filter((item) => item.type === 'video')).toHaveLength(2)
      expect(itemsOf(graph as Project).filter((item) => item.type === 'audio')).toHaveLength(1)

      // Older callers have no preference field; omission still carries linked clips, even with
      // a false runtime default. Non-command services keep their arguments unchanged.
      useEditorStore.setState({ linkedSelectionEnabled: false })
      const legacy = await applied(added.project, [envelope('clip.move', move.payload)])
      expect(itemsOf(legacy.project).find((item) => item.id === audio.id)?.from).toBe(120)
      const layout = { panels: ['timeline'] }
      const arrival = nextMessage()
      const saved = call('saveWorkspace', layout)
      const request = await arrival
      expect(request).toMatchObject({ name: 'saveWorkspace', args: [layout] })
      if (request.type !== 'service') throw new Error('missing workspace request')
      channel.port2.postMessage({ type: 'service-result', callId: request.callId, ok: true, value: { status: 'saved' } })
      await saved
    } finally {
      channel.port1.close()
      channel.port2.close()
      for (const [type, listener] of listeners.mock.calls) {
        if (type === 'message') window.removeEventListener(type, listener)
      }
      listeners.mockRestore()
      parentPost.mockRestore()
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  })

  it('is deterministic: the same graph and batch give the same graph and digest', async () => {
    const batch = [
      envelope(
        'clip.add',
        { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(3) },
        'fixed-a',
      ),
      envelope(
        'title.add',
        { at: seconds(1), text: 'Big wave', style: 'Bold', position: 'bc', animation: 'Rise' },
        'fixed-b',
      ),
    ]
    const first = await applied(project(), batch)
    const second = await applied(project(), batch)
    expect(second.digest).toBe(first.digest)
    expect(canonicalJson(second.project)).toBe(canonicalJson(first.project))
    const title = itemsOf(first.project).find((item) => item.type === 'text') as unknown as Record<
      string,
      unknown
    >
    expect(title).toMatchObject({
      text: 'Big wave',
      fontWeight: 'bold',
      verticalAlign: 'bottom',
      textAlign: 'center',
    })
    expect((title.textMotion as { in: { presetId: string } }).in.presetId).toBe('rise')
  })

  it('derives new ids from the idempotency key', () => {
    const a = deterministicUuids('k')
    const b = deterministicUuids('k')
    expect([a(), a()]).toEqual([b(), b()])
    expect(a()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is atomic: a failing envelope leaves nothing applied and is named', async () => {
    const outcome = await applyCanonicalCommands(
      project(),
      [
        envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0) }),
        envelope('clip.move', { clipId: 'missing', start: seconds(1) }),
      ],
      media,
    )
    expect(outcome).toMatchObject({ status: 'rejected', index: 1, reason: 'invalid' })
  })

  it('refuses media the session was not given, and malformed times', async () => {
    await expect(
      applyCanonicalCommands(
        project(),
        [envelope('clip.add', { trackId: 'v1', assetId: 'other', at: seconds(0) })],
        media,
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    await expect(
      applyCanonicalCommands(
        project(),
        [envelope('clip.add', { trackId: 'v1', assetId: STILL, at: 1.5 })],
        media,
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
  })

  it('moves, trims, adds a transition and removes clips with the engine actions', async () => {
    const start = await applied(project(), [
      envelope(
        'clip.add',
        { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) },
        's1',
      ),
      envelope(
        'clip.add',
        { trackId: 'v1', assetId: STILL, at: seconds(4), duration: seconds(4) },
        's2',
      ),
    ])
    const [left, right] = itemsOf(start.project).sort((a, b) => a.from - b.from)

    const trimmed = await applied(start.project, [
      envelope('clip.trimEnd', { clipId: right!.id, end: seconds(7) }),
    ])
    expect(itemsOf(trimmed.project).find((item) => item.id === right!.id)?.durationInFrames).toBe(
      90,
    )

    const withTransition = await applied(trimmed.project, [
      envelope('clip.setTransition', {
        clipId: left!.id,
        transition: { type: 'Cross dissolve', duration: seconds(1, 2) },
      }),
    ])
    expect(withTransition.project.timeline?.transitions).toEqual([
      expect.objectContaining({
        leftClipId: left!.id,
        rightClipId: right!.id,
        durationInFrames: 15,
        presentation: 'dissolve',
      }),
    ])

    const cleared = await applied(withTransition.project, [
      envelope('clip.setTransition', { clipId: left!.id, transition: null }),
    ])
    expect(cleared.project.timeline?.transitions ?? []).toEqual([])

    const moved = await applied(cleared.project, [
      envelope('clip.move', { clipId: right!.id, start: seconds(10) }),
    ])
    expect(itemsOf(moved.project).find((item) => item.id === right!.id)?.from).toBe(300)

    const removed = await applied(moved.project, [envelope('clip.delete', { clipId: left!.id })])
    expect(itemsOf(removed.project).map((item) => item.id)).toEqual([right!.id])
  })

  it.each([
    ['start', false], ['start', true], ['end', false], ['end', true],
  ] as const)('refuses partial %s trims and recovers with exact ranges (ripple %s, FL-94)', async (edge, ripple) => {
    const added = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(2) }),
    ])
    const video = itemsOf(added.project).find((item) => item.type === 'video')!
    const command = edge === 'start' ? 'clip.trimStart' : 'clip.trimEnd'
    const trimmed = await applied(added.project, [
      envelope(command, { clipId: video.id, [edge]: seconds(edge === 'start' ? 4 : 6) }),
    ])
    const before = structuredClone(trimmed.project)
    await expect(applyCanonicalCommands(trimmed.project, [
      envelope(command, { clipId: video.id, [edge]: seconds(edge === 'start' ? 0 : 12), ripple }),
    ], media)).resolves.toMatchObject({ status: 'rejected', index: 0, reason: 'failed' })
    expect(trimmed.project).toEqual(before)

    // Half-frame requests round up on the project cadence before the exact-range check.
    const accepted = await applied(trimmed.project, [
      envelope(command, { clipId: video.id, [edge]: seconds(edge === 'start' ? 181 : 481, 60), ripple }),
    ])
    const parts = itemsOf(accepted.project)
    expect(parts).toHaveLength(2)
    for (const part of parts) {
      expect(part).toMatchObject(edge === 'start'
        ? { from: ripple ? 120 : 91, durationInFrames: 209, sourceStart: 31, sourceEnd: 240 }
        : { from: 60, durationInFrames: 181, sourceStart: 0, sourceEnd: 181 })
    }
    expect(parts[0]!.linkedGroupId).toBeTruthy()
    expect(parts[0]!.linkedGroupId).toBe(parts[1]!.linkedGroupId)
  })

  it('adds and removes effects and keyframes, sets transforms and tracks', async () => {
    const start = await applied(project(), [
      envelope(
        'clip.add',
        { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) },
        'e1',
      ),
    ])
    const [still] = itemsOf(start.project)
    const effected = await applied(start.project, [
      envelope('effect.add', { clipId: still!.id, effect: 'gpu-sepia', params: { amount: 0.5 } }),
      envelope('clip.setTransform', {
        clipId: still!.id,
        transform: { x: 10, opacity: 0.5, scale: 0.5 },
      }),
      envelope('keyframe.add', {
        clipId: still!.id,
        property: 'opacity',
        at: seconds(1),
        value: { value: 0.25 },
      }),
      envelope('track.add', { kind: 'video', name: 'Titles', index: 0 }),
    ])
    const item = itemsOf(effected.project)[0] as unknown as {
      effects: Array<{ id: string; effect: { gpuEffectType: string } }>
      transform: { x: number; opacity: number; width: number; height: number }
    }
    expect(item.effects.map((effect) => effect.effect.gpuEffectType)).toEqual(['gpu-sepia'])
    // 4000×3000 fits the 1920×1080 canvas at 1440×1080; half of that.
    expect(item.transform).toMatchObject({ x: 10, opacity: 0.5, width: 720, height: 540 })
    expect(effected.project.timeline?.tracks.map((track) => track.name)).toContain('Titles')
    const keyframes = effected.project.timeline?.keyframes?.[0]?.properties[0]?.keyframes ?? []
    expect(keyframes).toEqual([expect.objectContaining({ frame: 30, value: 0.25 })])

    const cleaned = await applied(effected.project, [
      envelope('effect.remove', { clipId: still!.id, effectId: item.effects[0]!.id }),
      envelope('keyframe.remove', {
        clipId: still!.id,
        property: 'opacity',
        keyframeIds: [keyframes[0]!.id],
      }),
    ])
    expect(
      (itemsOf(cleaned.project)[0] as unknown as { effects?: unknown[] }).effects ?? [],
    ).toEqual([])
  })

  it('moves, revalues and eases keyframes, and refuses what the curve cannot hold (FL-100)', async () => {
    const start = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) }, 'k1'),
    ])
    const [still] = itemsOf(start.project)
    const keyed = await applied(start.project, [
      envelope('keyframe.add', { clipId: still!.id, property: 'opacity', at: seconds(1), value: { value: 0.25 } }, 'k2'),
      envelope('keyframe.add', { clipId: still!.id, property: 'opacity', at: seconds(3), value: { value: 1 } }, 'k3'),
    ])
    const frames = (graph: unknown) =>
      ((graph as { timeline?: { keyframes?: Array<{ properties: Array<{ keyframes: Array<Record<string, unknown>> }> }> } })
        .timeline?.keyframes?.[0]?.properties[0]?.keyframes ?? [])
    const [first, second] = frames(keyed.project) as Array<{ id: string }>

    const moved = await applied(keyed.project, [
      envelope('keyframe.update', { clipId: still!.id, property: 'opacity', keyframeId: first!.id, at: seconds(2), value: { value: 0.5 } }),
    ])
    expect(frames(moved.project)).toEqual([
      expect.objectContaining({ id: first!.id, frame: 60, value: 0.5 }),
      expect.objectContaining({ id: second!.id, frame: 90, value: 1 }),
    ])

    const eased = await applied(moved.project, [
      envelope('keyframe.setEasing', {
        clipId: still!.id, property: 'opacity', keyframeIds: [first!.id], easing: 'cubic-bezier',
        bezier: { x1: 0.2, y1: -0.1, x2: 0.3, y2: 1.2 },
      }),
      envelope('keyframe.setEasing', {
        clipId: still!.id, property: 'opacity', keyframeIds: [second!.id], easing: 'spring', spring: { tension: 300 },
      }),
    ])
    expect(frames(eased.project)).toEqual([
      expect.objectContaining({ easing: 'cubic-bezier', easingConfig: { type: 'cubic-bezier', bezier: { x1: 0.2, y1: -0.1, x2: 0.3, y2: 1.2 } } }),
      expect.objectContaining({ easing: 'spring', easingConfig: { type: 'spring', spring: { tension: 300, friction: 26, mass: 1 } } }),
    ])
    const linear = await applied(eased.project, [
      envelope('keyframe.setEasing', { clipId: still!.id, property: 'opacity', keyframeIds: [first!.id, second!.id], easing: 'hold' }),
    ])
    expect(frames(linear.project).map((keyframe) => [keyframe.easing, keyframe.easingConfig])).toEqual([['hold', undefined], ['hold', undefined]])

    for (const [id, payload] of [
      ['keyframe.update', { clipId: still!.id, property: 'opacity', keyframeId: 'nope', value: { value: 1 } }],
      ['keyframe.update', { clipId: still!.id, property: 'opacity', keyframeId: first!.id, at: seconds(3) }],
      ['keyframe.update', { clipId: still!.id, property: 'opacity', keyframeId: first!.id, at: seconds(9) }],
      ['keyframe.update', { clipId: still!.id, property: 'opacity', keyframeId: first!.id }],
      ['keyframe.setEasing', { clipId: still!.id, property: 'opacity', keyframeIds: [first!.id], easing: 'wobble' }],
      ['keyframe.setEasing', { clipId: still!.id, property: 'opacity', keyframeIds: [first!.id], easing: 'cubic-bezier', bezier: { x1: 1.5, y1: 0, x2: 0.3, y2: 1 } }],
      ['keyframe.setEasing', { clipId: still!.id, property: 'opacity', keyframeIds: [first!.id], easing: 'spring', spring: { mass: 0 } }],
      ['keyframe.setEasing', { clipId: still!.id, property: 'opacity', keyframeIds: [first!.id], easing: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } }],
    ] as const) {
      await expect(applyCanonicalCommands(moved.project, [envelope(id, payload as never)], media)).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
    }
  })

  it('answers music from the rights-blocked catalogue and clip mute honestly', async () => {
    await expect(
      applyCanonicalCommands(
        project(),
        [envelope('music.add', { musicId: 'ambient-1', at: seconds(0) })],
        media,
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
    const start = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }, 'm1'),
    ])
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    await expect(
      applyCanonicalCommands(
        start.project,
        [envelope('clip.update', { clipId: video.id, patch: { muted: true } })],
        media,
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'not-implemented' })
  })

  it('refuses a graph that is not a Freecut project', async () => {
    await expect(
      applyCanonicalCommands(null, [envelope('track.add', { kind: 'video' })], media),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid',
    })
  })
})
