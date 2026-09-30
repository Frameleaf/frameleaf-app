import { describe, expect, it } from 'vite-plus/test'
import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import type { ItemKeyframes } from '@/types/keyframe'
import { resolveAnimatedTransform } from '@/features/keyframes/utils/animated-transform-resolver'
import { applyMotionModifiers } from '@/features/keyframes/utils/motion-modifier-eval'
import { evaluatePropertyExpression } from '@/features/keyframes/utils/property-expression'
import { resolveTransform, getSourceDimensions } from '@/runtime/composition-runtime/utils/transform-resolver'
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
