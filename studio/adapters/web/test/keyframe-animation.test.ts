import { describe, expect, it } from 'vite-plus/test'
import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import type { ItemKeyframes } from '@/types/keyframe'
import { resolveAnimatedTransform } from '@/features/keyframes/utils/animated-transform-resolver'
import { applyMotionModifiers } from '@/features/keyframes/utils/motion-modifier-eval'
import { evaluatePropertyExpression } from '@/features/keyframes/utils/property-expression'
import { resolveTransform, getSourceDimensions } from '@/runtime/composition-runtime/utils/transform-resolver'
import { applyCompositionControlOverrides } from '@/shared/utils/composition-controls'
import { applyCanonicalCommands, type CanonicalEnvelope } from '../src/canonical-commands'

/**
 * FL-100 through the canonical commands: expressions, procedural motion modifiers and their bake,
 * and the expression sandbox's qualification (escape, nontermination, size and determinism).
 */

const STILL = '0198a1c2-0000-7000-8000-000000000a01'
const media: MediaMetadata[] = [
  {
    id: STILL,
    storageType: 'workspace',
    fileName: 'still.jpg',
    fileSize: 1,
    mimeType: 'image/jpeg',
    duration: 0,
    width: 1920,
    height: 1080,
    fps: 0,
    codec: 'unknown',
    bitrate: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
]
const CANVAS = { width: 1920, height: 1080, fps: 30 }

const empty = (): Project =>
  ({
    id: 'fl-100',
    name: 'Keyframe animation',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: CANVAS,
    timeline: {
      tracks: [
        { id: 'v1', name: 'V1', kind: 'video', height: 80, locked: false, visible: true, muted: false, solo: false, order: 0 },
      ],
      items: [],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
    },
  }) as unknown as Project

let sequence = 0
const envelope = (id: string, payload: Record<string, unknown>): CanonicalEnvelope => ({
  id,
  payload,
  revision: 1,
  idempotencyKey: `fl100-${++sequence}`,
  issuedAt: 1_758_800_000_000,
})
const seconds = (num: number, den = 1) => ({ num, den })
const apply = (graph: unknown, envelopes: CanonicalEnvelope[]) => applyCanonicalCommands(graph, envelopes, media)
const applied = async (graph: unknown, envelopes: CanonicalEnvelope[]) => {
  const outcome = await apply(graph, envelopes)
  if (outcome.status !== 'applied') throw new Error(`${outcome.reason}: ${outcome.detail}`)
  return outcome.project
}
const itemOf = (graph: Project) => (graph.timeline?.items ?? [])[0] as unknown as TimelineItem
const keyframesOf = (graph: Project, itemId: string) =>
  (graph.timeline?.keyframes ?? []).find((entry) => entry.itemId === itemId) as ItemKeyframes | undefined

const withStill = () =>
  applied(empty(), [envelope('clip.add', { trackId: 'v1', assetId: STILL, at: seconds(0), duration: seconds(4) })])

/** The pose the renderer draws at `frame`: keyframes, then procedural modifiers. */
const pose = (graph: Project, frame: number) => {
  const item = itemOf(graph)
  const base = resolveTransform(item, CANVAS, getSourceDimensions(item))
  const animated = resolveAnimatedTransform(base, keyframesOf(graph, item.id), frame)
  return applyMotionModifiers(animated, item.motionModifiers, {
    frame,
    fps: CANVAS.fps,
    frameWidth: CANVAS.width,
    frameHeight: CANVAS.height,
  })
}

describe('expressions (FL-100)', () => {
  it('stores an expression on a property, and clears it with null', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const set = await applied(start, [
      envelope('property.setExpression', { clipId: clip.id, property: 'opacity', expression: 'clamp(0.5 + sin(time) * 0.25, 0, 1)' }),
      envelope('property.setExpression', { clipId: clip.id, property: 'position', expression: '[frame, 10]' }),
    ])
    expect(keyframesOf(set, clip.id)?.expressions).toEqual([
      { type: 'expression', targetProperty: 'opacity', source: 'clamp(0.5 + sin(time) * 0.25, 0, 1)', enabled: true },
      { type: 'expression', targetProperty: 'position', source: '[frame, 10]', enabled: true },
    ])
    const cleared = await applied(set, [envelope('property.setExpression', { clipId: clip.id, property: 'opacity', expression: null })])
    expect(keyframesOf(cleared, clip.id)?.expressions?.map((entry) => entry.targetProperty)).toEqual(['position'])
  })

  it('keeps a reference to another layer, which resolves at render', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const set = await applied(start, [
      envelope('property.setExpression', { clipId: clip.id, property: 'rotation', expression: 'prop("elsewhere", "rotation") / 2' }),
    ])
    expect(keyframesOf(set, clip.id)?.expressions?.[0]?.source).toBe('prop("elsewhere", "rotation") / 2')
  })

  it('refuses, by name, anything that is not an expression of the grammar: no way out of the sandbox', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    for (const expression of [
      'globalThis',
      'this',
      'constructor',
      'value.constructor',
      '__proto__',
      'fetch("https://example.com")',
      'import("data:text/javascript,1")',
      'eval("1")',
      'Function("return 1")()',
      '`${1}`',
      'x = 1',
      '1; 2',
      'while (1) {}',
      'prop("x", "constructor")',
      'prop(globalThis, "opacity")',
      '[1, 2]', // a vector on a scalar property
      '(((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((1)))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))',
      '1+'.repeat(300) + '1', // over the token budget
      '1'.repeat(2049), // over the size limit
      '',
    ]) {
      const outcome = await apply(start, [
        envelope('property.setExpression', { clipId: clip.id, property: 'opacity', expression }),
      ])
      expect(outcome, expression.slice(0, 40)).toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    for (const payload of [
      { clipId: clip.id, property: 'opacity', expression: 42 },
      { clipId: clip.id, property: 'not-a-property', expression: '1' },
      { clipId: 'missing', property: 'opacity', expression: '1' },
    ]) {
      await expect(apply(start, [envelope('property.setExpression', payload)])).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
    }
  })

  it('evaluates deterministically, with no clock, randomness or page state, in bounded work', () => {
    const context = {
      preValue: 0.5,
      globalFrame: 90,
      fps: 30,
      resolveProperty: () => 0.25,
    }
    const source = 'lerp(value, prop("a", "opacity"), abs(sin(time * 3)))'
    const first = evaluatePropertyExpression(source, context)
    const realNow = Date.now
    const realRandom = Math.random
    try {
      Date.now = () => 0
      Math.random = () => 0.999
      ;(globalThis as Record<string, unknown>).value = 99
      expect(evaluatePropertyExpression(source, context)).toEqual(first)
    } finally {
      Date.now = realNow
      Math.random = realRandom
      delete (globalThis as Record<string, unknown>).value
    }
    expect(first.error).toBeUndefined()

    // A reference cycle stops at the dependency budget and falls back to the keyframed value.
    let calls = 0
    const cyclic = {
      ...context,
      resolveProperty: (_id: string, _property: string, budget: { remaining: number; references: Map<string, unknown> }) => {
        calls += 1
        const inner = evaluatePropertyExpression('prop("self", "opacity") + 1', cyclic, budget as never)
        return inner.error ? null : inner.value
      },
    }
    const looped = evaluatePropertyExpression('prop("self", "opacity") + 1', cyclic as never)
    expect(looped.error).toBeTruthy()
    expect(looped.value).toBe(context.preValue)
    expect(calls).toBeLessThanOrEqual(64)
  })
})

describe('procedural motion (FL-100)', () => {
  const sway = { id: 'sway-1', type: 'sway', amplitude: 1, frequency: 0.5, phaseFrames: 0, seed: 1 }

  it('sets, replaces and removes a modifier on the property it drives', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const set = await applied(start, [envelope('property.setModifier', { clipId: clip.id, property: 'rotation', modifier: sway })])
    expect(itemOf(set).motionModifiers).toEqual([{ version: 2, enabled: true, ...sway }])
    const replaced = await applied(set, [
      envelope('property.setModifier', { clipId: clip.id, property: 'rotation', modifier: { ...sway, id: 'sway-2', amplitude: 2 } }),
    ])
    expect(itemOf(replaced).motionModifiers?.map((entry) => [entry.id, entry.amplitude])).toEqual([['sway-2', 2]])
    const removed = await applied(replaced, [envelope('property.setModifier', { clipId: clip.id, property: 'rotation', modifier: null })])
    expect(itemOf(removed).motionModifiers).toEqual([])

    for (const modifier of [
      { ...sway, type: 'wobble' },
      { ...sway, amplitude: 3 },
      { ...sway, frequency: 0 },
      { ...sway, frequency: Number.NaN },
      { ...sway, channelGains: { z: 1 } },
      'sway',
    ]) {
      await expect(
        apply(start, [envelope('property.setModifier', { clipId: clip.id, property: 'rotation', modifier })]),
      ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
    // A sway turns; it does not move the clip sideways.
    await expect(
      apply(start, [envelope('property.setModifier', { clipId: clip.id, property: 'x', modifier: sway })]),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
  })

  it('bakes procedural motion into keyframes that draw the same pose, and drops the modifier', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const moving = await applied(start, [
      envelope('keyframe.add', { clipId: clip.id, property: 'rotation', at: seconds(0), value: { value: 0 } }),
      envelope('keyframe.add', { clipId: clip.id, property: 'rotation', at: seconds(3), value: { value: 30 } }),
      envelope('property.setModifier', { clipId: clip.id, property: 'rotation', modifier: sway }),
    ])
    const baked = await applied(moving, [
      envelope('property.bakeModifier', { clipId: clip.id, property: 'rotation', modifierId: 'sway-1' }),
    ])
    expect(itemOf(baked).motionModifiers).toEqual([])
    const frames = (keyframesOf(baked, clip.id)?.properties.find((entry) => entry.property === 'rotation')?.keyframes ?? []).map(
      (keyframe) => keyframe.frame,
    )
    expect(frames.length).toBeGreaterThan(4)
    // At every baked keyframe the pose is the one the modifier drew.
    for (const frame of frames) {
      expect(pose(baked, frame).rotation).toBeCloseTo(pose(moving, frame).rotation, 6)
    }
    // Undoing the bake is a history step, not a lossy reverse: the source graph is untouched.
    expect(itemOf(moving).motionModifiers).toHaveLength(1)

    for (const payload of [
      { clipId: clip.id, property: 'rotation', modifierId: 'missing' },
      { clipId: clip.id, property: 'x', modifierId: 'sway-1' },
    ]) {
      await expect(apply(moving, [envelope('property.bakeModifier', payload)])).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
    }
  })
})

type Stored = Project & {
  timeline: NonNullable<Project['timeline']> & {
    compositions?: Array<{ id: string; editorKind?: string; items: TimelineItem[]; compositionControls?: unknown }>
  }
}
const withTitles = async () => {
  const start = await withStill()
  return applied(start, [
    envelope('title.add', { text: 'Headline', at: seconds(0), duration: seconds(2) }),
    envelope('title.add', { text: 'Caption', at: seconds(0), duration: seconds(2) }),
  ])
}
const titlesOf = (graph: Project) => (graph.timeline?.items ?? []).filter((item) => item.type === 'text') as TimelineItem[]

describe('motion text (FL-100)', () => {
  it('sets per-character, per-word and per-line motion, clears it, and names what it refuses', async () => {
    const start = await withTitles()
    const [title] = titlesOf(start)
    const motion = {
      in: { presetId: 'fade-up', durationFrames: 12, staggerFrames: 2, intensity: 1, unit: 'character' },
      loop: { presetId: 'wave', durationFrames: 30, staggerFrames: 3, intensity: 0.5, unit: 'word' },
    }
    const set = await applied(start, [envelope('text.setMotion', { clipId: title!.id, motion })])
    const stored = titlesOf(set)[0] as unknown as { textMotion: Record<string, { presetId: string; unit?: string }> }
    expect(stored.textMotion.in).toMatchObject({ presetId: 'fade-up', unit: 'character' })
    expect(stored.textMotion.loop).toMatchObject({ presetId: 'wave', unit: 'word' })
    const cleared = await applied(set, [envelope('text.setMotion', { clipId: title!.id, motion: null })])
    expect((titlesOf(cleared)[0] as unknown as { textMotion?: unknown }).textMotion).toBeUndefined()

    for (const bad of [
      { in: { presetId: 'wave', durationFrames: 12, staggerFrames: 2, intensity: 1 } }, // a loop preset in the in slot
      { sideways: { presetId: 'fade-up' } },
      {},
      'fade-up',
    ]) {
      await expect(apply(start, [envelope('text.setMotion', { clipId: title!.id, motion: bad })])).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
    }
    await expect(
      apply(start, [envelope('text.setMotion', { clipId: itemOf(start).id, motion })]),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
  })
})

describe('Compose groups, published controls and instance overrides (FL-100)', () => {
  it('groups into Compose, nests, publishes a control, overrides it per instance, and ungroups without flattening', async () => {
    const start = await withTitles()
    const [headline, caption] = titlesOf(start)
    const keyed = await applied(start, [
      envelope('keyframe.add', { clipId: headline!.id, property: 'opacity', at: seconds(5), value: { value: 0.5 } }),
    ])
    const grouped = (await applied(keyed, [
      envelope('clip.group', { clipIds: [headline!.id], name: 'Lower third' }),
    ])) as Stored
    const group = grouped.timeline.items.find((item) => item.type === 'composition')!
    const composition = grouped.timeline.compositions!.find(
      (entry) => entry.id === (group as unknown as { compositionId: string }).compositionId,
    )!
    expect(composition.editorKind).toBe('composite-2d')
    const inner = composition.items[0]!
    expect(inner).toMatchObject({ type: 'text', text: 'Headline' })

    // Nested: the group and the caption grouped again.
    const nested = (await applied(grouped, [
      envelope('clip.group', { clipIds: [group.id, caption!.id], name: 'Titles' }),
    ])) as Stored
    expect(nested.timeline.compositions!.filter((entry) => entry.editorKind === 'composite-2d')).toHaveLength(2)

    const published = (await applied(grouped, [
      envelope('composition.setPublishedControls', {
        compositionId: composition.id,
        controls: [
          { id: 'headline', name: 'Headline', targetItemId: inner.id, property: 'text.text' },
          { id: 'tint', name: 'Tint', targetItemId: inner.id, property: 'text.color' },
        ],
      }),
    ])) as Stored
    const schema = published.timeline.compositions!.find((entry) => entry.id === composition.id)!.compositionControls as {
      controls: Array<{ id: string; kind: string; defaultValue: string }>
    }
    expect(schema.controls.map((control) => [control.id, control.kind, control.defaultValue])).toEqual([
      ['headline', 'text', 'Headline'],
      ['tint', 'color', expect.any(String)],
    ])

    const overridden = (await applied(published, [
      envelope('composition.setControlOverrides', { compositionClipId: group.id, overrides: { headline: 'Chapter two', tint: '#ff8800' } }),
    ])) as Stored
    const instance = overridden.timeline.items.find((item) => item.id === group.id) as unknown as {
      compositionControlOverrides: Record<string, string>
    }
    expect(instance.compositionControlOverrides).toEqual({ headline: 'Chapter two', tint: '#ff8800' })
    // The renderer draws the instance with its override, and the shared composition is untouched.
    const source = overridden.timeline.compositions!.find((entry) => entry.id === composition.id)!
    const drawn = applyCompositionControlOverrides(source.items, source.compositionControls as never, instance.compositionControlOverrides)
    expect(drawn[0]).toMatchObject({ text: 'Chapter two', color: '#ff8800' })
    expect(source.items[0]).toMatchObject({ text: 'Headline' })

    for (const [id, payload] of [
      ['composition.setControlOverrides', { compositionClipId: group.id, overrides: { nope: 'x' } }],
      ['composition.setControlOverrides', { compositionClipId: group.id, overrides: { tint: 'not a colour' } }],
      ['composition.setControlOverrides', { compositionClipId: headline!.id, overrides: {} }],
      ['composition.setPublishedControls', { compositionId: composition.id, controls: [{ name: 'X', targetItemId: 'missing', property: 'text.text' }] }],
      ['composition.setPublishedControls', { compositionId: composition.id, controls: [{ name: 'X', targetItemId: inner.id, property: 'shape.fillColor' }] }],
      ['composition.setPublishedControls', { compositionId: composition.id, controls: [
        { name: 'A', targetItemId: inner.id, property: 'text.text' },
        { name: 'B', targetItemId: inner.id, property: 'text.text' },
      ] }],
      ['clip.ungroup', { groupId: headline!.id }],
    ] as const) {
      await expect(apply(published, [envelope(id, payload as never)])).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }

    // Ungrouping brings the clip back with its keyframes, not a flattened copy.
    const ungrouped = (await applied(grouped, [envelope('clip.ungroup', { groupId: group.id })])) as Stored
    const back = titlesOf(ungrouped).find((item) => (item as unknown as { text: string }).text === 'Headline')!
    expect(back).toBeDefined()
    expect(keyframesOf(ungrouped, back.id)?.properties[0]?.keyframes).toEqual([
      expect.objectContaining({ frame: 30, value: 0.5 }),
    ])
  })
})

describe('Ken Burns (FL-100)', () => {
  it.each(['position', 'scale'] as const)('refuses an existing vector %s animation without changing the graph', async (property) => {
    const start = await withStill()
    const clip = itemOf(start)
    const animated = await applied(start, [
      envelope('keyframe.add', { clipId: clip.id, property, at: seconds(0), value: { x: 100, y: 100 } }),
      envelope('keyframe.add', { clipId: clip.id, property, at: seconds(2), value: { x: 150, y: 120 } }),
    ])
    const before = JSON.stringify(animated)
    const outcome = await apply(animated, [
      envelope('clip.setKenBurns', {
        clipId: clip.id,
        kenBurns: { from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      }),
    ])
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid' })
    expect(JSON.stringify(animated)).toBe(before)
  })

  it('moves a still photo from one region to another, replaces the move, and removes it', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const move = { from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }
    const moved = await applied(start, [envelope('clip.setKenBurns', { clipId: clip.id, kenBurns: move })])
    const last = clip.durationInFrames - 1
    const base = resolveTransform(clip, CANVAS, getSourceDimensions(clip))
    // Start: the whole photo. End: the region fills the frame (1/0.8 the size, same centre).
    expect(pose(moved, 0)).toMatchObject({ x: base.x, y: base.y, width: base.width, height: base.height })
    const end = pose(moved, last)
    expect(end.width).toBeCloseTo(base.width / 0.8, 6)
    expect(end.height).toBeCloseTo(base.height / 0.8, 6)
    expect(end.x).toBeCloseTo(base.x, 6)
    expect(end.y).toBeCloseTo(base.y, 6)
    expect((itemOf(moved) as unknown as { frameleafKenBurns: unknown }).frameleafKenBurns).toMatchObject(move)

    // A pan: the region's centre moves right, so the photo moves left.
    const panned = await applied(moved, [
      envelope('clip.setKenBurns', { clipId: clip.id, kenBurns: { from: { x: 0, y: 0.05, w: 0.8, h: 0.8 }, to: { x: 0.2, y: 0.05, w: 0.8, h: 0.8 } } }),
    ])
    expect(pose(panned, last).x).toBeLessThan(pose(panned, 0).x)
    expect(keyframesOf(panned, clip.id)?.properties.find((entry) => entry.property === 'x')?.keyframes).toHaveLength(2)

    const still = await applied(panned, [envelope('clip.setKenBurns', { clipId: clip.id, kenBurns: null })])
    expect((keyframesOf(still, clip.id)?.properties ?? []).flatMap((entry) => entry.keyframes)).toEqual([])
    expect((itemOf(still) as unknown as { frameleafKenBurns?: unknown }).frameleafKenBurns).toBeUndefined()

    const animated = await applied(start, [
      envelope('keyframe.add', { clipId: clip.id, property: 'x', at: seconds(1), value: { value: 40 } }),
    ])
    for (const [graph, kenBurns] of [
      [animated, move], // would replace the clip's own animation
      [start, { from: move.from, to: { x: 0.5, y: 0.5, w: 0.8, h: 0.8 } }], // outside the photo
      [start, { from: move.from, to: { x: 0, y: 0, w: 0.1, h: 0.1 } }], // too small
      [start, { from: move.from, to: { x: 0, y: 0, w: 0.8, h: 0.6 } }], // not the frame's shape
      [start, 'push-in'],
    ] as const) {
      await expect(apply(graph, [envelope('clip.setKenBurns', { clipId: clip.id, kenBurns })])).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
    }
  })
})

describe('vector keyframes, velocity handles and path tangents (FL-100)', () => {
  const lane = (graph: Project, itemId: string, property: string) =>
    (keyframesOf(graph, itemId) as unknown as { vectorProperties?: Array<{ property: string; keyframes: Array<Record<string, unknown>> }> })
      ?.vectorProperties?.find((entry) => entry.property === property)?.keyframes ?? []

  it('keys position, sets mirrored tangents and velocity handles, clears them, and round-trips them as data', async () => {
    const start = await withStill()
    const clip = itemOf(start)
    const keyed = await applied(start, [
      envelope('keyframe.add', { clipId: clip.id, property: 'position', at: seconds(0), value: { x: 0, y: 0 } }),
      envelope('keyframe.add', { clipId: clip.id, property: 'position', at: seconds(2), value: { x: 200, y: -50 }, easing: 'ease-out' }),
    ])
    const [first, second] = lane(keyed, clip.id, 'position') as Array<{ id: string }>
    expect(lane(keyed, clip.id, 'position')).toEqual([
      expect.objectContaining({ frame: 0, value: { x: 0, y: 0 } }),
      expect.objectContaining({ frame: 60, value: { x: 200, y: -50 }, easing: 'ease-out' }),
    ])

    const shaped = await applied(keyed, [
      envelope('keyframe.update', {
        clipId: clip.id,
        property: 'position',
        keyframeId: first!.id,
        spatial: { outTangent: { x: 40, y: 10 }, continuous: true },
        temporalEase: { out: { speed: 120, influence: 33.3 } },
      }),
      envelope('keyframe.update', { clipId: clip.id, property: 'position', keyframeId: second!.id, at: seconds(3), value: { x: 180, y: -40 } }),
    ])
    expect(lane(shaped, clip.id, 'position')).toEqual([
      expect.objectContaining({
        id: first!.id,
        spatial: { inTangent: { x: -40, y: -10 }, outTangent: { x: 40, y: 10 }, continuous: true },
        temporalEase: { out: { speed: 120, influence: 33.3 } },
      }),
      expect.objectContaining({ id: second!.id, frame: 90, value: { x: 180, y: -40 } }),
    ])
    // The stored graph is data: parse it back and nothing about the handles is lost or flattened.
    expect(lane(JSON.parse(JSON.stringify(shaped)), clip.id, 'position')).toEqual(lane(shaped, clip.id, 'position'))

    const cleared = await applied(shaped, [
      envelope('keyframe.update', { clipId: clip.id, property: 'position', keyframeId: first!.id, spatial: null, temporalEase: null }),
      envelope('keyframe.setEasing', { clipId: clip.id, property: 'position', keyframeIds: [second!.id], easing: 'hold' }),
    ])
    const [plain, held] = lane(cleared, clip.id, 'position')
    expect(plain!.spatial).toBeUndefined()
    expect(plain!.temporalEase).toBeUndefined()
    expect(held).toMatchObject({ easing: 'hold' })

    const removed = await applied(cleared, [
      envelope('keyframe.remove', { clipId: clip.id, property: 'position', keyframeIds: [first!.id] }),
    ])
    expect(lane(removed, clip.id, 'position').map((keyframe) => keyframe.id)).toEqual([second!.id])

    for (const [id, payload] of [
      ['keyframe.add', { clipId: clip.id, property: 'position', at: seconds(1), value: { value: 3 } }],
      ['keyframe.update', { clipId: clip.id, property: 'position', keyframeId: first!.id, spatial: { outTangent: { x: 1, y: 1 }, inTangent: { x: 1, y: 1 }, continuous: true } }],
      ['keyframe.update', { clipId: clip.id, property: 'position', keyframeId: first!.id, spatial: { outTangent: { x: 1, y: 1 } } }],
      ['keyframe.update', { clipId: clip.id, property: 'position', keyframeId: first!.id, temporalEase: { out: { speed: 1, influence: 0 } } }],
      ['keyframe.update', { clipId: clip.id, property: 'position', keyframeId: first!.id, at: seconds(3) }],
      ['keyframe.update', { clipId: clip.id, property: 'scale', keyframeId: first!.id, value: { x: 1, y: 1 } }],
      ['keyframe.update', { clipId: clip.id, property: 'opacity', keyframeId: first!.id, temporalEase: { out: { speed: 1, influence: 50 } } }],
    ] as const) {
      await expect(apply(shaped, [envelope(id, payload as never)])).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    }
  })
})
