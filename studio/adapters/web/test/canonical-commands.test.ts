import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TextItem, TimelineItem } from '@/types/timeline'
import { resolveTrackAudioPanStages } from '@/shared/utils/audio-pan'
import { getAudioEqSettings, resolveAudioEqSettings } from '@/shared/utils/audio-eq'
import { getAudioPitchShiftSemitones, resolvePreviewAudioPitchShiftSemitones } from '@/shared/utils/audio-pitch'
import { collectDuckingSources, extractAudioSegments } from '@/features/export/utils/canvas-audio'
import { collectAudioTrackItems, collectVisualTrackItems } from '@/runtime/composition-runtime/utils/scene-assembly'
import { buildStandaloneAudioSegments, buildTransitionVideoAudioSegments } from '@/runtime/composition-runtime/utils/audio-scene'
import { selectTimelineSkimSourceAtFrame } from '@/features/timeline/utils/timeline-audio-skim'
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { compileAudioMeterGraph, resolveAudioMeterSources, resolveCompiledAudioMeterSources } from '@/features/editor/components/audio-meter-utils'
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
    for (const fields of [{ muted: 'yes' }]) {
      await expect(applyCanonicalCommands(before.project, [
        envelope('clip.setAudio', { clipId: audio.id, volume: -12 }),
        envelope('clip.setAudio', { clipId: audio.id, fadeIn: seconds(1), ...fields }),
      ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 1 })
    }
    expect(before.project).toEqual(keyed.project)
  })

  it('routes canonical clip pitch and EQ into the existing preview and export stages and clears them on reopen', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const audio = itemsOf(start.project).find((item) => item.type === 'audio')!
    Object.assign(audio, { src: 'blob:clip-audio', audioFadeIn: 0.01, audioFadeOut: 1.5, audioFadeInCurve: -0.25 })
    const keyed = await applied(start.project, [envelope('keyframe.add', { clipId: audio.id, property: 'volume', at: seconds(1), value: { value: -3 } })])
    const before = await applied(keyed.project, [])
    const eq = { enabled: true, lowType: 'peaking', lowGainDb: 4, lowFrequencyHz: 250, lowQ: 1.5, band6Enabled: true, band6Type: 'low-pass', band6FrequencyHz: 9000 } as const
    const changed = await applied(before.project, [envelope('clip.setAudio', { clipId: audio.id, pitchSemitones: -3, pitchCents: 25, eq })])
    const edited = itemsOf(changed.project).find((item) => item.id === audio.id)!
    expect(edited).toMatchObject({ audioPitchSemitones: -3, audioPitchCents: 25, audioEqLowGainDb: 4, audioFadeIn: 0.01, audioFadeOut: 1.5, audioFadeInCurve: -0.25 })
    expect(itemsOf(changed.project).filter((item) => item.id !== audio.id)).toEqual(itemsOf(before.project).filter((item) => item.id !== audio.id))
    expect({ ...changed.project.timeline, items: [] }).toEqual({ ...before.project.timeline, items: [] })
    expect(resolvePreviewAudioPitchShiftSemitones({ base: edited })).toBe(-2.75)
    expect(resolveAudioEqSettings(getAudioEqSettings(edited))).toEqual(resolveAudioEqSettings(eq))
    // Export resolves ephemeral source URLs after loading the saved graph.
    const composition = { ...changed.project.timeline, fps: 30, tracks: changed.project.timeline!.tracks.map((track) => ({ ...track, items: itemsOf(changed.project).filter((item) => item.trackId === track.id).map((item) => ({ ...item, src: 'blob:resolved-export-source' })) })) }
    const segment = extractAudioSegments(composition as never, 30).find((item) => item.itemId === audio.id)!
    expect(segment).toMatchObject({ pitchShiftSemitones: -2.75, fadeInFrames: 0.3, fadeOutFrames: 45 })
    expect(segment.audioEqStages.at(-1)).toEqual(resolveAudioEqSettings(eq))
    expect((await applied(JSON.parse(JSON.stringify(changed.project)), [])).digest).toBe(changed.digest)
    const cleared = await applied(changed.project, [envelope('clip.setAudio', { clipId: audio.id, pitchSemitones: 0, pitchCents: 0, eq: null })])
    const reset = itemsOf(cleared.project).find((item) => item.id === audio.id)!
    expect(getAudioPitchShiftSemitones(reset)).toBe(0)
    expect(Object.values(getAudioEqSettings(reset)).every((value) => value === undefined)).toBe(true)
    expect((await applied(JSON.parse(JSON.stringify(cleared.project)), [])).digest).toBe(cleared.digest)
    for (const fields of [{ pitchSemitones: 13 }, { pitchSemitones: 1.5 }, { pitchCents: -101 }, { pitchCents: NaN }, { eq: [] }, { eq: { lowGainDb: 21 } }, { eq: { lowQ: 0 } }, { eq: { enabled: 'yes' } }, { eq: { lowType: 'high-pass' } }, { eq: { bogus: 1 } }]) {
      await expect(applyCanonicalCommands(before.project, [envelope('clip.setAudio', { clipId: audio.id, ...fields })], media))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    await expect(applyCanonicalCommands(before.project, [
      envelope('clip.setAudio', { clipId: audio.id, pitchCents: 50, eq }),
      envelope('clip.setAudio', { clipId: audio.id, muted: 'yes' }),
    ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 1 })
  })

  it('routes canonical track gain and EQ through preview and export without changing clip audio or ownership', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const audio = itemsOf(start.project).find((item) => item.type === 'audio')!
    const before = await applied(start.project, [
      envelope('clip.setAudio', { clipId: audio.id, volume: -4, fadeIn: seconds(1, 100), pitchSemitones: -3, pitchCents: 25, eq: { highGainDb: 2 } }),
      envelope('keyframe.add', { clipId: audio.id, property: 'volume', at: seconds(1), value: { value: -3 } }),
      envelope('project.setMasterAudio', { gainDb: -2 }),
    ])
    const eq = { lowGainDb: 4, lowFrequencyHz: 250, lowQ: 1.5 }
    const changed = await applied(before.project, [envelope('track.setAudio', { trackId: 'a1', gainDb: -6, eq, pan: -0.5 })])
    expect(itemsOf(changed.project)).toEqual(itemsOf(before.project))
    expect({ ...changed.project.timeline, tracks: [] }).toEqual({ ...before.project.timeline, tracks: [] })
    expect(changed.project.timeline!.tracks.filter((track) => track.id !== 'a1')).toEqual(before.project.timeline!.tracks.filter((track) => track.id !== 'a1'))
    expect(changed.project.timeline!.tracks.find((track) => track.id === 'a1')).toMatchObject({ volume: -6, pan: -0.5, muted: false, audioEq: resolveAudioEqSettings(eq) })
    const resolvedTracks = changed.project.timeline!.tracks.map((track) => ({ ...track, items: itemsOf(changed.project).filter((item) => item.trackId === track.id).map((item) => ({ ...item, src: 'blob:resolved-audio' })) }))
    const preview = buildStandaloneAudioSegments(collectAudioTrackItems({ tracks: resolvedTracks, visibleTrackIds: new Set(resolvedTracks.map((track) => track.id)) }), 30).find((segment) => segment.itemId === audio.id)!
    const exported = extractAudioSegments({ ...changed.project.timeline, fps: 30, tracks: resolvedTracks } as never, 30).find((segment) => segment.itemId === audio.id)!
    expect(preview).toMatchObject({ volumeDb: -10, audioFadeIn: 0.01, audioPitchSemitones: -3, audioPitchCents: 25, muted: false })
    expect(exported).toMatchObject({ volume: -10, trackVolumeDb: -6, fadeInFrames: 0.3, pitchShiftSemitones: -2.75 })
    expect(preview.audioEqStages).toEqual([resolveAudioEqSettings(eq), resolveAudioEqSettings({ highGainDb: 2 })])
    expect(exported.audioEqStages.slice(-2)).toEqual(preview.audioEqStages)
    expect(exported.panStages).toEqual([-0.5])
    expect(resolveTrackAudioPanStages(itemsOf(changed.project), changed.project.timeline!.tracks, [], audio.id)).toEqual(exported.panStages)
    expect((await applied(JSON.parse(JSON.stringify(changed.project)), [])).digest).toBe(changed.digest)
    const cleared = await applied(changed.project, [envelope('track.setAudio', { trackId: 'a1', gainDb: 0, eq: null, pan: 0 })])
    expect(cleared.project.timeline!.tracks.find((track) => track.id === 'a1')).toMatchObject({ volume: 0, pan: 0 })
    expect(cleared.project.timeline!.tracks.find((track) => track.id === 'a1')!.audioEq).toBeUndefined()
    expect(itemsOf(cleared.project)).toEqual(itemsOf(before.project))
    expect((await applied(JSON.parse(JSON.stringify(cleared.project)), [])).digest).toBe(cleared.digest)
    for (const fields of [{ gainDb: -61 }, { gainDb: 13 }, { gainDb: NaN }, { pan: NaN }, { pan: Infinity }, { pan: -1.1 }, { pan: 1.1 }, { pan: null }, { pan: '0' }, { eq: [] }, { eq: { lowQ: 11 } }, { eq: { bogus: 1 } }, { muted: true }, { automation: [] }]) {
      await expect(applyCanonicalCommands(before.project, [envelope('track.setAudio', { trackId: 'a1', ...fields })], media))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    const locked = structuredClone(before.project)
    locked.timeline!.tracks.find((track) => track.id === 'a1')!.locked = true
    await expect(applyCanonicalCommands(locked, [envelope('track.setAudio', { trackId: 'a1', gainDb: 0 })], media))
      .resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
    const snapshot = structuredClone(before.project)
    await expect(applyCanonicalCommands(before.project, [
      envelope('track.setAudio', { trackId: 'a1', gainDb: -12, eq }),
      envelope('track.setAudio', { trackId: 'a1', gainDb: -3, eq, pan: 2 }),
    ], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 1 })
    expect(before.project).toEqual(snapshot)
  })

  it('mutes and resets clip audio through real preview, meters, scrub and export without reviving separated video audio', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const audio = itemsOf(start.project).find((item) => item.type === 'audio')!
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    const before = await applied(start.project, [
      envelope('clip.setAudio', { clipId: audio.id, volume: -4, fadeIn: seconds(1, 100), pitchSemitones: -3, eq: { lowGainDb: 3 } }),
      envelope('keyframe.add', { clipId: audio.id, property: 'volume', at: seconds(1), value: { value: -3 } }),
    ])
    const muted = await applied(before.project, [envelope('clip.setAudio', { clipId: audio.id, muted: true })])
    expect(itemsOf(muted.project)).toEqual(itemsOf(before.project).map((item) => item.id === audio.id ? { ...item, muted: true } : item))
    expect({ ...muted.project.timeline, items: [] }).toEqual({ ...before.project.timeline, items: [] })
    const tracks = muted.project.timeline!.tracks.map((track) => ({ ...track, items: itemsOf(muted.project).filter((item) => item.trackId === track.id).map((item) => ({ ...item, src: 'blob:resolved-mute-source' })) }))
    const visibleTrackIds = new Set(tracks.map((track) => track.id))
    const preview = buildStandaloneAudioSegments(collectAudioTrackItems({ tracks, visibleTrackIds }), 30)
    expect(preview.find((item) => item.itemId === audio.id)).toMatchObject({ muted: true, volumeDb: -4, audioFadeIn: 0.01, audioPitchSemitones: -3 })
    const exported = extractAudioSegments({ ...muted.project.timeline, fps: 30, tracks } as never, 30)
    expect(exported.filter((segment) => !segment.muted)).toEqual([])
    expect(resolveAudioMeterSources({ tracks, transitions: [], frame: 0, fps: 30, compositionsById: {} })).toEqual([])
    expect(resolveCompiledAudioMeterSources({ graph: compileAudioMeterGraph({ tracks, transitions: [], fps: 30 }), frame: 0 })).toEqual([])
    expect(selectTimelineSkimSourceAtFrame(0, tracks.flatMap((track) => track.items), tracks, 30, () => 8)).toBeNull()
    expect((await applied(JSON.parse(JSON.stringify(muted.project)), [])).digest).toBe(muted.digest)
    const reset = await applied(muted.project, [envelope('clip.update', { clipId: audio.id, patch: { muted: false } })])
    expect(itemsOf(reset.project)).toEqual(itemsOf(before.project).map((item) => item.id === audio.id ? { ...item, muted: false } : item))
    expect((await applied(JSON.parse(JSON.stringify(reset.project)), [])).digest).toBe(reset.digest)
    // Owning-video suppression is independent of this new clip mute/reset control.
    const separated = structuredClone(before.project)
    Object.assign(itemsOf(separated).find((item) => item.id === video.id)!, { embeddedAudioMuted: true })
    const videoReset = await applied(separated, [envelope('clip.setAudio', { clipId: video.id, muted: false })])
    expect(itemsOf(videoReset.project).find((item) => item.id === video.id)).toMatchObject({ embeddedAudioMuted: true, muted: false })
    const standalone = { ...video, src: 'blob:standalone-video', linkedGroupId: undefined, embeddedAudioMuted: false, muted: true }
    const videoPreview = collectVisualTrackItems({ tracks: [{ ...tracks[0]!, items: [standalone] }], visibleTrackIds, maxOrder: 1 })
    expect(videoPreview[0]).toMatchObject({ muted: true })
    expect(buildTransitionVideoAudioSegments(videoPreview as never, [], 30)[0]).toMatchObject({ muted: true })
    expect(extractAudioSegments({ tracks: [{ ...tracks[0]!, items: [standalone] }], fps: 30 } as never, 30)[0]).toMatchObject({ muted: true })
    expect(collectDuckingSources({ tracks: [{ ...tracks[1]!, items: [{ ...audio, muted: true, audioDucking: { duckOthersDb: -6 } }] }] } as never, 30)).toEqual([])
    for (const fields of [{ muted: 'yes' }, { muted: null }]) {
      await expect(applyCanonicalCommands(before.project, [envelope('clip.setAudio', { clipId: audio.id, ...fields })], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    const snapshot = structuredClone(before.project)
    await expect(applyCanonicalCommands(before.project, [envelope('clip.setAudio', { clipId: audio.id, muted: true }), envelope('clip.setAudio', { clipId: video.id, muted: false, volume: 13 })], media)).resolves.toMatchObject({ status: 'rejected', reason: 'invalid', index: 1 })
    expect(before.project).toEqual(snapshot)
  })

  it('preserves clip mute through compound audio export and nested leaf ownership', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    const composed = await applied(start.project, [envelope('composition.add', { name: 'Nested sound', clipIds: [video.id] })])
    const wrapper = itemsOf(composed.project).find((item) => item.type === 'audio' && 'compositionId' in item)!
    expect(wrapper).toBeDefined()
    const muted = await applied(composed.project, [envelope('clip.setAudio', { clipId: wrapper.id, muted: true })])
    const resolvedTracks = (graph: Project) => graph.timeline!.tracks.map((track) => ({ ...track, items: itemsOf(graph).filter((item) => item.trackId === track.id).map((item) => ({ ...item, src: 'blob:compound-source' })) }))
    expect(extractAudioSegments({ tracks: resolvedTracks(muted.project), fps: 30 } as never, 30).filter((segment) => !segment.muted)).toEqual([])
    const reset = await applied(muted.project, [envelope('clip.setAudio', { clipId: wrapper.id, muted: false })])
    const nested = structuredClone(reset.project)
    for (const item of nested.timeline!.compositions![0]!.items) {
      if (item.type === 'audio') Object.assign(item, { muted: true, src: 'blob:nested-source', audioDucking: { duckOthersDb: -6 } })
    }
    const loaded = await applied(nested, [])
    const output = extractAudioSegments({ tracks: resolvedTracks(loaded.project), fps: 30 } as never, 30)
    expect(output.length).toBeGreaterThan(0)
    expect(output.every((segment) => segment.muted)).toBe(true)
    expect(collectDuckingSources({ tracks: resolvedTracks(loaded.project), fps: 30 } as never, 30)).toEqual([])
  })

  it('keeps compound audio ownership during muted-wrapper skim and root/nested ducking, then restores sound on reset', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    const composed = await applied(start.project, [envelope('composition.add', { name: 'Owned sound', clipIds: [video.id] })])
    const flagged = structuredClone(composed.project)
    const child = flagged.timeline!.compositions![0]!.items.find((item) => item.type === 'audio')!
    Object.assign(child, { audioDucking: { duckOthersDb: -6 } })
    const wrapper = itemsOf(flagged).find((item) => item.type === 'audio' && 'compositionId' in item)!
    const visual = itemsOf(flagged).find((item) => item.type === 'composition')!
    const muted = await applied(flagged, [envelope('clip.setAudio', { clipId: wrapper.id, muted: true })])
    const reset = await applied(muted.project, [envelope('clip.setAudio', { clipId: wrapper.id, muted: false })])
    expect(itemsOf(muted.project).find((item) => item.id === visual.id)).toEqual(itemsOf(flagged).find((item) => item.id === visual.id))
    for (const nested of [false, true]) {
      for (const [graph, audible] of [[muted.project, false], [reset.project, true]] as const) {
        const loaded = await applied(graph, nested ? [envelope('composition.add', { name: 'Outer sound', clipIds: [visual.id] })] : [])
        const tracks = loaded.project.timeline!.tracks.map((track) => ({ ...track, items: itemsOf(loaded.project).filter((item) => item.trackId === track.id) }))
        blobUrlManager.registerUrl(ASSET, 'blob:owned-compound-source')
        try {
          const skim = selectTimelineSkimSourceAtFrame(30, itemsOf(loaded.project), tracks, 30, () => 8, (id) => useCompositionsStore.getState().getComposition(id))
          const ducking = collectDuckingSources({ tracks, fps: 30 } as never, 30)
          const output = extractAudioSegments({ tracks, fps: 30 } as never, 30)
          if (audible) {
            expect(skim?.item.id).toBe(child.id)
            expect(ducking.map((source) => source.itemId)).toEqual([child.id])
            expect(output.filter((segment) => !segment.muted).map((segment) => segment.itemId)).toEqual([child.id])
          } else {
            expect(skim).toBeNull()
            expect(ducking).toEqual([])
            expect(output.length).toBeGreaterThan(0)
            expect(output.every((segment) => segment.muted)).toBe(true)
          }
        } finally {
          blobUrlManager.release(ASSET)
        }
      }
    }
  })

  it('keeps inside-out track pan stages through compound ownership, reopen and root pan reset', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    const composed = await applied(start.project, [envelope('composition.add', { name: 'Panned sound', clipIds: [video.id] })])
    const graph = structuredClone(composed.project)
    const composition = graph.timeline!.compositions![0]!
    const leaf = composition.items.find((item) => item.type === 'audio')!
    composition.tracks.find((track) => track.id === leaf.trackId)!.pan = -0.5
    const wrapper = itemsOf(graph).find((item) => item.type === 'audio' && 'compositionId' in item)!
    const changed = await applied(graph, [envelope('track.setAudio', { trackId: wrapper.trackId, pan: 1 })])
    for (const [candidate, expected] of [[changed.project, [-0.5, 1]], [(await applied(changed.project, [envelope('track.setAudio', { trackId: wrapper.trackId, pan: 0 })])).project, [-0.5]]] as const) {
      const reopened = await applied(JSON.parse(JSON.stringify(candidate)), [])
      const timeline = reopened.project.timeline!
      const tracks = timeline.tracks.map((track) => ({ ...track, items: itemsOf(reopened.project).filter((item) => item.trackId === track.id) }))
      blobUrlManager.registerUrl(ASSET, 'blob:pan-compound')
      try {
        const exported = extractAudioSegments({ tracks, fps: 30 } as never, 30)
        expect(exported).toHaveLength(1)
        expect(exported[0]!.panStages).toEqual(expected)
        expect(resolveTrackAudioPanStages(itemsOf(reopened.project), tracks, timeline.compositions!, leaf.id, [wrapper.id])).toEqual(expected)
      } finally { blobUrlManager.release(ASSET) }
      expect(canonicalJson(timeline.compositions)).toBe(canonicalJson(changed.project.timeline!.compositions))
    }
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

  it('answers music from the rights-blocked catalogue and applies the persisted clip mute', async () => {
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
    ).resolves.toMatchObject({ status: 'applied' })
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

it('adopts a bounded sorted master envelope atomically and preserves/clears it without rewriting clip keyframes', async () => {
  const before=project({masterBusDb:-3,masterGainEnvelope:[{id:'old',frame:0,gainDb:-6}]})
  const next=await applied(before,[envelope('project.setMasterAudio',{gainDb:0,muted:false,gainEnvelope:[{id:'end',at:seconds(1),gainDb:0},{id:'start',at:seconds(0),gainDb:-20}]})])
  expect(next.project.timeline?.masterGainEnvelope).toEqual([{id:'start',frame:0,gainDb:-20},{id:'end',frame:30,gainDb:0}])
  const preserve=await applied(next.project,[envelope('project.setMasterAudio',{muted:true})])
  expect(preserve.project.timeline?.masterGainEnvelope).toEqual(next.project.timeline?.masterGainEnvelope)
  const rejected=await applyCanonicalCommands(next.project,[envelope('project.setMasterAudio',{gainDb:12,gainEnvelope:[{id:'x',at:seconds(0),gainDb:0},{id:'y',at:seconds(0),gainDb:-3}]})],media)
  expect(rejected.status).toBe('rejected')
  expect(next.project.timeline?.masterBusDb).toBe(0)
  const clear=await applied(next.project,[envelope('project.setMasterAudio',{gainEnvelope:[]})])
  expect(clear.project.timeline?.masterGainEnvelope).toBeUndefined()
})


it('records one combined master action, restores undo/redo, and rolls back rejected batches without publication', async () => {
  useTimelineCommandStore.getState().clearHistory()
  const before = project({ masterBusDb: -3, masterBusMuted: false, masterGainEnvelope: [{ id: 'old', frame: 0, gainDb: -6 }] })
  const result = await applied(before, [envelope('project.setMasterAudio', { gainDb: 2, muted: true, gainEnvelope: [{ id: 'new', at: seconds(1), gainDb: -12 }] })])
  expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
  useTimelineCommandStore.getState().undo()
  expect(usePlaybackStore.getState()).toMatchObject({ masterBusDb: -3, masterBusMuted: false, masterGainEnvelope: [{ id: 'old', frame: 0, gainDb: -6 }] })
  useTimelineCommandStore.getState().redo()
  expect(usePlaybackStore.getState()).toMatchObject({ masterBusDb: 2, masterBusMuted: true, masterGainEnvelope: [{ id: 'new', frame: 30, gainDb: -12 }] })
  const history = useTimelineCommandStore.getState().undoStack
  const rejected = await applyCanonicalCommands(result.project, [envelope('project.setMasterAudio', { gainDb: 12, gainEnvelope: [] }), envelope('project.setMasterAudio', { gainEnvelope: [{ id: 'x', at: seconds(0), gainDb: 0 }, { id: 'y', at: seconds(0), gainDb: -6 }] })], media)
  expect(rejected).toMatchObject({ status: 'rejected', index: 1, reason: 'invalid' })
  expect(usePlaybackStore.getState()).toMatchObject({ masterBusDb: 2, masterBusMuted: true, masterGainEnvelope: [{ id: 'new', frame: 30, gainDb: -12 }] })
  expect(useTimelineCommandStore.getState().undoStack).toEqual(history)
  const malformed = structuredClone(result.project)
  malformed.timeline!.masterGainEnvelope![0]!.gainDb = Number.NaN
  expect(await applyCanonicalCommands(malformed, [], media)).toMatchObject({ status: 'rejected', reason: 'invalid' })
  expect(usePlaybackStore.getState().masterGainEnvelope).toEqual([{ id: 'new', frame: 30, gainDb: -12 }])
})

it('refuses a keep-time retime that collapses envelope points without changing the graph or master state', async () => {
  const before = project({ masterBusDb: -3, masterGainEnvelope: [{ id: 'a', frame: 1, gainDb: -20 }, { id: 'b', frame: 2, gainDb: 0 }] })
  before.metadata.fps = 240
  before.metadata.frameRate = { num: 240, den: 1 }
  const original = structuredClone(before)
  const rejected = await applyCanonicalCommands(before, [envelope('sequence.setSettings', { sequenceId: 'main', fps: { num: 24, den: 1 }, timing: 'keep-time' })], media)
  expect(rejected).toMatchObject({ status: 'rejected', reason: 'invalid', detail: 'Master envelope cannot be retimed exactly' })
  expect(before).toEqual(original)
  expect(usePlaybackStore.getState()).toMatchObject({ masterBusDb: -3, masterGainEnvelope: [{ id: 'a', frame: 1, gainDb: -20 }, { id: 'b', frame: 2, gainDb: 0 }] })
})


it('FL103 probe: accepts track automation independently from clip and master gain', async () => {
  const before = project({ masterBusDb: -3, masterGainEnvelope: [{ id: 'master', frame: 0, gainDb: -6 }] })
  const outcome = await applyCanonicalCommands(before, [envelope('track.setAudio', {
    trackId: 'a1', gainDb: -2,
    gainEnvelope: [{ id: 'start', at: seconds(0), gainDb: -20 }, { id: 'end', at: seconds(1), gainDb: 0 }],
  })], media)
  expect(outcome).toMatchObject({ status: 'applied' })
})

it('FL103 track curve admission, clearing, atomic refusal and rational empty-track retime',async()=>{
 const original=(await applied(project({masterBusDb:-6}),[])).project
 const curve=[{id:'z',at:seconds(1),gainDb:0},{id:'a',at:seconds(0),gainDb:-20}]
 const first=await applied(original,[envelope('track.setAudio',{trackId:'a1',gainDb:-2,gainEnvelope:curve})])
 const track=()=>first.project.timeline!.tracks.find(t=>t.id==='a1') as unknown as {gainEnvelope:unknown;volume:number}
 expect(track()).toMatchObject({volume:-2,gainEnvelope:[{id:'a',frame:0,gainDb:-20},{id:'z',frame:30,gainDb:0}]})
 expect(first.project.timeline!.tracks[0]).toEqual(original.timeline!.tracks[0]);expect(first.project.timeline!.masterBusDb).toBe(-6)
 const omitted=await applied(first.project,[envelope('track.setAudio',{trackId:'a1',gainDb:-4})]);expect((omitted.project.timeline!.tracks[1] as never as {gainEnvelope:unknown}).gainEnvelope).toEqual(track().gainEnvelope)
 const cleared=await applied(first.project,[envelope('track.setAudio',{trackId:'a1',gainEnvelope:[]})]);expect((cleared.project.timeline!.tracks[1] as never as {gainEnvelope:unknown}).gainEnvelope).toEqual([])
 for(const bad of [[{id:'same',at:seconds(0),gainDb:0},{id:'same',at:seconds(1),gainDb:0}],[{id:'x',at:seconds(0),gainDb:0},{id:'y',at:seconds(0),gainDb:0}],[{id:'x',at:{num:1,den:100},gainDb:0}],[{id:'x',at:seconds(0),gainDb:13}],[{id:'x',at:seconds(0),gainDb:0,easing:'linear'}]]){
  const before=canonicalJson(first.project);const result=await applyCanonicalCommands(first.project,[envelope('track.setAudio',{trackId:'a1',gainDb:-8}),envelope('track.setAudio',{trackId:'a1',gainEnvelope:bad})],media);expect(result.status).toBe('rejected');expect(canonicalJson(first.project)).toBe(before)
 }
 const locked=structuredClone(first.project);locked.timeline!.tracks[1]!.locked=true
 expect(await applyCanonicalCommands(locked,[envelope('track.setAudio',{trackId:'a1',gainEnvelope:curve})],media)).toMatchObject({status:'rejected',reason:'failed'})
 const retimed=await applied(first.project,[envelope('sequence.setSettings',{sequenceId:'main',fps:{num:24,den:1},timing:'keep-time'})]);expect((retimed.project.timeline!.tracks[1] as never as {gainEnvelope:{frame:number}[]}).gainEnvelope.map(p=>p.frame)).toEqual([0,24])
 const kept=await applied(first.project,[envelope('sequence.setSettings',{sequenceId:'main',fps:{num:24,den:1},timing:'keep-frames'})]);expect((kept.project.timeline!.tracks[1] as never as {gainEnvelope:unknown}).gainEnvelope).toEqual(track().gainEnvelope)
 expect(await applyCanonicalCommands(first.project,[envelope('sequence.setSettings',{sequenceId:'main',fps:{num:24,den:1}})],media)).toMatchObject({status:'rejected'})
})
