import { describe, expect, it } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import {
  applyCanonicalCommands,
  canonicalJson,
  deterministicUuids,
  ENGINE_COMMANDS,
  secondsToFrames,
  type CanonicalEnvelope,
} from '../src/canonical-commands'
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
        { id: 'v1', name: 'V1', kind: 'video', height: 80, locked: false, visible: true, muted: false, solo: false, order: 0 },
        { id: 'a1', name: 'A1', kind: 'audio', height: 60, locked: false, visible: true, muted: false, solo: false, order: 1 },
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
const envelope = (id: string, payload: Record<string, unknown>, key = `key-${++sequence}`): CanonicalEnvelope => ({
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
  it('covers every Freecut public command row', () => {
    const publicRows = (manifest as { features: Array<{ id: string }> }).features
      .map((feature) => feature.id)
      .filter((id) => id.startsWith('command.'))
    const covered = new Set(Object.values(ENGINE_COMMANDS).flat())
    expect(publicRows.length).toBe(19)
    expect(publicRows.filter((row) => !covered.has(row))).toEqual([])
    // And every engine command is a catalogue command that changes the graph and can be undone.
    const rows = new Map((catalogue as { commands: Array<{ id: string; mutatesGraph: boolean; undoable: boolean }> }).commands.map((row) => [row.id, row]))
    for (const id of Object.keys(ENGINE_COMMANDS)) {
      expect(rows.get(id)).toMatchObject({ mutatesGraph: true, undoable: true })
    }
  })

  it('converts exact rational seconds to frames without float drift', () => {
    expect(secondsToFrames(seconds(25, 2), 30)).toBe(375)
    expect(secondsToFrames(seconds(1001, 30_000), 29.97)).toBe(1)
    expect(secondsToFrames(seconds(1, 60), 30)).toBe(1) // exactly half a frame rounds up
    expect(secondsToFrames(seconds(0), 24)).toBe(0)
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

    const split = await applied(added.project, [envelope('clip.split', { at: seconds(2), clipIds: [video.id] })])
    const videos = itemsOf(split.project)
      .filter((item) => item.type === 'video')
      .sort((a, b) => a.from - b.from)
    expect(videos.map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 60],
      [60, 180],
    ])
  })

  it('is deterministic: the same graph and batch give the same graph and digest', async () => {
    const batch = [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(3) }, 'fixed-a'),
      envelope('title.add', { at: seconds(1), text: 'Big wave', style: 'Bold', position: 'bc', animation: 'Rise' }, 'fixed-b'),
    ]
    const first = await applied(project(), batch)
    const second = await applied(project(), batch)
    expect(second.digest).toBe(first.digest)
    expect(canonicalJson(second.project)).toBe(canonicalJson(first.project))
    const title = itemsOf(first.project).find((item) => item.type === 'text') as unknown as Record<string, unknown>
    expect(title).toMatchObject({ text: 'Big wave', fontWeight: 'bold', verticalAlign: 'bottom', textAlign: 'center' })
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
      applyCanonicalCommands(project(), [envelope('clip.add', { trackId: 'v1', assetId: 'other', at: seconds(0) })], media),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    await expect(
      applyCanonicalCommands(project(), [envelope('clip.add', { trackId: 'v1', assetId: STILL, at: 1.5 })], media),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
  })

  it('moves, trims, adds a transition and removes clips with the engine actions', async () => {
    const start = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) }, 's1'),
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(4), duration: seconds(4) }, 's2'),
    ])
    const [left, right] = itemsOf(start.project).sort((a, b) => a.from - b.from)

    const trimmed = await applied(start.project, [envelope('clip.trimEnd', { clipId: right!.id, end: seconds(7) })])
    expect(itemsOf(trimmed.project).find((item) => item.id === right!.id)?.durationInFrames).toBe(90)

    const withTransition = await applied(trimmed.project, [
      envelope('clip.setTransition', { clipId: left!.id, transition: { type: 'Cross dissolve', duration: seconds(1, 2) } }),
    ])
    expect(withTransition.project.timeline?.transitions).toEqual([
      expect.objectContaining({ leftClipId: left!.id, rightClipId: right!.id, durationInFrames: 15, presentation: 'dissolve' }),
    ])

    const cleared = await applied(withTransition.project, [envelope('clip.setTransition', { clipId: left!.id, transition: null })])
    expect(cleared.project.timeline?.transitions ?? []).toEqual([])

    const moved = await applied(cleared.project, [envelope('clip.move', { clipId: right!.id, start: seconds(10) })])
    expect(itemsOf(moved.project).find((item) => item.id === right!.id)?.from).toBe(300)

    const removed = await applied(moved.project, [envelope('clip.delete', { clipId: left!.id })])
    expect(itemsOf(removed.project).map((item) => item.id)).toEqual([right!.id])
  })

  it('adds and removes effects and keyframes, sets transforms and tracks', async () => {
    const start = await applied(project(), [
      envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) }, 'e1'),
    ])
    const [still] = itemsOf(start.project)
    const effected = await applied(start.project, [
      envelope('effect.add', { clipId: still!.id, effect: 'gpu-sepia', params: { amount: 0.5 } }),
      envelope('clip.setTransform', { clipId: still!.id, transform: { x: 10, opacity: 0.5, scale: 0.5 } }),
      envelope('keyframe.add', { clipId: still!.id, property: 'opacity', at: seconds(1), value: { value: 0.25 } }),
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
      envelope('keyframe.remove', { clipId: still!.id, property: 'opacity', keyframeIds: [keyframes[0]!.id] }),
    ])
    expect((itemsOf(cleaned.project)[0] as unknown as { effects?: unknown[] }).effects ?? []).toEqual([])
  })

  it('answers music from the rights-blocked catalogue and clip mute honestly', async () => {
    await expect(
      applyCanonicalCommands(project(), [envelope('music.add', { musicId: 'ambient-1', at: seconds(0) })], media),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }, 'm1')])
    const video = itemsOf(start.project).find((item) => item.type === 'video')!
    await expect(
      applyCanonicalCommands(start.project, [envelope('clip.update', { clipId: video.id, patch: { muted: true } })], media),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'not-implemented' })
  })

  it('refuses a graph that is not a Freecut project', async () => {
    await expect(applyCanonicalCommands(null, [envelope('track.add', { kind: 'video' })], media)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid',
    })
  })
})
