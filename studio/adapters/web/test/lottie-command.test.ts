import { describe, expect, it } from 'vite-plus/test'
import type { Project } from '@/types/project'
import type { LottieItem, TimelineItem } from '@/types/timeline'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { applyLottieColorOverrides } from '@/infrastructure/lottie/lottie-color'
import { applyLottieTextOverrides } from '@/infrastructure/lottie/lottie-text'
import {
  applyCanonicalCommands,
  canonicalJson,
  type CanonicalEnvelope,
} from '../src/canonical-commands'

const item = (): LottieItem =>
  ({
    id: 'template',
    type: 'lottie',
    trackId: 'v1',
    from: 30,
    durationInFrames: 90,
    label: 'Template',
    src: '',
    width: 320,
    height: 180,
    lottieFps: 30,
    lottieDuration: 3,
    themeId: 'existing-theme',
    animationId: 'existing-animation',
    colorOverrides: { c1: '#123456' },
    textOverrides: { '1': 'Before' },
    slotOverrides: { original: 1 },
  }) as LottieItem
const seed = (): Project =>
  ({
    id: 'lottie-project',
    name: 'Lottie',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 320, height: 180, fps: 30 },
    timeline: {
      tracks: [
        {
          id: 'v1',
          name: 'Video',
          kind: 'video',
          height: 80,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
        },
      ],
      items: [item()],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
    },
  }) as Project
const command = (payload: Record<string, unknown>): CanonicalEnvelope => ({
  id: 'lottie.update',
  payload: { clipId: 'template', ...payload },
  revision: 4,
  idempotencyKey: 'lottie-key',
  issuedAt: 1000,
})
const apply = async (graph: Project, envelopes: CanonicalEnvelope[]) => {
  const result = await applyCanonicalCommands(graph, envelopes, [])
  if (result.status !== 'applied') throw new Error(`${result.reason}: ${result.detail}`)
  return result
}

describe('canonical Lottie overrides (FL-105)', () => {
  it('replaces maps in one edit and preserves omission, timing, theme, reopen and replay', async () => {
    const start = (await apply(seed(), [])).project
    const maps = {
      colors: { c0: '#FF8000' },
      text: { '0': 'Hello', 's:title': '' },
      slots: { opacity: 25, position: [10, -20] },
    }
    const historyDepth = useTimelineCommandStore.getState().undoStack.length
    const changed = await apply(start, [command(maps)])
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(historyDepth + 1)
    const edited = changed.project.timeline!.items[0] as LottieItem
    expect(edited).toMatchObject({
      colorOverrides: maps.colors,
      textOverrides: maps.text,
      slotOverrides: maps.slots,
      themeId: 'existing-theme',
      animationId: 'existing-animation',
      from: 30,
      durationInFrames: 90,
    })
    expect(start.timeline!.items[0]).toEqual(item())
    expect((await apply(JSON.parse(JSON.stringify(changed.project)), [])).project).toEqual(
      changed.project,
    )
    expect((await apply(changed.project, [command(maps)])).digest).toBe(changed.digest)
    const partial = await apply(changed.project, [command({ text: { '0': 'Next' } })])
    expect(partial.project.timeline!.items[0]).toMatchObject({
      colorOverrides: maps.colors,
      slotOverrides: maps.slots,
      textOverrides: { '0': 'Next' },
    })
    const cleared = await apply(partial.project, [command({ colors: {}, text: {}, slots: {} })])
    for (const key of ['colorOverrides', 'textOverrides', 'slotOverrides'])
      expect(
        (cleared.project.timeline!.items[0] as unknown as Record<string, unknown>)[key],
      ).toBeUndefined()
    expect((await apply(JSON.parse(JSON.stringify(cleared.project)), [])).digest).toBe(
      cleared.digest,
    )
    // Real pre-render JSON helpers; actual pixels/native value-slot rendering remain separate gates.
    const textAnimation = { layers: [{ ty: 5, t: { d: { k: [{ s: { t: 'Authored' } }] } } }] }
    const colorAnimation = {
      layers: [{ ty: 4, shapes: [{ ty: 'fl', c: { a: 0, k: [0, 0, 0, 1] } }] }],
    }
    applyLottieTextOverrides(textAnimation, edited.textOverrides!)
    applyLottieColorOverrides(colorAnimation, edited.colorOverrides!)
    expect(textAnimation.layers[0]!.t.d.k[0]!.s.t).toBe('Hello')
    expect(colorAnimation.layers[0]!.shapes[0]!.c.k).toEqual([1, 128 / 255, 0, 1])
  })

  it('refuses malformed and wrong-target maps atomically including after an earlier valid edit', async () => {
    const start = (await apply(seed(), [])).project
    const before = canonicalJson(start)
    const history = useTimelineCommandStore.getState().undoStack
    const invalidMaps = [
      {},
      { colors: [] },
      { colors: null },
      { colors: { c0: '#12345' } },
      { colors: { c0: 2 } },
      { text: 'hello' },
      { text: { '0': 2 } },
      { text: { '': 'bad' } },
      { slots: null },
      { slots: { x: NaN } },
      { slots: { x: Infinity } },
      { slots: { x: [1, Infinity] } },
      { slots: { x: [1] } },
      { slots: { x: new Array(2) } },
      { slots: { x: [1, 2, 3] } },
      { slots: { x: { x: 1, y: 2 } } },
      { colors: { c0: '#ff0000' }, text: { '0': false } },
      { themeId: 'new' },
    ]
    for (const maps of invalidMaps) {
      await expect(applyCanonicalCommands(start, [command(maps)], [])).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid',
      })
      expect(canonicalJson(start)).toBe(before)
      expect(useItemsStore.getState().items).toEqual(start.timeline!.items)
      expect(useTimelineCommandStore.getState().undoStack).toEqual(history)
    }
    await expect(
      applyCanonicalCommands(start, [command({ clipId: 'missing', text: {} })], []),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid' })
    const wrong = structuredClone(start)
    wrong.timeline!.items[0] = { ...item(), type: 'image' } as TimelineItem
    await expect(applyCanonicalCommands(wrong, [command({ text: {} })], [])).resolves.toMatchObject(
      { status: 'rejected', reason: 'invalid' },
    )
    const locked = structuredClone(start)
    locked.timeline!.tracks[0]!.locked = true
    await expect(
      applyCanonicalCommands(locked, [command({ slots: { x: 3 } })], []),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'failed' })
    await expect(
      applyCanonicalCommands(
        start,
        [command({ text: { '0': 'temporary' } }), command({ slots: { x: Infinity } })],
        [],
      ),
    ).resolves.toMatchObject({ status: 'rejected', index: 1, reason: 'invalid' })
    expect(useItemsStore.getState().items).toEqual(start.timeline!.items)
    expect(useTimelineCommandStore.getState().undoStack).toEqual(history)
  })
})
